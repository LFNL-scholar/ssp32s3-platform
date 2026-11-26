#include "env_sensor.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mbedtls/ccm.h"

#include "cfg_store.h"
#include "wifi_mgr.h"

static const char *TAG = "env_sensor";
static const char *ENV_HIST_PATH = "/data/env_hist.bin";

#define ENV_HIST_MAGIC        0x454E5648U // "ENVH"
#define ENV_HIST_VERSION      1U
#define ENV_HIST_MAX_RECORDS  8640        // 30 days @ 5-minute interval
#define ENV_SAVE_INTERVAL_S   300
#define ENV_STALE_SAVE_MS     (20 * 60 * 1000LL)

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t version;
    uint32_t head_idx;
    uint32_t count;
    uint8_t reserved[16];
} env_hist_hdr_t;

typedef struct __attribute__((packed)) {
    int64_t epoch;
    int16_t temp_x100;
    uint16_t hum_x100;
    uint8_t battery;
    int8_t rssi;
    uint8_t flags;
    uint8_t reserved;
} env_hist_record_t;

_Static_assert(sizeof(env_hist_hdr_t) == 32, "env_hist_hdr_t must be 32 bytes");
_Static_assert(sizeof(env_hist_record_t) == 16, "env_hist_record_t must be 16 bytes");

typedef struct {
    bool has_temp;
    bool has_hum;
    bool has_battery;
    bool has_rssi;
    float temp_c;
    float humidity;
    uint8_t battery_pct;
    int8_t rssi;
    uint16_t product_id;
    int64_t last_adv_ms;
    int64_t last_data_ms;
    uint32_t adv_count;
    uint32_t decrypt_ok;
    uint32_t decrypt_fail;
    bool has_last_pkt_cnt;
    uint32_t last_pkt_cnt;
    int64_t last_pkt_ms;
    int64_t last_adv_emit_ms;
    int64_t last_err_emit_ms;
    char last_error[96];
} env_rt_t;

static SemaphoreHandle_t s_mutex = NULL;
static env_ws_event_cb_t s_ws_cb = NULL;
static bool s_storage_ready = false;
static bool s_ws_dirty = false;
static env_rt_t s_rt;
static env_hist_hdr_t s_hist_hdr;
static int64_t s_last_saved_epoch = 0;

static EXT_RAM_BSS_ATTR env_hist_record_t s_hist_buf[ENV_HIST_MAX_RECORDS];

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000LL;
}

static float round1(float v)
{
    return roundf(v * 10.0f) / 10.0f;
}

static float round2(float v)
{
    return roundf(v * 100.0f) / 100.0f;
}

static void format_mac_str(const uint8_t mac_le[6], char *out, size_t len)
{
    snprintf(out, len, "%02X:%02X:%02X:%02X:%02X:%02X",
             mac_le[5], mac_le[4], mac_le[3], mac_le[2], mac_le[1], mac_le[0]);
}

static const char *model_for_product_id(uint16_t pid)
{
    switch (pid) {
    case 0x55B5:
    case 0x5808:
    case 0x5BEA:
        return "MJWSD06MMC (小米温湿度计 3 mini)";
    case 0x055B:
        return "LYWSD03MMC";
    case 0x01AA:
        return "LYWSDCGQ";
    case 0x045B:
        return "LYWSD02";
    case 0x16E4:
    case 0x2832:
        return "MJWSD05MMC";
    default:
        return "xiaomi.sensor_ht.mini";
    }
}

static esp_err_t reset_hist_file_locked(void)
{
    memset(&s_hist_hdr, 0, sizeof(s_hist_hdr));
    s_hist_hdr.magic = ENV_HIST_MAGIC;
    s_hist_hdr.version = ENV_HIST_VERSION;
    s_last_saved_epoch = 0;

    if (!s_storage_ready) return ESP_ERR_INVALID_STATE;

    FILE *f = fopen(ENV_HIST_PATH, "wb");
    if (!f) {
        ESP_LOGE(TAG, "Failed to create %s", ENV_HIST_PATH);
        return ESP_FAIL;
    }
    size_t w = fwrite(&s_hist_hdr, sizeof(s_hist_hdr), 1, f);
    fflush(f);
    fsync(fileno(f));
    fclose(f);
    return w == 1 ? ESP_OK : ESP_FAIL;
}

