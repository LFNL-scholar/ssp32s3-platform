#include "cfg_store.h"

#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_log.h"
#include "mbedtls/sha256.h"
#include "sdkconfig.h"

static const char *TAG = "cfg_store";

#define NVS_NS_CFG   "ssp_cfg"
#define NVS_NS_BOND  "nimble_bond"

#define KEY_WIFI     "wifi"
#define KEY_AUTH     "auth"
#define KEY_SETTINGS "settings"
#define KEY_PERSONS  "persons"
#define KEY_DEVICES  "devices"

typedef struct {
    cfg_wifi_t wifi;
    cfg_auth_t auth;
    cfg_settings_t settings;
    cfg_person_t persons[CFG_MAX_PERSONS];
    cfg_device_t devices[CFG_MAX_DEVICES];
} cfg_cache_t;

static cfg_cache_t s_cache;
static SemaphoreHandle_t s_mutex = NULL;

static void settings_set_defaults(cfg_settings_t *s)
{
    memset(s, 0, sizeof(*s));
    strlcpy(s->hostname, CONFIG_SSP_DEFAULT_HOSTNAME, sizeof(s->hostname));
    s->led_gpio = CONFIG_SSP_DEFAULT_LED_GPIO;
    s->led_brightness = CONFIG_SSP_DEFAULT_LED_BRIGHTNESS;
    s->led_away_mode = 0;
    s->led_idle_enabled = true;
    s->lamp_auto_off_on_away = false;
    s->lamp_auto_on_on_arrive = false;
    strlcpy(s->ntp_server1, "ntp.aliyun.com", sizeof(s->ntp_server1));
    strlcpy(s->ntp_server2, "cn.pool.ntp.org", sizeof(s->ntp_server2));
    strlcpy(s->timezone, "CST-8", sizeof(s->timezone));
}

static esp_err_t nvs_write_blob(const char *key, const void *data, size_t len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS_CFG, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_blob(h, key, data, len);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    return err;
}

static esp_err_t nvs_read_blob_exact(const char *key, void *data, size_t expected_len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS_CFG, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    size_t len = expected_len;
    err = nvs_get_blob(h, key, data, &len);
    nvs_close(h);
    if (err == ESP_OK && len != expected_len) {
        return ESP_ERR_INVALID_SIZE;
    }
    return err;
}

esp_err_t cfg_store_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_cache, 0, sizeof(s_cache));
    settings_set_defaults(&s_cache.settings);

    if (nvs_read_blob_exact(KEY_WIFI, &s_cache.wifi, sizeof(s_cache.wifi)) != ESP_OK) {
        memset(&s_cache.wifi, 0, sizeof(s_cache.wifi));
    }
    if (nvs_read_blob_exact(KEY_AUTH, &s_cache.auth, sizeof(s_cache.auth)) != ESP_OK) {
        memset(&s_cache.auth, 0, sizeof(s_cache.auth));
    }
    if (nvs_read_blob_exact(KEY_SETTINGS, &s_cache.settings, sizeof(s_cache.settings)) != ESP_OK) {
        settings_set_defaults(&s_cache.settings);
    }
    if (nvs_read_blob_exact(KEY_PERSONS, s_cache.persons, sizeof(s_cache.persons)) != ESP_OK) {
        memset(s_cache.persons, 0, sizeof(s_cache.persons));
    }
    if (nvs_read_blob_exact(KEY_DEVICES, s_cache.devices, sizeof(s_cache.devices)) != ESP_OK) {
        memset(s_cache.devices, 0, sizeof(s_cache.devices));
    }

    xSemaphoreGive(s_mutex);
    ESP_LOGI(TAG, "Configuration loaded (wifi=%d, auth=%d, hostname=%s)",
             s_cache.wifi.configured, s_cache.auth.initialized, s_cache.settings.hostname);
    return ESP_OK;
}

