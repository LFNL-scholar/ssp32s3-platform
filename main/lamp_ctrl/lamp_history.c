#include "lamp_history.h"

#include <dirent.h>
#include <errno.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "esp_crc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

#define HISTORY_BASE_PATH "/data"
#define DAY      86400LL
#define OFFSET   28800LL
#define MAGIC    0x48535432U
#define MIN_TIME 1700000000LL
#define MAX_TIME 4102444800LL

typedef struct {
    uint32_t magic;
    uint8_t cause, on;
    uint16_t reserved;
    int64_t start, end;
    uint32_t crc, reserved2;
} record_t;
_Static_assert(sizeof(record_t) == 32, "history disk format");

static SemaphoreHandle_t lock;
static record_t active;
static bool ready;
static atomic_bool synced;
static esp_err_t last_error;
static int64_t last_wall, last_mono, saved_mono, pruned_day = -1;

static bool valid_time(int64_t t) { return t >= MIN_TIME && t < MAX_TIME; }
static int64_t day_of(int64_t t) { return (t + OFFSET) / DAY; }

static void seal(record_t *r)
{
    r->crc = esp_crc32_le(0, (const uint8_t *)r, offsetof(record_t, crc));
}

static bool valid_record(const record_t *r)
{
    return r->magic == MAGIC && r->on <= 1 && r->cause <= LAMP_HIST_AUTO &&
        valid_time(r->start) && r->end >= r->start &&
        r->end <= (day_of(r->start) + 1) * DAY - OFFSET &&
        r->crc == esp_crc32_le(0, (const uint8_t *)r, offsetof(record_t, crc));
}

static void fail(esp_err_t err) { last_error = err; ready = false; }

static esp_err_t checkpoint(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("lamp_history", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    seal(&active);
    err = nvs_set_blob(h, "active_v2", &active, sizeof(active));
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

static esp_err_t append(const record_t *value)
{
    record_t r = *value;
    seal(&r);
    char path[96];
    snprintf(path, sizeof(path), HISTORY_BASE_PATH "/h%lld.bin", (long long)day_of(r.start));
    FILE *file = fopen(path, "r+b");
    if (!file && errno == ENOENT) file = fopen(path, "w+b");
    if (!file) return ESP_FAIL;

    record_t existing;
    long good = 0;
    size_t got;
    while ((got = fread(&existing, 1, sizeof(existing), file)) == sizeof(existing)) {
        if (!valid_record(&existing)) { fclose(file); return ESP_ERR_INVALID_CRC; }
        if (!memcmp(&existing, &r, sizeof(r))) { fclose(file); return ESP_OK; }
        good += sizeof(existing);
    }
    bool ok = !ferror(file);
    if (ok && got) ok = ftruncate(fileno(file), good) == 0;
    if (ok) ok = fseek(file, good, SEEK_SET) == 0 && fwrite(&r, sizeof(r), 1, file) == 1;
    if (ok) ok = fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file)) ok = false;
    return ok ? ESP_OK : ESP_FAIL;
}