static esp_err_t load_history_locked(void)
{
    if (!s_storage_ready) return ESP_ERR_INVALID_STATE;

    FILE *f = fopen(ENV_HIST_PATH, "rb");
    if (!f) {
        return reset_hist_file_locked();
    }

    env_hist_hdr_t hdr;
    size_t n = fread(&hdr, sizeof(hdr), 1, f);
    if (n != 1 || hdr.magic != ENV_HIST_MAGIC || hdr.version != ENV_HIST_VERSION ||
        hdr.head_idx >= ENV_HIST_MAX_RECORDS || hdr.count > ENV_HIST_MAX_RECORDS) {
        fclose(f);
        ESP_LOGW(TAG, "Invalid env history header, reinitializing");
        return reset_hist_file_locked();
    }

    s_hist_hdr = hdr;
    if (hdr.count > 0) {
        size_t to_read = (hdr.count < ENV_HIST_MAX_RECORDS && hdr.head_idx == hdr.count)
                         ? hdr.count
                         : ENV_HIST_MAX_RECORDS;
        size_t read_cnt = fread(s_hist_buf, sizeof(env_hist_record_t), to_read, f);
        if (read_cnt < to_read && hdr.count == ENV_HIST_MAX_RECORDS) {
            ESP_LOGW(TAG, "Truncated env history (%u/%u), adjusting count",
                     (unsigned)read_cnt, (unsigned)to_read);
            s_hist_hdr.count = (uint32_t)read_cnt;
            if (s_hist_hdr.head_idx >= ENV_HIST_MAX_RECORDS) s_hist_hdr.head_idx = 0;
        }
        if (s_hist_hdr.count > 0) {
            uint32_t newest_idx = (s_hist_hdr.head_idx + ENV_HIST_MAX_RECORDS - 1U) % ENV_HIST_MAX_RECORDS;
            s_last_saved_epoch = s_hist_buf[newest_idx].epoch;
        }
    }
    fclose(f);
    ESP_LOGI(TAG, "Loaded %lu env history records", (unsigned long)s_hist_hdr.count);
    return ESP_OK;
}

static void append_hist_record_locked(int64_t epoch, float temp_c, float hum_pct, uint8_t batt, int8_t rssi)
{
    if (!s_storage_ready) return;

    env_hist_record_t rec;
    memset(&rec, 0, sizeof(rec));
    rec.epoch = epoch;
    float tc = temp_c < -40.0f ? -40.0f : (temp_c > 85.0f ? 85.0f : temp_c);
    float hc = hum_pct < 0.0f ? 0.0f : (hum_pct > 100.0f ? 100.0f : hum_pct);
    rec.temp_x100 = (int16_t)lroundf(tc * 100.0f);
    rec.hum_x100 = (uint16_t)lroundf(hc * 100.0f);
    rec.battery = batt;
    rec.rssi = rssi;
    rec.flags = 0x01;

    uint32_t idx = s_hist_hdr.head_idx;
    if (idx >= ENV_HIST_MAX_RECORDS) idx = 0;
    s_hist_buf[idx] = rec;

    FILE *f = fopen(ENV_HIST_PATH, "r+b");
    if (!f) {
        if (reset_hist_file_locked() != ESP_OK) return;
        idx = 0;
        s_hist_buf[0] = rec;
        f = fopen(ENV_HIST_PATH, "r+b");
        if (!f) return;
    }

    long offset = (long)sizeof(env_hist_hdr_t) + (long)idx * (long)sizeof(env_hist_record_t);
    if (fseek(f, offset, SEEK_SET) != 0 || fwrite(&rec, sizeof(rec), 1, f) != 1) {
        fclose(f);
        return;
    }

    s_hist_hdr.head_idx = (idx + 1U) % ENV_HIST_MAX_RECORDS;
    if (s_hist_hdr.count < ENV_HIST_MAX_RECORDS) {
        s_hist_hdr.count++;
    }
    s_last_saved_epoch = epoch;

    if (fseek(f, 0, SEEK_SET) == 0) {
        fwrite(&s_hist_hdr, sizeof(s_hist_hdr), 1, f);
    }
    fflush(f);
    fsync(fileno(f));
    fclose(f);
}

