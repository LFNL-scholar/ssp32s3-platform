#include "presence_log.h"

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"

static const char *TAG = "presence_log";
static const char *LOG_PATH = "/data/presence.bin";

#define LOG_MAGIC   0x504C4F47U // "PLOG"
#define LOG_VERSION 1U

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t version;
    uint32_t head_idx; // Next slot index to write (0..PRESENCE_LOG_MAX_ENTRIES-1)
    uint32_t count;    // Total valid entries (0..PRESENCE_LOG_MAX_ENTRIES)
    uint32_t next_seq; // Monotonic sequence number starting from 1
    uint8_t reserved[12];
} log_header_t;

_Static_assert(sizeof(log_header_t) == 32, "log_header_t must be 32 bytes");

static SemaphoreHandle_t s_mutex = NULL;
static log_header_t s_hdr;

static esp_err_t write_header_to_file(FILE *f)
{
    if (fseek(f, 0, SEEK_SET) != 0) return ESP_FAIL;
    if (fwrite(&s_hdr, sizeof(s_hdr), 1, f) != 1) return ESP_FAIL;
    return ESP_OK;
}

static esp_err_t reset_file_locked(void)
{
    memset(&s_hdr, 0, sizeof(s_hdr));
    s_hdr.magic = LOG_MAGIC;
    s_hdr.version = LOG_VERSION;
    s_hdr.head_idx = 0;
    s_hdr.count = 0;
    s_hdr.next_seq = 1;

    FILE *f = fopen(LOG_PATH, "wb");
    if (!f) {
        ESP_LOGE(TAG, "Failed to create %s", LOG_PATH);
        return ESP_FAIL;
    }
    esp_err_t err = write_header_to_file(f);
    fflush(f);
    fsync(fileno(f));
    fclose(f);
    return err;
}

esp_err_t presence_log_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    FILE *f = fopen(LOG_PATH, "rb");
    if (!f) {
        esp_err_t err = reset_file_locked();
        xSemaphoreGive(s_mutex);
        ESP_LOGI(TAG, "Initialized new presence log ring buffer");
        return err;
    }

    log_header_t hdr;
    size_t n = fread(&hdr, sizeof(hdr), 1, f);
    fclose(f);

    if (n != 1 || hdr.magic != LOG_MAGIC || hdr.version != LOG_VERSION ||
        hdr.head_idx >= PRESENCE_LOG_MAX_ENTRIES || hdr.count > PRESENCE_LOG_MAX_ENTRIES) {
        ESP_LOGW(TAG, "Invalid or corrupt log header, reinitializing");
        esp_err_t err = reset_file_locked();
        xSemaphoreGive(s_mutex);
        return err;
    }

    s_hdr = hdr;
    xSemaphoreGive(s_mutex);
    ESP_LOGI(TAG, "Presence log loaded: %lu entries", (unsigned long)s_hdr.count);
    return ESP_OK;
}

esp_err_t presence_log_append(uint8_t person_id, const char *person_name,
                              presence_event_type_t event, const char *device_label,
                              int8_t rssi, bool time_synced)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;

    presence_log_entry_t entry;
    memset(&entry, 0, sizeof(entry));

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    entry.seq = s_hdr.next_seq++;
    entry.time_synced = time_synced ? 1 : 0;
    entry.timestamp = time_synced ? (int64_t)time(NULL) : 0;
    entry.uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    entry.person_id = person_id;
    entry.event = (uint8_t)event;
    entry.rssi = rssi;
    if (person_name) strlcpy(entry.person_name, person_name, sizeof(entry.person_name));
    if (device_label) strlcpy(entry.device_label, device_label, sizeof(entry.device_label));

    FILE *f = fopen(LOG_PATH, "r+b");
    if (!f) {
        if (reset_file_locked() != ESP_OK) {
            xSemaphoreGive(s_mutex);
            return ESP_FAIL;
        }
        f = fopen(LOG_PATH, "r+b");
        if (!f) {
            xSemaphoreGive(s_mutex);
            return ESP_FAIL;
        }
    }

    long offset = (long)sizeof(log_header_t) + (long)s_hdr.head_idx * (long)sizeof(presence_log_entry_t);
    esp_err_t err = ESP_OK;
    if (fseek(f, offset, SEEK_SET) != 0 || fwrite(&entry, sizeof(entry), 1, f) != 1) {
        err = ESP_FAIL;
    } else {
        s_hdr.head_idx = (s_hdr.head_idx + 1) % PRESENCE_LOG_MAX_ENTRIES;
        if (s_hdr.count < PRESENCE_LOG_MAX_ENTRIES) {
            s_hdr.count++;
        }
        err = write_header_to_file(f);
    }

    fflush(f);
    fsync(fileno(f));
    fclose(f);
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t presence_log_query(size_t offset, size_t limit,
                             presence_log_entry_t *out_entries,
                             size_t *out_returned, size_t *out_total)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;
    if (out_returned) *out_returned = 0;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    size_t total = s_hdr.count;
    if (out_total) *out_total = total;

    if (offset >= total || limit == 0 || !out_entries) {
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }

    FILE *f = fopen(LOG_PATH, "rb");
    if (!f) {
        xSemaphoreGive(s_mutex);
        return ESP_FAIL;
    }

    size_t to_read = total - offset;
    if (to_read > limit) to_read = limit;

    size_t read_count = 0;
    for (size_t i = 0; i < to_read; i++) {
        // Newest entry is at (head_idx - 1 - (offset + i)) mod MAX
        size_t back = offset + i + 1;
        size_t slot = (s_hdr.head_idx + PRESENCE_LOG_MAX_ENTRIES - back) % PRESENCE_LOG_MAX_ENTRIES;
        long file_off = (long)sizeof(log_header_t) + (long)slot * (long)sizeof(presence_log_entry_t);
        if (fseek(f, file_off, SEEK_SET) == 0 &&
            fread(&out_entries[read_count], sizeof(presence_log_entry_t), 1, f) == 1) {
            read_count++;
        } else {
            break;
        }
    }

    fclose(f);
    xSemaphoreGive(s_mutex);
    if (out_returned) *out_returned = read_count;
    return ESP_OK;
}

esp_err_t presence_log_clear(void)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    esp_err_t err = reset_file_locked();
    xSemaphoreGive(s_mutex);
    return err;
}