static int64_t oldest(int64_t now)
{
    time_t shifted = now + OFFSET;
    struct tm t;
    gmtime_r(&shifted, &t);
    t.tm_year--;
    int year = t.tm_year + 1900;
    if (t.tm_mon == 1 && t.tm_mday == 29 &&
        (year % 4 || (!(year % 100) && year % 400))) t.tm_mday = 28;
    t.tm_hour = t.tm_min = t.tm_sec = 0;
    int64_t days = 0;
    for (int y = 1970; y < year; ++y) days += 365 + (!(y % 4) && (y % 100 || !(y % 400)));
    const int months[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    for (int m = 0; m < t.tm_mon; ++m) days += months[m] + (m == 1 && !(year % 4) && (year % 100 || !(year % 400)));
    return (days + t.tm_mday - 1) * DAY - OFFSET;
}

static esp_err_t prune(int64_t now)
{
    if (pruned_day == day_of(now)) return ESP_OK;
    DIR *dir = opendir(HISTORY_BASE_PATH);
    if (!dir) return ESP_FAIL;
    struct dirent *entry;
    esp_err_t err = ESP_OK;
    while ((entry = readdir(dir))) {
        long long day; char extra;
        if (sscanf(entry->d_name, "h%lld.bin%c", &day, &extra) != 1) continue;
        char expected[40];
        snprintf(expected, sizeof(expected), "h%lld.bin", day);
        if (strcmp(expected, entry->d_name) || day >= day_of(oldest(now))) continue;
        char path[96];
        snprintf(path, sizeof(path), HISTORY_BASE_PATH "/%s", expected);
        if (remove(path)) err = ESP_FAIL;
    }
    closedir(dir);
    if (err == ESP_OK) pruned_day = day_of(now);
    return err;
}

esp_err_t lamp_history_init(bool storage_ready)
{
    lock = xSemaphoreCreateMutex();
    if (!lock) return ESP_ERR_NO_MEM;
    ready = storage_ready;
    if (!ready) { last_error = ESP_ERR_INVALID_STATE; return last_error; }
    nvs_handle_t h;
    esp_err_t err = nvs_open("lamp_history", NVS_READONLY, &h);
    if (err == ESP_OK) {
        size_t size = sizeof(active);
        err = nvs_get_blob(h, "active_v2", &active, &size);
        nvs_close(h);
        if (err == ESP_OK && (size != sizeof(active) || (active.magic && !valid_record(&active))))
            err = ESP_ERR_INVALID_CRC;
    }
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK && active.magic) err = append(&active);
    if (err == ESP_OK) {
        active = (record_t){0};
        err = checkpoint();
    }
    if (err != ESP_OK) fail(err);
    return err;
}

void lamp_history_clock_synced(void)
{
    atomic_store(&synced, true);
}

static bool advance(int64_t now, int64_t mono)
{
    if (!ready || !synced || !valid_time(now)) return false;
    esp_err_t err = prune(now);
    if (err != ESP_OK) { fail(err); return false; }
    int64_t drift = last_wall ? (now - last_wall) - (mono - last_mono) / 1000000 : 0;
    if (active.magic && (drift > 2 || drift < -2)) {
        err = append(&active);
        active = (record_t){0};
        if (err == ESP_OK) err = checkpoint();
    }
    last_wall = now; last_mono = mono;
    while (err == ESP_OK && active.magic && day_of(active.start) < day_of(now)) {
        active.end = (day_of(active.start) + 1) * DAY - OFFSET;
        err = append(&active);
        active.start = active.end;
        active.cause = LAMP_HIST_CONTINUATION;
    }
    if (err != ESP_OK) { fail(err); return false; }
    if (active.magic) active.end = now > active.start ? now : active.start;
    return true;
}

static void start_rec(bool on, lamp_history_cause_t cause, int64_t now)
{
    active = (record_t){.magic = MAGIC, .cause = (uint8_t)cause, .on = on ? 1 : 0, .start = now, .end = now};
}

void lamp_history_tick(bool known, bool on)
{
    if (!lock) return;
    xSemaphoreTake(lock, portMAX_DELAY);
    int64_t now = time(NULL), mono = esp_timer_get_time();
    if (advance(now, mono)) {
        if (known && !active.magic) start_rec(on, LAMP_HIST_TIME_SYNC, now);
        if (mono - saved_mono >= 60000000 || (active.magic && !saved_mono)) {
            esp_err_t err = checkpoint();
            if (err != ESP_OK) fail(err);
            else saved_mono = mono;
        }
    }
    xSemaphoreGive(lock);
}