static void parse_mibeacon_objects(const uint8_t *pt, size_t pt_len,
                                   bool *got_temp, float *temp_c,
                                   bool *got_hum, float *hum_pct,
                                   bool *got_batt, uint8_t *batt_pct)
{
    size_t off = 0;
    while (off + 3 <= pt_len) {
        uint16_t obj_id = (uint16_t)pt[off] | ((uint16_t)pt[off + 1] << 8);
        uint8_t obj_len = pt[off + 2];
        size_t next = off + 3 + obj_len;
        if (next > pt_len) break;

        const uint8_t *v = &pt[off + 3];
        switch (obj_id) {
        case 0x1004: // int16 LE * 0.1 C
            if (obj_len == 2) {
                int16_t raw = (int16_t)((uint16_t)v[0] | ((uint16_t)v[1] << 8));
                float t = (float)raw / 10.0f;
                if (t >= -40.0f && t <= 85.0f) {
                    *got_temp = true;
                    *temp_c = t;
                }
            }
            break;

        case 0x1006: // uint16 LE * 0.1 %
            if (obj_len == 2) {
                uint16_t raw = (uint16_t)v[0] | ((uint16_t)v[1] << 8);
                float h = (float)raw / 10.0f;
                if (h >= 0.0f && h <= 100.0f) {
                    *got_hum = true;
                    *hum_pct = h;
                }
            }
            break;

        case 0x100D: // int16 temp + uint16 hum * 0.1
            if (obj_len == 4) {
                int16_t rt = (int16_t)((uint16_t)v[0] | ((uint16_t)v[1] << 8));
                uint16_t rh = (uint16_t)v[2] | ((uint16_t)v[3] << 8);
                float t = (float)rt / 10.0f;
                float h = (float)rh / 10.0f;
                if (t >= -40.0f && t <= 85.0f) {
                    *got_temp = true;
                    *temp_c = t;
                }
                if (h >= 0.0f && h <= 100.0f) {
                    *got_hum = true;
                    *hum_pct = h;
                }
            }
            break;

        case 0x4801: // IEEE-754 LE float Temperature (MJWSD06MMC / MiBeacon v5)
        case 0x4C01: // IEEE-754 LE float Temperature (MiBeacon v5)
            if (obj_len == 4) {
                float t = 0.0f;
                memcpy(&t, v, 4);
                if (isfinite(t) && t >= -40.0f && t <= 85.0f) {
                    *got_temp = true;
                    *temp_c = round2(t);
                }
            }
            break;

        case 0x4808: // IEEE-754 LE float Humidity (MiBeacon v5)
        case 0x4C08: // IEEE-754 LE float Humidity (MiBeacon v5)
            if (obj_len == 4) {
                float h = 0.0f;
                memcpy(&h, v, 4);
                if (isfinite(h) && h >= 0.0f && h <= 100.0f) {
                    *got_hum = true;
                    *hum_pct = round1(h);
                }
            }
            break;

        case 0x4802: // uint8 Humidity % (MJWSD06MMC)
        case 0x4C02: // uint8 Humidity %
            if (obj_len >= 1 && v[0] <= 100) {
                *got_hum = true;
                *hum_pct = (float)v[0];
            }
            break;

        case 0x100A:
        case 0x4C03:
        case 0x4803:
        case 0x4A03: // Battery %
            if (obj_len >= 1 && v[0] <= 100) {
                *got_batt = true;
                *batt_pct = v[0];
            }
            break;

        default:
            ESP_LOGW(TAG, "Unhandled MiBeacon obj 0x%04X len=%u", obj_id, obj_len);
            break;
        }
        off = next;
    }
}