void cfg_store_get_ap_credentials(char *ssid, size_t ssid_len, char *pass, size_t pass_len)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);

    if (ssid && ssid_len > 0) {
        snprintf(ssid, ssid_len, "%s%02X%02X", CONFIG_SSP_SOFTAP_PREFIX, mac[4], mac[5]);
    }

    if (pass && pass_len > 0) {
        static const char alphabet[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars
        uint8_t input[22];
        memcpy(input, mac, 6);
        memcpy(input + 6, "ssp32s3-ap-salt", 15);
        uint8_t hash[32];
        mbedtls_sha256(input, 21, hash, 0);

        size_t max_chars = pass_len - 1;
        if (max_chars > 8) max_chars = 8;
        for (size_t i = 0; i < max_chars; i++) {
            pass[i] = alphabet[hash[i] & 0x1F];
        }
        pass[max_chars] = '\0';
    }
}

void cfg_wifi_get(cfg_wifi_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.wifi;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_wifi_set(const char *ssid, const char *password)
{
    if (!ssid || ssid[0] == '\0') return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_cache.wifi, 0, sizeof(s_cache.wifi));
    s_cache.wifi.configured = true;
    strlcpy(s_cache.wifi.ssid, ssid, sizeof(s_cache.wifi.ssid));
    if (password) {
        strlcpy(s_cache.wifi.password, password, sizeof(s_cache.wifi.password));
    }
    esp_err_t err = nvs_write_blob(KEY_WIFI, &s_cache.wifi, sizeof(s_cache.wifi));
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_wifi_clear(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(&s_cache.wifi, 0, sizeof(s_cache.wifi));
    esp_err_t err = nvs_write_blob(KEY_WIFI, &s_cache.wifi, sizeof(s_cache.wifi));
    xSemaphoreGive(s_mutex);
    return err;
}

static void compute_pass_hash(const uint8_t salt[16], const char *password, uint8_t out_hash[32])
{
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);
    mbedtls_sha256_update(&ctx, salt, 16);
    mbedtls_sha256_update(&ctx, (const unsigned char *)password, strlen(password));
    mbedtls_sha256_finish(&ctx, out_hash);
    mbedtls_sha256_free(&ctx);
}

bool cfg_auth_is_initialized(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    bool init = s_cache.auth.initialized;
    xSemaphoreGive(s_mutex);
    return init;
}