void lamp_history_change(bool on, lamp_history_cause_t cause)
{
    if (!lock) return;
    xSemaphoreTake(lock, portMAX_DELAY);
    int64_t now = time(NULL), mono = esp_timer_get_time();
    if (advance(now, mono)) {
        esp_err_t err = active.magic ? append(&active) : ESP_OK;
        if (err == ESP_OK) { start_rec(on, cause, now); err = checkpoint(); }
        if (err != ESP_OK) fail(err);
        else saved_mono = mono;
    }
    xSemaphoreGive(lock);
}

static lamp_history_status_t status_locked(void)
{
    int64_t now = time(NULL);
    bool valid = synced && valid_time(now);
    return (lamp_history_status_t){
        .now = valid ? now : 0,
        .oldest = valid ? oldest(now) : 0,
        .time_synced = valid,
        .ready = ready,
        .recording = ready && valid && active.magic,
        .error = last_error,
    };
}

void lamp_history_status(lamp_history_status_t *out)
{
    if (!lock) { *out = (lamp_history_status_t){.error = ESP_ERR_INVALID_STATE}; return; }
    xSemaphoreTake(lock, portMAX_DELAY);
    *out = status_locked();
    xSemaphoreGive(lock);
}

static esp_err_t emit_record(record_t r, bool *comma, int64_t from, int64_t to,
                             lamp_history_writer_t writer, void *ctx)
{
    if (r.end < from || r.start >= to) return ESP_OK;
    char json[128];
    int n = snprintf(json, sizeof(json), "%s[%lld,%lld,%u,%u]", *comma ? "," : "",
        (long long)r.start, (long long)r.end, r.on, r.cause);
    *comma = true;
    return writer(ctx, json, n);
}

esp_err_t lamp_history_write_json(int64_t from, int64_t to, lamp_history_writer_t writer, void *ctx)
{
    if (!valid_time(from) || !valid_time(to) || to <= from || to - from > 31 * DAY ||
        (from + OFFSET) % DAY || (to + OFFSET) % DAY) return ESP_ERR_INVALID_ARG;
    if (!lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(lock, portMAX_DELAY);
    lamp_history_status_t st = status_locked();
    char json[256];
    int n = snprintf(json, sizeof(json),
        "{\"time_synced\":%s,\"ready\":%s,\"recording\":%s,"
        "\"now\":%lld,\"oldest\":%lld,\"error\":\"%s\",\"records\":[",
        st.time_synced ? "true" : "false", st.ready ? "true" : "false",
        st.recording ? "true" : "false", (long long)st.now, (long long)st.oldest,
        st.error ? esp_err_to_name(st.error) : "");
    esp_err_t err = writer(ctx, json, n);
    bool comma = false, corrupt = false;
    for (int64_t day = day_of(from); err == ESP_OK && day < day_of(to); ++day) {
        if (st.time_synced && day < day_of(st.oldest)) continue;
        char path[96];
        snprintf(path, sizeof(path), HISTORY_BASE_PATH "/h%lld.bin", (long long)day);
        FILE *file = fopen(path, "rb");
        if (!file) { if (errno != ENOENT) corrupt = true; continue; }
        record_t r;
        size_t got;
        while (err == ESP_OK && (got = fread(&r, 1, sizeof(r), file)) != 0) {
            if (got != sizeof(r) || !valid_record(&r)) { corrupt = true; continue; }
            err = emit_record(r, &comma, from, to, writer, ctx);
        }
        if (ferror(file)) corrupt = true;
        fclose(file);
    }
    if (err == ESP_OK && active.magic && ready) {
        record_t live = active;
        int64_t drift = (st.now - last_wall) - (esp_timer_get_time() - last_mono) / 1000000;
        if (st.time_synced && st.now >= live.end && drift >= -2 && drift <= 2) live.end = st.now;
        err = emit_record(live, &comma, from, to, writer, ctx);
    }
    if (err == ESP_OK) {
        const char *tail = corrupt ? "],\"incomplete\":true}" : "],\"incomplete\":false}";
        err = writer(ctx, tail, strlen(tail));
    }
    xSemaphoreGive(lock);
    return err;
}