void env_sensor_on_ble_adv(const uint8_t addr_le[6], int8_t rssi, const uint8_t *data, uint8_t len)
{
    if (!s_mutex || !addr_le || !data || len == 0) return;

    cfg_env_t cfg;
    cfg_env_get(&cfg);
    if (!cfg.enabled || memcmp(addr_le, cfg.mac, 6) != 0) return;

    // Locate AD type 0x16 (16-bit Service Data) with UUID 0xFE95 (little-endian: 95 FE)
    const uint8_t *svc = NULL;
    size_t svc_len = 0;
    uint8_t pos = 0;
    while (pos < len) {
        uint8_t field_len = data[pos];
        if (field_len == 0 || pos + 1 + field_len > len) break;
        if (data[pos + 1] == 0x16 && field_len >= 8 &&
            data[pos + 2] == 0x95 && data[pos + 3] == 0xFE) {
            svc = &data[pos + 4];
            svc_len = (size_t)(field_len - 3);
            break;
        }
        pos += (uint8_t)(1 + field_len);
    }
    if (!svc || svc_len < 5) return;

    uint16_t frctrl = (uint16_t)svc[0] | ((uint16_t)svc[1] << 8);
    uint8_t mesh = (uint8_t)((frctrl >> 7) & 1U);
    uint8_t ver = (uint8_t)((frctrl >> 12) & 0x0FU);
    if (mesh != 0 || ver < 2) return;

    uint16_t product_id = (uint16_t)svc[2] | ((uint16_t)svc[3] << 8);
    uint8_t frame_cnt = svc[4];
    size_t idx = 5;

    if ((frctrl >> 4) & 1U) {
        if (svc_len < idx + 6) return;
        if (memcmp(&svc[idx], addr_le, 6) != 0) return;
        idx += 6;
    }
    if ((frctrl >> 5) & 1U) {
        if (svc_len < idx + 1) return;
        uint8_t cap = svc[idx++];
        if (cap & 0x20) {
            if (svc_len < idx + 1) return;
            idx++;
        }
    }

    int64_t ts = now_ms();

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_rt.has_rssi = true;
    s_rt.rssi = rssi;
    s_rt.product_id = product_id;
    s_rt.last_adv_ms = ts;
    s_rt.adv_count++;
    if (ts - s_rt.last_adv_emit_ms >= 2000) {
        s_rt.last_adv_emit_ms = ts;
        s_ws_dirty = true;
    }
    xSemaphoreGive(s_mutex);

    if (!((frctrl >> 6) & 1U)) return; // No object payload

    uint8_t plain[64];
    size_t pt_len = 0;
    bool is_encrypted = ((frctrl >> 3) & 1U) != 0;

    if (is_encrypted) {
        if (!cfg.has_bindkey) {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            if (strcmp(s_rt.last_error, "已收到传感器加密广播，请在下方填写 32 位 Bindkey") != 0) {
                strlcpy(s_rt.last_error, "已收到传感器加密广播，请在下方填写 32 位 Bindkey", sizeof(s_rt.last_error));
                s_ws_dirty = true;
            }
            xSemaphoreGive(s_mutex);
            return;
        }
        if (ver < 4 || svc_len < idx + 10) return;
        size_t ct_len = svc_len - idx - 7;
        if (ct_len < 3 || ct_len > sizeof(plain)) return;

        const uint8_t *ext_cnt = &svc[svc_len - 7];
        uint32_t pkt_cnt = ((uint32_t)ext_cnt[2] << 24) | ((uint32_t)ext_cnt[1] << 16) |
                           ((uint32_t)ext_cnt[0] << 8) | (uint32_t)frame_cnt;

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        bool dup = s_rt.has_last_pkt_cnt && s_rt.last_pkt_cnt == pkt_cnt && (ts - s_rt.last_pkt_ms < 15000);
        xSemaphoreGive(s_mutex);
        if (dup) return;

        uint8_t nonce[12];
        memcpy(nonce, addr_le, 6);        // Reversed MAC (LE)
        memcpy(nonce + 6, &svc[2], 3);    // product_id (LE 2B) + frame_cnt (1B)
        memcpy(nonce + 9, ext_cnt, 3);    // 3-byte extended counter
        const uint8_t aad[1] = { 0x11 };
        const uint8_t *mic = &svc[svc_len - 4];

        mbedtls_ccm_context ccm;
        mbedtls_ccm_init(&ccm);
        int rc = mbedtls_ccm_setkey(&ccm, MBEDTLS_CIPHER_ID_AES, cfg.bindkey, 128);
        if (rc == 0) {
            rc = mbedtls_ccm_auth_decrypt(&ccm, ct_len, nonce, sizeof(nonce),
                                          aad, sizeof(aad), &svc[idx], plain, mic, 4);
        }
        mbedtls_ccm_free(&ccm);

        if (rc != 0) {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            s_rt.decrypt_fail++;
            strlcpy(s_rt.last_error, "AES-CCM 解密失败，请核对 Bindkey 与 MAC", sizeof(s_rt.last_error));
            if (ts - s_rt.last_err_emit_ms > 5000) {
                s_rt.last_err_emit_ms = ts;
                s_ws_dirty = true;
            }
            xSemaphoreGive(s_mutex);
            return;
        }
        pt_len = ct_len;

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_rt.has_last_pkt_cnt = true;
        s_rt.last_pkt_cnt = pkt_cnt;
        s_rt.last_pkt_ms = ts;
        s_rt.decrypt_ok++;
        s_rt.last_error[0] = '\0';
        s_ws_dirty = true;
        xSemaphoreGive(s_mutex);
    } else {
        if (svc_len < idx + 3) return;
        pt_len = svc_len - idx;
        if (pt_len > sizeof(plain)) return;
        memcpy(plain, &svc[idx], pt_len);

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        bool dup = s_rt.has_last_pkt_cnt && s_rt.last_pkt_cnt == frame_cnt && (ts - s_rt.last_pkt_ms < 10000);
        if (!dup) {
            s_rt.has_last_pkt_cnt = true;
            s_rt.last_pkt_cnt = frame_cnt;
            s_rt.last_pkt_ms = ts;
            s_rt.last_error[0] = '\0';
        }
        xSemaphoreGive(s_mutex);
        if (dup) return;
    }

    bool got_t = false, got_h = false, got_b = false;
    float temp_c = 0.0f, hum_pct = 0.0f;
    uint8_t batt_pct = 0;
    parse_mibeacon_objects(plain, pt_len, &got_t, &temp_c, &got_h, &hum_pct, &got_b, &batt_pct);

    if (!got_t && !got_h && !got_b) return;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (got_t) {
        s_rt.has_temp = true;
        s_rt.temp_c = temp_c;
    }
    if (got_h) {
        s_rt.has_hum = true;
        s_rt.humidity = hum_pct;
    }
    if (got_b) {
        s_rt.has_battery = true;
        s_rt.battery_pct = batt_pct;
    }
    s_rt.last_data_ms = ts;
    s_ws_dirty = true;
    xSemaphoreGive(s_mutex);

    ESP_LOGI(TAG, "MiBeacon RX (pid=0x%04X, rssi=%d): T=%.1fC H=%.1f%% B=%u%%",
             product_id, rssi,
             got_t ? temp_c : -99.9f,
             got_h ? hum_pct : -1.0f,
             got_b ? batt_pct : 255);
}