esp_err_t cfg_auth_set_password(const char *password)
{
    if (!password || strlen(password) < 4) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_auth_t next;
    memset(&next, 0, sizeof(next));
    next.initialized = true;
    esp_fill_random(next.salt, sizeof(next.salt));
    compute_pass_hash(next.salt, password, next.pass_hash);
    esp_err_t err = nvs_write_blob(KEY_AUTH, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.auth = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

bool cfg_auth_verify_password(const char *password)
{
    if (!password) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (!s_cache.auth.initialized) {
        xSemaphoreGive(s_mutex);
        return false;
    }
    uint8_t candidate[32];
    compute_pass_hash(s_cache.auth.salt, password, candidate);
    uint8_t diff = 0;
    for (size_t i = 0; i < 32; i++) {
        diff |= (candidate[i] ^ s_cache.auth.pass_hash[i]);
    }
    xSemaphoreGive(s_mutex);
    return diff == 0;
}

void cfg_settings_get(cfg_settings_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.settings;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_settings_set(const cfg_settings_t *in)
{
    if (!in) return ESP_ERR_INVALID_ARG;
    if (in->led_gpio < 0 || in->led_gpio > 48 ||
        in->led_gpio == 35 || in->led_gpio == 36 || in->led_gpio == 37) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_settings_t next = *in;
    if (next.hostname[0] == '\0') {
        strlcpy(next.hostname, CONFIG_SSP_DEFAULT_HOSTNAME, sizeof(next.hostname));
    }
    if (next.led_brightness > 100) next.led_brightness = 100;
    if (next.led_away_mode > 1) next.led_away_mode = 0;
    if (next.ntp_server1[0] == '\0') {
        strlcpy(next.ntp_server1, "ntp.aliyun.com", sizeof(next.ntp_server1));
    }
    if (next.timezone[0] == '\0') {
        strlcpy(next.timezone, "CST-8", sizeof(next.timezone));
    }
    esp_err_t err = nvs_write_blob(KEY_SETTINGS, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.settings = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

size_t cfg_persons_list(cfg_person_t *out, size_t max_count)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    size_t count = 0;
    for (size_t i = 0; i < CFG_MAX_PERSONS && count < max_count; i++) {
        if (s_cache.persons[i].used) {
            if (out) out[count] = s_cache.persons[i];
            count++;
        }
    }
    xSemaphoreGive(s_mutex);
    return count;
}

bool cfg_person_get(uint8_t id, cfg_person_t *out)
{
    if (id == 0) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    bool found = false;
    for (size_t i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_cache.persons[i].used && s_cache.persons[i].id == id) {
            if (out) *out = s_cache.persons[i];
            found = true;
            break;
        }
    }
    xSemaphoreGive(s_mutex);
    return found;
}

esp_err_t cfg_person_add(const char *name, cfg_person_t *out)
{
    if (!name || name[0] == '\0') return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int free_idx = -1;
    uint8_t max_id = 0;
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_cache.persons[i].used) {
            if (s_cache.persons[i].id > max_id) max_id = s_cache.persons[i].id;
        } else if (free_idx < 0) {
            free_idx = i;
        }
    }
    if (free_idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NO_MEM;
    }
    // Find unique ID 1..255
    uint8_t new_id = (uint8_t)(max_id + 1);
    if (new_id == 0) new_id = 1;
    while (1) {
        bool clash = false;
        for (int i = 0; i < CFG_MAX_PERSONS; i++) {
            if (s_cache.persons[i].used && s_cache.persons[i].id == new_id) {
                clash = true;
                break;
            }
        }
        if (!clash) break;
        new_id++;
        if (new_id == 0) new_id = 1;
    }

    cfg_person_t p = {0};
    p.id = new_id;
    p.used = true;
    strlcpy(p.name, name, sizeof(p.name));
    s_cache.persons[free_idx] = p;
    esp_err_t err = nvs_write_blob(KEY_PERSONS, s_cache.persons, sizeof(s_cache.persons));
    if (err != ESP_OK) {
        memset(&s_cache.persons[free_idx], 0, sizeof(cfg_person_t));
    } else if (out) {
        *out = p;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_person_rename(uint8_t id, const char *name)
{
    if (id == 0 || !name || name[0] == '\0') return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int idx = -1;
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_cache.persons[i].used && s_cache.persons[i].id == id) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NOT_FOUND;
    }
    cfg_person_t backup = s_cache.persons[idx];
    strlcpy(s_cache.persons[idx].name, name, sizeof(s_cache.persons[idx].name));
    esp_err_t err = nvs_write_blob(KEY_PERSONS, s_cache.persons, sizeof(s_cache.persons));
    if (err != ESP_OK) s_cache.persons[idx] = backup;
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_person_delete(uint8_t id)
{
    if (id == 0) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int idx = -1;
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_cache.persons[i].used && s_cache.persons[i].id == id) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NOT_FOUND;
    }
    memset(&s_cache.persons[idx], 0, sizeof(cfg_person_t));
    bool dev_changed = false;
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_cache.devices[i].used && s_cache.devices[i].person_id == id) {
            memset(&s_cache.devices[i], 0, sizeof(cfg_device_t));
            dev_changed = true;
        }
    }
    esp_err_t err = nvs_write_blob(KEY_PERSONS, s_cache.persons, sizeof(s_cache.persons));
    if (err == ESP_OK && dev_changed) {
        err = nvs_write_blob(KEY_DEVICES, s_cache.devices, sizeof(s_cache.devices));
    }
    xSemaphoreGive(s_mutex);
    return err;
}

size_t cfg_devices_list(cfg_device_t *out, size_t max_count)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    size_t count = 0;
    for (size_t i = 0; i < CFG_MAX_DEVICES && count < max_count; i++) {
        if (s_cache.devices[i].used) {
            if (out) out[count] = s_cache.devices[i];
            count++;
        }
    }
    xSemaphoreGive(s_mutex);
    return count;
}

bool cfg_device_get(uint8_t id, cfg_device_t *out)
{
    if (id == 0) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    bool found = false;
    for (size_t i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_cache.devices[i].used && s_cache.devices[i].id == id) {
            if (out) *out = s_cache.devices[i];
            found = true;
            break;
        }
    }
    xSemaphoreGive(s_mutex);
    return found;
}

