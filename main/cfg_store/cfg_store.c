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
#define KEY_SIRI     "siri"
#define KEY_WOL      "wol"
#define KEY_MQTT     "mqtt"
#define KEY_TUNNEL   "tunnel"
#define KEY_ENV      "env"
#define KEY_CAM      "cam"

typedef struct {
    cfg_wifi_t wifi;
    cfg_auth_t auth;
    cfg_settings_t settings;
    cfg_person_t persons[CFG_MAX_PERSONS];
    cfg_device_t devices[CFG_MAX_DEVICES];
    cfg_siri_t siri;
    cfg_wol_t wol;
    cfg_mqtt_t mqtt;
    cfg_tunnel_t tunnel;
    cfg_env_t env;
    cfg_cam_t cam;
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

static void wol_set_defaults(cfg_wol_t *w)
{
    memset(w, 0, sizeof(*w));
    strlcpy(w->name, "Windows 工作站", sizeof(w->name));
    strlcpy(w->ip, "192.168.0.106", sizeof(w->ip));
    strlcpy(w->mac, "9C:6B:00:5F:9C:7C", sizeof(w->mac));
    w->auto_wake_on_arrive = false;
    w->auto_cooldown_s = 300;
}

static void mqtt_set_defaults(cfg_mqtt_t *m)
{
    memset(m, 0, sizeof(*m));
    m->enabled = false;
    strlcpy(m->host, "bemfa.com", sizeof(m->host));
    m->port = 9501;
    strlcpy(m->wol_topic, "pcwake006", sizeof(m->wol_topic));
    strlcpy(m->lamp_topic, "lamp002", sizeof(m->lamp_topic));
}

static void env_set_defaults(cfg_env_t *e)
{
    memset(e, 0, sizeof(*e));
    e->enabled = true;
    strlcpy(e->name, "小米温湿度计 3 mini", sizeof(e->name));
    // A4:C1:38:D0:8B:34 in LE order
    e->mac[0] = 0x34;
    e->mac[1] = 0x8B;
    e->mac[2] = 0xD0;
    e->mac[3] = 0x38;
    e->mac[4] = 0xC1;
    e->mac[5] = 0xA4;
    e->has_bindkey = false;
    e->temp_low = 18.0f;
    e->temp_high = 28.0f;
    e->hum_low = 35.0f;
    e->hum_high = 65.0f;
}

static void cam_set_defaults(cfg_cam_t *c)
{
    memset(c, 0, sizeof(*c));
    c->privacy = false;
    c->away_only = false;
    strlcpy(c->lan_url, "http://192.168.0.108:8080", sizeof(c->lan_url));
    c->fps = 20;
    c->quality = 75;
    strlcpy(c->res, "1280x720", sizeof(c->res));
}

static void generate_siri_token(char out[33])
{
    uint8_t rnd[16];
    esp_fill_random(rnd, sizeof(rnd));
    for (int i = 0; i < 16; i++) {
        snprintf(&out[i * 2], 3, "%02x", rnd[i]);
    }
    out[32] = '\0';
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
    if (nvs_read_blob_exact(KEY_SIRI, &s_cache.siri, sizeof(s_cache.siri)) != ESP_OK ||
        strlen(s_cache.siri.token) != 32) {
        memset(&s_cache.siri, 0, sizeof(s_cache.siri));
        s_cache.siri.enabled = true;
        generate_siri_token(s_cache.siri.token);
        nvs_write_blob(KEY_SIRI, &s_cache.siri, sizeof(s_cache.siri));
    }
    if (nvs_read_blob_exact(KEY_WOL, &s_cache.wol, sizeof(s_cache.wol)) != ESP_OK) {
        wol_set_defaults(&s_cache.wol);
    }
    if (nvs_read_blob_exact(KEY_MQTT, &s_cache.mqtt, sizeof(s_cache.mqtt)) != ESP_OK) {
        mqtt_set_defaults(&s_cache.mqtt);
    }
    if (nvs_read_blob_exact(KEY_TUNNEL, &s_cache.tunnel, sizeof(s_cache.tunnel)) != ESP_OK) {
        memset(&s_cache.tunnel, 0, sizeof(s_cache.tunnel));
    }
    if (nvs_read_blob_exact(KEY_ENV, &s_cache.env, sizeof(s_cache.env)) != ESP_OK) {
        env_set_defaults(&s_cache.env);
    }
    if (nvs_read_blob_exact(KEY_CAM, &s_cache.cam, sizeof(s_cache.cam)) != ESP_OK) {
        cam_set_defaults(&s_cache.cam);
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

void cfg_siri_get(cfg_siri_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.siri;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_siri_set_enabled(bool enabled)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_siri_t next = s_cache.siri;
    next.enabled = enabled;
    if (strlen(next.token) != 32) {
        generate_siri_token(next.token);
    }
    esp_err_t err = nvs_write_blob(KEY_SIRI, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.siri = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t cfg_siri_regenerate_token(cfg_siri_t *out)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_siri_t next = s_cache.siri;
    generate_siri_token(next.token);
    esp_err_t err = nvs_write_blob(KEY_SIRI, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.siri = next;
        if (out) *out = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

bool cfg_siri_verify_token(const char *candidate)
{
    if (!candidate || strlen(candidate) != 32) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (!s_cache.siri.enabled || strlen(s_cache.siri.token) != 32) {
        xSemaphoreGive(s_mutex);
        return false;
    }
    uint8_t diff = 0;
    for (int i = 0; i < 32; i++) {
        diff |= (uint8_t)(candidate[i] ^ s_cache.siri.token[i]);
    }
    xSemaphoreGive(s_mutex);
    return diff == 0;
}

void cfg_wol_get(cfg_wol_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.wol;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_wol_set(const cfg_wol_t *in)
{
    if (!in || in->mac[0] == '\0') return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_wol_t next = *in;
    if (next.name[0] == '\0') {
        strlcpy(next.name, "Windows 工作站", sizeof(next.name));
    }
    if (next.auto_cooldown_s < 30) {
        next.auto_cooldown_s = 30;
    }
    esp_err_t err = nvs_write_blob(KEY_WOL, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.wol = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

void cfg_mqtt_get(cfg_mqtt_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.mqtt;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_mqtt_set(const cfg_mqtt_t *in)
{
    if (!in) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_mqtt_t next = *in;
    if (next.host[0] == '\0') {
        strlcpy(next.host, "bemfa.com", sizeof(next.host));
    }
    if (next.port == 0) {
        next.port = 9501;
    }
    esp_err_t err = nvs_write_blob(KEY_MQTT, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.mqtt = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

void cfg_tunnel_get(cfg_tunnel_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.tunnel;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_tunnel_set(const cfg_tunnel_t *in)
{
    if (!in) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_tunnel_t next = *in;
    esp_err_t err = nvs_write_blob(KEY_TUNNEL, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.tunnel = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

void cfg_env_get(cfg_env_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.env;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_env_set(const cfg_env_t *in)
{
    if (!in) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_env_t next = *in;
    if (next.name[0] == '\0') {
        strlcpy(next.name, "小米温湿度计 3 mini", sizeof(next.name));
    }
    if (next.temp_low < -20.0f) next.temp_low = -20.0f;
    if (next.temp_high > 60.0f) next.temp_high = 60.0f;
    if (next.temp_low >= next.temp_high) {
        next.temp_high = next.temp_low + 2.0f;
    }
    if (next.hum_low < 0.0f) next.hum_low = 0.0f;
    if (next.hum_high > 100.0f) next.hum_high = 100.0f;
    if (next.hum_low >= next.hum_high) {
        next.hum_high = next.hum_low + 5.0f;
        if (next.hum_high > 100.0f) {
            next.hum_high = 100.0f;
            next.hum_low = 95.0f;
        }
    }
    esp_err_t err = nvs_write_blob(KEY_ENV, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.env = next;
    }
    xSemaphoreGive(s_mutex);
    return err;
}

void cfg_cam_get(cfg_cam_t *out)
{
    if (!out) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_cache.cam;
    xSemaphoreGive(s_mutex);
}

esp_err_t cfg_cam_set(const cfg_cam_t *in)
{
    if (!in) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cfg_cam_t next = *in;
    if (next.fps < 1) next.fps = 1;
    if (next.fps > 30) next.fps = 30;
    if (next.quality < 30) next.quality = 30;
    if (next.quality > 95) next.quality = 95;
    if (next.res[0] == '\0') strlcpy(next.res, "1280x720", sizeof(next.res));
    esp_err_t err = nvs_write_blob(KEY_CAM, &next, sizeof(next));
    if (err == ESP_OK) {
        s_cache.cam = next;
    }
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
    wol_set_defaults(&s_cache.wol);
    mqtt_set_defaults(&s_cache.mqtt);
    env_set_defaults(&s_cache.env);
    cam_set_defaults(&s_cache.cam);
    xSemaphoreGive(s_mutex);
    ESP_LOGW(TAG, "Factory reset complete");
    return ESP_OK;
}