static void eval_comfort(const cfg_env_t *cfg, const env_rt_t *rt,
                         const char **temp_st, const char **hum_st,
                         bool *alert, const char **label)
{
    if (!rt->has_temp) *temp_st = "unknown";
    else if (rt->temp_c < cfg->temp_low) *temp_st = "low";
    else if (rt->temp_c > cfg->temp_high) *temp_st = "high";
    else *temp_st = "ok";

    if (!rt->has_hum) *hum_st = "unknown";
    else if (rt->humidity < cfg->hum_low) *hum_st = "low";
    else if (rt->humidity > cfg->hum_high) *hum_st = "high";
    else *hum_st = "ok";

    bool t_low = strcmp(*temp_st, "low") == 0;
    bool t_high = strcmp(*temp_st, "high") == 0;
    bool h_low = strcmp(*hum_st, "low") == 0;
    bool h_high = strcmp(*hum_st, "high") == 0;
    *alert = t_low || t_high || h_low || h_high;

    if (!rt->has_temp && !rt->has_hum) {
        *label = cfg->enabled ? (cfg->has_bindkey ? "等待广播" : "待填密钥") : "已停用";
        return;
    }
    if (!rt->has_temp || !rt->has_hum) {
        *label = "接收中";
        return;
    }

    if (t_high && h_high) *label = "闷热";
    else if (t_high) *label = "偏热";
    else if (t_low && h_low) *label = "干冷";
    else if (t_low) *label = "偏冷";
    else if (h_high) *label = "偏潮湿";
    else if (h_low) *label = "偏干燥";
    else *label = "舒适";
}