esp_err_t cfg_device_add(const cfg_device_t *in, cfg_device_t *out)
{
    if (!in || in->person_id == 0 || in->label[0] == '\0') return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);

    bool person_exists = false;
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_cache.persons[i].used && s_cache.persons[i].id == in->person_id) {
            person_exists = true;
            break;
        }
    }
    if (!person_exists) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NOT_FOUND;
    }

    int free_idx = -1;
    uint8_t max_id = 0;
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_cache.devices[i].used) {
            if (s_cache.devices[i].id > max_id) max_id = s_cache.devices[i].id;
            if (in->match_type == MATCH_FIXED_MAC &&
                s_cache.devices[i].match_type == MATCH_FIXED_MAC &&
                memcmp(s_cache.devices[i].mac, in->mac, 6) == 0) {
                xSemaphoreGive(s_mutex);
                return ESP_ERR_INVALID_STATE;
            }
        } else if (free_idx < 0) {
            free_idx = i;
        }
    }
    if (free_idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NO_MEM;
    }

    uint8_t new_id = (uint8_t)(max_id + 1);
    if (new_id == 0) new_id = 1;
    while (1) {
        bool clash = false;
        for (int i = 0; i < CFG_MAX_DEVICES; i++) {
            if (s_cache.devices[i].used && s_cache.devices[i].id == new_id) {
                clash = true;
                break;
            }
        }
        if (!clash) break;
        new_id++;
        if (new_id == 0) new_id = 1;
    }

    cfg_device_t d = *in;
    d.id = new_id;
    d.used = true;
    if (d.enter_rssi == 0) d.enter_rssi = -75;
    if (d.exit_rssi == 0) d.exit_rssi = -85;
    if (d.exit_rssi > d.enter_rssi) d.exit_rssi = d.enter_rssi - 5;
    if (d.away_timeout_s == 0) d.away_timeout_s = 120;

    s_cache.devices[free_idx] = d;
    esp_err_t err = nvs_write_blob(KEY_DEVICES, s_cache.devices, sizeof(s_cache.devices));
    if (err != ESP_OK) {
        memset(&s_cache.devices[free_idx], 0, sizeof(cfg_device_t));
    } else if (out) {
        *out = d;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_device_update(uint8_t id, const char *label, int8_t enter_rssi, int8_t exit_rssi, uint16_t away_timeout_s)
{
    if (id == 0) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int idx = -1;
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_cache.devices[i].used && s_cache.devices[i].id == id) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NOT_FOUND;
    }
    cfg_device_t backup = s_cache.devices[idx];
    if (label && label[0] != '\0') {
        strlcpy(s_cache.devices[idx].label, label, sizeof(s_cache.devices[idx].label));
    }
    s_cache.devices[idx].enter_rssi = enter_rssi;
    s_cache.devices[idx].exit_rssi = (exit_rssi <= enter_rssi) ? exit_rssi : (enter_rssi - 5);
    s_cache.devices[idx].away_timeout_s = (away_timeout_s >= 10) ? away_timeout_s : 10;

    esp_err_t err = nvs_write_blob(KEY_DEVICES, s_cache.devices, sizeof(s_cache.devices));
    if (err != ESP_OK) s_cache.devices[idx] = backup;
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_device_delete(uint8_t id)
{
    if (id == 0) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int idx = -1;
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_cache.devices[i].used && s_cache.devices[i].id == id) {
            idx = i;
            break;
        }
    }
    if (idx < 0) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NOT_FOUND;
    }
    memset(&s_cache.devices[idx], 0, sizeof(cfg_device_t));
    esp_err_t err = nvs_write_blob(KEY_DEVICES, s_cache.devices, sizeof(s_cache.devices));
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_store_factory_reset(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    nvs_handle_t h;
    if (nvs_open(NVS_NS_CFG, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    if (nvs_open(NVS_NS_BOND, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    if (nvs_open("lamp_state", NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    if (nvs_open("lamp_history", NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    memset(&s_cache, 0, sizeof(s_cache));
    settings_set_defaults(&s_cache.settings);
    xSemaphoreGive(s_mutex);
    ESP_LOGW(TAG, "Factory reset complete");
    return ESP_OK;
}