static cJSON *build_state_json_internal(bool include_ws_type)
{
    cfg_env_t cfg;
    cfg_env_get(&cfg);

    env_rt_t rt;
    uint32_t hist_count = 0;
    int64_t last_saved = 0;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    rt = s_rt;
    hist_count = s_hist_hdr.count;
    last_saved = s_last_saved_epoch;
    xSemaphoreGive(s_mutex);

    char mac_str[18];
    format_mac_str(cfg.mac, mac_str, sizeof(mac_str));
    char pid_str[8];
    snprintf(pid_str, sizeof(pid_str), "0x%04X", rt.product_id);

    const char *temp_st = "unknown";
    const char *hum_st = "unknown";
    const char *comfort_lbl = "等待广播";
    bool alert = false;
    eval_comfort(&cfg, &rt, &temp_st, &hum_st, &alert, &comfort_lbl);

    int64_t ts = now_ms();
    int32_t seen_ago_s = (rt.last_data_ms > 0) ? (int32_t)((ts - rt.last_data_ms) / 1000LL) :
                         ((rt.last_adv_ms > 0) ? (int32_t)((ts - rt.last_adv_ms) / 1000LL) : -1);

    cJSON *o = cJSON_CreateObject();
    if (include_ws_type) {
        cJSON_AddStringToObject(o, "type", "env_state");
    }
    cJSON_AddBoolToObject(o, "enabled", cfg.enabled);
    cJSON_AddStringToObject(o, "name", cfg.name);
    cJSON_AddStringToObject(o, "mac", mac_str);
    cJSON_AddBoolToObject(o, "has_bindkey", cfg.has_bindkey);
    cJSON_AddStringToObject(o, "model", model_for_product_id(rt.product_id));
    cJSON_AddStringToObject(o, "product_id", pid_str);
    cJSON_AddBoolToObject(o, "valid", rt.has_temp && rt.has_hum);

    if (rt.has_temp) cJSON_AddNumberToObject(o, "temp_c", round1(rt.temp_c));
    else cJSON_AddNullToObject(o, "temp_c");

    if (rt.has_hum) cJSON_AddNumberToObject(o, "humidity", round1(rt.humidity));
    else cJSON_AddNullToObject(o, "humidity");

    if (rt.has_battery) cJSON_AddNumberToObject(o, "battery_pct", rt.battery_pct);
    else cJSON_AddNullToObject(o, "battery_pct");

    if (rt.has_rssi) cJSON_AddNumberToObject(o, "rssi", rt.rssi);
    else cJSON_AddNullToObject(o, "rssi");

    cJSON_AddNumberToObject(o, "seen_ago_s", seen_ago_s);
    cJSON_AddNumberToObject(o, "adv_count", rt.adv_count);
    cJSON_AddNumberToObject(o, "decrypt_ok", rt.decrypt_ok);
    cJSON_AddNumberToObject(o, "decrypt_fail", rt.decrypt_fail);
    cJSON_AddStringToObject(o, "last_error", rt.last_error);

    cJSON *th = cJSON_CreateObject();
    cJSON_AddNumberToObject(th, "temp_low", round1(cfg.temp_low));
    cJSON_AddNumberToObject(th, "temp_high", round1(cfg.temp_high));
    cJSON_AddNumberToObject(th, "hum_low", round1(cfg.hum_low));
    cJSON_AddNumberToObject(th, "hum_high", round1(cfg.hum_high));
    cJSON_AddItemToObject(o, "thresholds", th);

    cJSON *cm = cJSON_CreateObject();
    cJSON_AddStringToObject(cm, "temp_status", temp_st);
    cJSON_AddStringToObject(cm, "hum_status", hum_st);
    cJSON_AddBoolToObject(cm, "alert", alert);
    cJSON_AddStringToObject(cm, "label", comfort_lbl);
    cJSON_AddItemToObject(o, "comfort", cm);

    cJSON *hi = cJSON_CreateObject();
    cJSON_AddBoolToObject(hi, "storage_ready", s_storage_ready);
    cJSON_AddBoolToObject(hi, "time_synced", wifi_mgr_is_time_synced());
    cJSON_AddNumberToObject(hi, "count", hist_count);
    cJSON_AddNumberToObject(hi, "max_records", ENV_HIST_MAX_RECORDS);
    cJSON_AddNumberToObject(hi, "last_saved_epoch", (double)last_saved);
    cJSON_AddItemToObject(o, "history", hi);

    return o;
}

cJSON *env_sensor_build_state_json(void)
{
    return build_state_json_internal(false);
}

cJSON *env_sensor_build_history_json(const char *range_str)
{
    const char *rng = "24h";
    int64_t window_s = 86400;
    int64_t bucket_s = 300;
    if (range_str && strcmp(range_str, "7d") == 0) {
        rng = "7d";
        window_s = 7LL * 86400LL;
        bucket_s = 1800;
    } else if (range_str && strcmp(range_str, "30d") == 0) {
        rng = "30d";
        window_s = 30LL * 86400LL;
        bucket_s = 7200;
    }

    bool synced = wifi_mgr_is_time_synced();
    int64_t now_ep = synced ? (int64_t)time(NULL) : 0;
    int64_t cutoff = synced ? (now_ep - window_s) : 0;

    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "range", rng);
    cJSON_AddBoolToObject(o, "time_synced", synced);
    cJSON_AddNumberToObject(o, "now", (double)now_ep);
    cJSON *pts = cJSON_CreateArray();
    cJSON *stats = cJSON_CreateObject();

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    uint32_t cnt = s_hist_hdr.count;
    uint32_t start = (cnt == ENV_HIST_MAX_RECORDS) ? s_hist_hdr.head_idx : 0;

    bool has_stats = false;
    float t_min = 999.0f, t_max = -999.0f, t_sum = 0.0f;
    float h_min = 999.0f, h_max = -999.0f, h_sum = 0.0f;
    uint32_t sample_cnt = 0;

    int64_t cur_bucket = -1;
    double b_t_sum = 0.0, b_h_sum = 0.0;
    uint32_t b_n = 0;

    for (uint32_t i = 0; i < cnt; i++) {
        uint32_t idx = (start + i) % ENV_HIST_MAX_RECORDS;
        const env_hist_record_t *r = &s_hist_buf[idx];
        if (synced && (r->epoch < cutoff || r->epoch > now_ep + 120)) continue;

        float tc = (float)r->temp_x100 / 100.0f;
        float hc = (float)r->hum_x100 / 100.0f;

        if (!has_stats) {
            t_min = t_max = tc;
            h_min = h_max = hc;
            has_stats = true;
        } else {
            if (tc < t_min) t_min = tc;
            if (tc > t_max) t_max = tc;
            if (hc < h_min) h_min = hc;
            if (hc > h_max) h_max = hc;
        }
        t_sum += tc;
        h_sum += hc;
        sample_cnt++;

        int64_t b = r->epoch / bucket_s;
        if (b != cur_bucket) {
            if (b_n > 0) {
                cJSON *pt = cJSON_CreateArray();
                cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)(cur_bucket * bucket_s)));
                cJSON_AddItemToArray(pt, cJSON_CreateNumber(round1((float)(b_t_sum / b_n))));
                cJSON_AddItemToArray(pt, cJSON_CreateNumber(round1((float)(b_h_sum / b_n))));
                cJSON_AddItemToArray(pts, pt);
            }
            cur_bucket = b;
            b_t_sum = tc;
            b_h_sum = hc;
            b_n = 1;
        } else {
            b_t_sum += tc;
            b_h_sum += hc;
            b_n++;
        }
    }
    if (b_n > 0) {
        cJSON *pt = cJSON_CreateArray();
        cJSON_AddItemToArray(pt, cJSON_CreateNumber((double)(cur_bucket * bucket_s)));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber(round1((float)(b_t_sum / b_n))));
        cJSON_AddItemToArray(pt, cJSON_CreateNumber(round1((float)(b_h_sum / b_n))));
        cJSON_AddItemToArray(pts, pt);
    }
    xSemaphoreGive(s_mutex);

    cJSON_AddNumberToObject(o, "count", sample_cnt);
    if (has_stats && sample_cnt > 0) {
        cJSON_AddNumberToObject(stats, "temp_min", round1(t_min));
        cJSON_AddNumberToObject(stats, "temp_max", round1(t_max));
        cJSON_AddNumberToObject(stats, "temp_avg", round1(t_sum / sample_cnt));
        cJSON_AddNumberToObject(stats, "hum_min", round1(h_min));
        cJSON_AddNumberToObject(stats, "hum_max", round1(h_max));
        cJSON_AddNumberToObject(stats, "hum_avg", round1(h_sum / sample_cnt));
    } else {
        cJSON_AddNullToObject(stats, "temp_min");
        cJSON_AddNullToObject(stats, "temp_max");
        cJSON_AddNullToObject(stats, "temp_avg");
        cJSON_AddNullToObject(stats, "hum_min");
        cJSON_AddNullToObject(stats, "hum_max");
        cJSON_AddNullToObject(stats, "hum_avg");
    }

    cJSON_AddItemToObject(o, "stats", stats);
    cJSON_AddItemToObject(o, "points", pts);
    return o;
}

esp_err_t env_sensor_clear_history(void)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    esp_err_t err = reset_hist_file_locked();
    s_ws_dirty = true;
    xSemaphoreGive(s_mutex);
    return err;
}

cJSON *env_sensor_build_siri_json(void)
{
    cfg_env_t cfg;
    cfg_env_get(&cfg);

    env_rt_t rt;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    rt = s_rt;
    xSemaphoreGive(s_mutex);

    const char *temp_st = "unknown";
    const char *hum_st = "unknown";
    const char *comfort_lbl = "等待数据";
    bool alert = false;
    eval_comfort(&cfg, &rt, &temp_st, &hum_st, &alert, &comfort_lbl);

    bool valid = rt.has_temp && rt.has_hum;
    int32_t stale_s = (rt.last_data_ms > 0) ? (int32_t)((now_ms() - rt.last_data_ms) / 1000LL) : -1;

    char msg[160];
    if (!cfg.enabled) {
        snprintf(msg, sizeof(msg), "室内环境监测当前已停用");
    } else if (!valid) {
        snprintf(msg, sizeof(msg), "暂未收到小米温湿度计的传感器数据");
    } else if (stale_s > 1800) {
        int mins = stale_s / 60;
        snprintf(msg, sizeof(msg), "当前室温 %.1f 度，湿度 %.1f%%，体感%s（%d 分钟前更新）",
                 round1(rt.temp_c), round1(rt.humidity), comfort_lbl, mins);
    } else {
        snprintf(msg, sizeof(msg), "当前室温 %.1f 度，湿度 %.1f%%，体感%s",
                 round1(rt.temp_c), round1(rt.humidity), comfort_lbl);
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddBoolToObject(o, "valid", valid);
    if (rt.has_temp) cJSON_AddNumberToObject(o, "temp_c", round1(rt.temp_c));
    else cJSON_AddNullToObject(o, "temp_c");
    if (rt.has_hum) cJSON_AddNumberToObject(o, "humidity", round1(rt.humidity));
    else cJSON_AddNullToObject(o, "humidity");
    if (rt.has_battery) cJSON_AddNumberToObject(o, "battery_pct", rt.battery_pct);
    else cJSON_AddNullToObject(o, "battery_pct");
    cJSON_AddStringToObject(o, "comfort", comfort_lbl);
    cJSON_AddBoolToObject(o, "alert", alert);
    cJSON_AddNumberToObject(o, "stale_s", stale_s);
    cJSON_AddStringToObject(o, "message", msg);
    return o;
}

void env_sensor_reload_config(void)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_rt.has_last_pkt_cnt = false;
    s_rt.last_error[0] = '\0';
    s_ws_dirty = true;
    xSemaphoreGive(s_mutex);
}

void env_sensor_set_ws_cb(env_ws_event_cb_t cb)
{
    s_ws_cb = cb;
}

static void env_task(void *arg)
{
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(2000));

        bool do_ws = false;
        bool need_save = false;
        int64_t save_epoch = 0;
        float save_t = 0.0f, save_h = 0.0f;
        uint8_t save_b = 0;
        int8_t save_r = -127;

        int64_t t_ms = now_ms();
        bool synced = wifi_mgr_is_time_synced();
        int64_t cur_epoch = synced ? (int64_t)time(NULL) : 0;

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        if (s_ws_dirty) {
            s_ws_dirty = false;
            do_ws = true;
        }
        if (s_storage_ready && synced && s_rt.has_temp && s_rt.has_hum &&
            s_rt.last_data_ms > 0 && (t_ms - s_rt.last_data_ms) < ENV_STALE_SAVE_MS &&
            (s_hist_hdr.count == 0 || (cur_epoch - s_last_saved_epoch >= ENV_SAVE_INTERVAL_S))) {
            need_save = true;
            save_epoch = cur_epoch;
            save_t = s_rt.temp_c;
            save_h = s_rt.humidity;
            save_b = s_rt.has_battery ? s_rt.battery_pct : 0;
            save_r = s_rt.has_rssi ? s_rt.rssi : -127;
        }
        if (need_save) {
            append_hist_record_locked(save_epoch, save_t, save_h, save_b, save_r);
            do_ws = true;
        }
        xSemaphoreGive(s_mutex);

        if (do_ws && s_ws_cb) {
            cJSON *st = build_state_json_internal(true);
            if (st) {
                char *str = cJSON_PrintUnformatted(st);
                cJSON_Delete(st);
                if (str) {
                    s_ws_cb(str);
                    cJSON_free(str);
                }
            }
        }
    }
}

esp_err_t env_sensor_init(bool storage_ready)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    s_storage_ready = storage_ready;
    memset(&s_rt, 0, sizeof(s_rt));
    memset(&s_hist_hdr, 0, sizeof(s_hist_hdr));
    s_last_saved_epoch = 0;

    if (s_storage_ready) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        load_history_locked();
        xSemaphoreGive(s_mutex);
    }

    xTaskCreate(env_task, "env_task", 4096, NULL, 3, NULL);
    ESP_LOGI(TAG, "Environment sensor module initialized");
    return ESP_OK;
}
