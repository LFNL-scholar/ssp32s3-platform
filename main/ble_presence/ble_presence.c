#include "ble_presence.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "mbedtls/aes.h"
#include "cJSON.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_store.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "cfg_store.h"
#include "led_ctrl.h"
#include "presence_log.h"
#include "wifi_mgr.h"

extern void ble_store_config_init(void);

static const char *TAG = "ble_presence";

#define RPA_CACHE_SIZE 32
#define RPA_TTL_MS     (15 * 60 * 1000)

typedef struct {
    bool valid;
    uint8_t rpa[6];
    uint8_t device_id;
    int64_t expires_ms;
} rpa_cache_entry_t;

typedef struct {
    uint8_t device_id;
    bool has_seen;
    bool is_home;
    float smoothed_rssi;
    int8_t raw_rssi;
    int64_t last_seen_ms;
    int64_t below_exit_since_ms;
} dev_rt_state_t;

typedef struct {
    uint8_t person_id;
    bool is_home;
} person_rt_state_t;

typedef struct {
    bool used;
    uint8_t mac[6];
    uint8_t addr_type;
    char name[32];
    int8_t rssi;
    int64_t last_seen_ms;
} nearby_slot_t;

static SemaphoreHandle_t s_mutex = NULL;
static ble_ws_event_cb_t s_ws_cb = NULL;
static ble_home_count_cb_t s_home_cb = NULL;

static uint8_t s_own_addr_type = BLE_OWN_ADDR_PUBLIC;
static bool s_host_synced = false;
static int s_pause_depth = 0;
static bool s_scanning = false;

static dev_rt_state_t s_dev_rt[CFG_MAX_DEVICES];
static person_rt_state_t s_person_rt[CFG_MAX_PERSONS];
static rpa_cache_entry_t s_rpa_cache[RPA_CACHE_SIZE];
static nearby_slot_t s_nearby[BLE_NEARBY_MAX];

// Pairing session state
static bool s_pairing_active = false;
static uint8_t s_pair_person_id = 0;
static char s_pair_label[32] = {0};
static int64_t s_pair_deadline_ms = 0;
static uint16_t s_pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;

// Standard HID Service (0x1812) with encrypted read characteristic:
// Required so iOS Settings -> Bluetooth lists the device and triggers SMP bonding + IRK exchange.
static const ble_uuid16_t s_hid_svc_uuid = BLE_UUID16_INIT(0x1812);
static const ble_uuid16_t s_hid_info_chr_uuid = BLE_UUID16_INIT(0x2A4A);
static const ble_uuid128_t s_svc_uuid =
    BLE_UUID128_INIT(0x9b, 0x32, 0x7a, 0x10, 0x55, 0x01, 0x4b, 0x99, 0xa2, 0x11, 0x45, 0x53, 0x50, 0x33, 0x32, 0x00);
static const ble_uuid128_t s_chr_uuid =
    BLE_UUID128_INIT(0x9b, 0x32, 0x7a, 0x10, 0x55, 0x01, 0x4b, 0x99, 0xa2, 0x11, 0x45, 0x53, 0x50, 0x33, 0x32, 0x01);

static int gatt_hid_info_access(uint16_t conn_handle, uint16_t attr_handle,
                                struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    // bcdHID=0x0111, bCountryCode=0x00, Flags=0x02 (NormallyConnectable)
    static const uint8_t hid_info[4] = {0x11, 0x01, 0x00, 0x02};
    int rc = os_mbuf_append(ctxt->om, hid_info, sizeof(hid_info));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static int gatt_chr_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    static const char *msg = "SSP32S3";
    int rc = os_mbuf_append(ctxt->om, msg, strlen(msg));
    return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
}

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_hid_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &s_hid_info_chr_uuid.u,
                .access_cb = gatt_hid_info_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC,
            },
            { 0 }
        },
    },
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &s_chr_uuid.u,
                .access_cb = gatt_chr_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC,
            },
            { 0 }
        },
    },
    { 0 }
};

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000LL;
}

static void emit_ws_json(cJSON *obj)
{
    if (!obj) return;
    if (s_ws_cb) {
        char *str = cJSON_PrintUnformatted(obj);
        if (str) {
            s_ws_cb(str);
            cJSON_free(str);
        }
    }
    cJSON_Delete(obj);
}

static void emit_pair_result(const char *status, uint8_t device_id, const char *label, const char *reason)
{
    cJSON *obj = cJSON_CreateObject();
    cJSON_AddStringToObject(obj, "type", "pair_result");
    cJSON_AddStringToObject(obj, "status", status);
    if (device_id > 0) cJSON_AddNumberToObject(obj, "device_id", device_id);
    if (label) cJSON_AddStringToObject(obj, "label", label);
    if (reason) cJSON_AddStringToObject(obj, "reason", reason);
    emit_ws_json(obj);
}

static void emit_presence_event(const char *ev_name, uint8_t person_id, const char *person_name,
                                const char *dev_label, int8_t rssi)
{
    cJSON *obj = cJSON_CreateObject();
    cJSON_AddStringToObject(obj, "type", "presence_event");
    cJSON_AddStringToObject(obj, "event", ev_name);
    cJSON_AddNumberToObject(obj, "person_id", person_id);
    cJSON_AddStringToObject(obj, "person_name", person_name ? person_name : "");
    cJSON_AddStringToObject(obj, "device", dev_label ? dev_label : "");
    cJSON_AddNumberToObject(obj, "rssi", rssi);
    cJSON_AddNumberToObject(obj, "epoch", wifi_mgr_is_time_synced() ? (double)time(NULL) : 0);
    emit_ws_json(obj);
}

static dev_rt_state_t *find_dev_rt(uint8_t device_id, bool create)
{
    int free_idx = -1;
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_dev_rt[i].device_id == device_id) return &s_dev_rt[i];
        if (s_dev_rt[i].device_id == 0 && free_idx < 0) free_idx = i;
    }
    if (create && free_idx >= 0) {
        memset(&s_dev_rt[free_idx], 0, sizeof(dev_rt_state_t));
        s_dev_rt[free_idx].device_id = device_id;
        return &s_dev_rt[free_idx];
    }
    return NULL;
}

static person_rt_state_t *find_person_rt(uint8_t person_id, bool create)
{
    int free_idx = -1;
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_person_rt[i].person_id == person_id) return &s_person_rt[i];
        if (s_person_rt[i].person_id == 0 && free_idx < 0) free_idx = i;
    }
    if (create && free_idx >= 0) {
        memset(&s_person_rt[free_idx], 0, sizeof(person_rt_state_t));
        s_person_rt[free_idx].person_id = person_id;
        return &s_person_rt[free_idx];
    }
    return NULL;
}

// BLE Core Spec Vol 3 Part H 2.2.2: ah(k, r)
static bool rpa_matches_irk(const uint8_t rpa_le[6], const uint8_t irk_le[16])
{
    uint8_t key_be[16];
    for (int i = 0; i < 16; i++) {
        key_be[i] = irk_le[15 - i];
    }

    uint8_t plain_be[16] = {0};
    plain_be[13] = rpa_le[5];
    plain_be[14] = rpa_le[4];
    plain_be[15] = rpa_le[3];

    uint8_t out_be[16];
    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key_be, 128);
    mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, plain_be, out_be);
    mbedtls_aes_free(&aes);

    return (out_be[13] == rpa_le[2] && out_be[14] == rpa_le[1] && out_be[15] == rpa_le[0]);
}

static uint8_t match_tracked_device_locked(const ble_addr_t *addr, int64_t ts_ms)
{
    static cfg_device_t devs[CFG_MAX_DEVICES];
    size_t dev_cnt = cfg_devices_list(devs, CFG_MAX_DEVICES);
    if (dev_cnt == 0) return 0;

    // 1. Direct MAC match:
    //    - MATCH_FIXED_MAC: fixed public/static MAC
    //    - MATCH_IRK: also match when NimBLE's hardware controller resolving list
    //      already resolved the peer's RPA into its identity address (PUBLIC_ID / RANDOM_ID)
    for (size_t i = 0; i < dev_cnt; i++) {
        if ((devs[i].match_type == MATCH_FIXED_MAC || devs[i].match_type == MATCH_IRK) &&
            memcmp(devs[i].mac, addr->val, 6) == 0) {
            return devs[i].id;
        }
    }

    // 2. Software RPA match against stored IRKs (fallback when not resolved by controller)
    bool is_rpa = (addr->type == BLE_ADDR_RANDOM && (addr->val[5] & 0xC0) == 0x40);
    if (!is_rpa) return 0;

    // Check RPA cache first
    int empty_slot = -1;
    int oldest_slot = 0;
    int64_t oldest_exp = INT64_MAX;
    for (int i = 0; i < RPA_CACHE_SIZE; i++) {
        if (s_rpa_cache[i].valid) {
            if (s_rpa_cache[i].expires_ms <= ts_ms) {
                s_rpa_cache[i].valid = false;
                if (empty_slot < 0) empty_slot = i;
            } else if (memcmp(s_rpa_cache[i].rpa, addr->val, 6) == 0) {
                return s_rpa_cache[i].device_id;
            } else if (s_rpa_cache[i].expires_ms < oldest_exp) {
                oldest_exp = s_rpa_cache[i].expires_ms;
                oldest_slot = i;
            }
        } else if (empty_slot < 0) {
            empty_slot = i;
        }
    }

    for (size_t i = 0; i < dev_cnt; i++) {
        if (devs[i].match_type == MATCH_IRK && rpa_matches_irk(addr->val, devs[i].irk)) {
            int slot = (empty_slot >= 0) ? empty_slot : oldest_slot;
            s_rpa_cache[slot].valid = true;
            memcpy(s_rpa_cache[slot].rpa, addr->val, 6);
            s_rpa_cache[slot].device_id = devs[i].id;
            s_rpa_cache[slot].expires_ms = ts_ms + RPA_TTL_MS;
            return devs[i].id;
        }
    }

    return 0;
}

static void parse_adv_name(const uint8_t *data, uint8_t len, char *out_name, size_t max_len)
{
    out_name[0] = '\0';
    uint8_t pos = 0;
    while (pos < len) {
        uint8_t field_len = data[pos];
        if (field_len == 0 || pos + 1 + field_len > len) break;
        uint8_t type = data[pos + 1];
        if (type == BLE_HS_ADV_TYPE_COMP_NAME || type == BLE_HS_ADV_TYPE_INCOMP_NAME) {
            size_t copy_len = field_len - 1;
            if (copy_len >= max_len) copy_len = max_len - 1;
            memcpy(out_name, &data[pos + 2], copy_len);
            out_name[copy_len] = '\0';
            if (type == BLE_HS_ADV_TYPE_COMP_NAME) return;
        }
        pos += 1 + field_len;
    }
}

static void update_nearby_locked(const ble_addr_t *addr, int8_t rssi, const char *name, int64_t ts_ms)
{
    int match = -1;
    int empty = -1;
    int oldest = 0;
    int64_t oldest_ts = INT64_MAX;

    for (int i = 0; i < BLE_NEARBY_MAX; i++) {
        if (!s_nearby[i].used) {
            if (empty < 0) empty = i;
            continue;
        }
        if (ts_ms - s_nearby[i].last_seen_ms > 30000) {
            s_nearby[i].used = false;
            if (empty < 0) empty = i;
            continue;
        }
        if (memcmp(s_nearby[i].mac, addr->val, 6) == 0 && s_nearby[i].addr_type == addr->type) {
            match = i;
            break;
        }
        if (s_nearby[i].last_seen_ms < oldest_ts) {
            oldest_ts = s_nearby[i].last_seen_ms;
            oldest = i;
        }
    }

    int slot = (match >= 0) ? match : (empty >= 0 ? empty : oldest);
    s_nearby[slot].used = true;
    memcpy(s_nearby[slot].mac, addr->val, 6);
    s_nearby[slot].addr_type = addr->type;
    s_nearby[slot].rssi = rssi;
    s_nearby[slot].last_seen_ms = ts_ms;
    if (name && name[0] != '\0') {
        strlcpy(s_nearby[slot].name, name, sizeof(s_nearby[slot].name));
    } else if (match < 0) {
        s_nearby[slot].name[0] = '\0';
    }
}

static int gap_event_cb(struct ble_gap_event *event, void *arg);

static void start_scan_if_allowed(void)
{
    if (!s_host_synced || s_pause_depth > 0 || s_pairing_active || s_scanning) return;

    struct ble_gap_disc_params params = {
        .itvl = 160,  // 100ms
        .window = 48, // 30ms (~30% duty cycle for Wi-Fi coexistence)
        .filter_policy = BLE_HCI_SCAN_FILT_NO_WL,
        .limited = 0,
        .passive = 1,
        .filter_duplicates = 0,
    };

    int rc = ble_gap_disc(s_own_addr_type, BLE_HS_FOREVER, &params, gap_event_cb, NULL);
    if (rc == 0) {
        s_scanning = true;
    } else if (rc != BLE_HS_EALREADY) {
        ESP_LOGW(TAG, "ble_gap_disc failed: %d", rc);
    }
}

static void stop_scan_if_running(void)
{
    if (s_scanning) {
        ble_gap_disc_cancel();
        s_scanning = false;
    }
}

static void finish_pairing_locked(const char *status, uint8_t dev_id, const char *reason)
{
    char label_copy[32];
    strlcpy(label_copy, s_pair_label, sizeof(label_copy));
    s_pairing_active = false;
    s_pair_person_id = 0;
    s_pair_label[0] = '\0';
    s_pair_deadline_ms = 0;
    uint16_t ch = s_pair_conn_handle;
    s_pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;

    ble_gap_adv_stop();
    if (ch != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(ch, BLE_ERR_REM_USER_CONN_TERM);
    }
    led_ctrl_set_flag(LED_FLAG_BLE_PAIRING, false);
    start_scan_if_allowed();

    emit_pair_result(status, dev_id, label_copy, reason);
}

static int gap_event_cb(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
    case BLE_GAP_EVENT_DISC: {
        int64_t ts = now_ms();
        char adv_name[32] = {0};
        if (event->disc.length_data > 0 && event->disc.data) {
            parse_adv_name(event->disc.data, event->disc.length_data, adv_name, sizeof(adv_name));
        }

        xSemaphoreTake(s_mutex, portMAX_DELAY);
        update_nearby_locked(&event->disc.addr, event->disc.rssi, adv_name, ts);
        uint8_t dev_id = match_tracked_device_locked(&event->disc.addr, ts);
        if (dev_id > 0) {
            dev_rt_state_t *rt = find_dev_rt(dev_id, true);
            if (rt) {
                int8_t raw = event->disc.rssi;
                rt->raw_rssi = raw;
                if (!rt->has_seen) {
                    rt->smoothed_rssi = (float)raw;
                    rt->has_seen = true;
                } else {
                    rt->smoothed_rssi = 0.3f * (float)raw + 0.7f * rt->smoothed_rssi;
                }
                rt->last_seen_ms = ts;
            }
        }
        xSemaphoreGive(s_mutex);
        break;
    }

    case BLE_GAP_EVENT_DISC_COMPLETE:
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_scanning = false;
        start_scan_if_allowed();
        xSemaphoreGive(s_mutex);
        break;

    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            if (!s_pairing_active) {
                xSemaphoreGive(s_mutex);
                ble_gap_terminate(event->connect.conn_handle, BLE_ERR_REM_USER_CONN_TERM);
                break;
            }
            s_pair_conn_handle = event->connect.conn_handle;
            xSemaphoreGive(s_mutex);
            ESP_LOGI(TAG, "Pairing peer connected (handle=%u), initiating security", event->connect.conn_handle);
            ble_gap_security_initiate(event->connect.conn_handle);
        } else {
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            if (s_pairing_active) {
                // Restart advertising if still within deadline
                struct ble_gap_adv_params adv_params = {
                    .conn_mode = BLE_GAP_CONN_MODE_UND,
                    .disc_mode = BLE_GAP_DISC_MODE_GEN,
                };
                ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event_cb, NULL);
            }
            xSemaphoreGive(s_mutex);
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        if (s_pair_conn_handle == event->disconnect.conn.conn_handle) {
            s_pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        }
        if (s_pairing_active) {
            struct ble_gap_adv_params adv_params = {
                .conn_mode = BLE_GAP_CONN_MODE_UND,
                .disc_mode = BLE_GAP_DISC_MODE_GEN,
                .itvl_min = 32,
                .itvl_max = 64,
            };
            ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event_cb, NULL);
        } else {
            start_scan_if_allowed();
        }
        xSemaphoreGive(s_mutex);
        break;

    case BLE_GAP_EVENT_REPEAT_PAIRING: {
        struct ble_gap_conn_desc desc;
        if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
            ble_store_util_delete_peer(&desc.peer_id_addr);
        }
        return BLE_GAP_REPEAT_PAIRING_RETRY;
    }

    case BLE_GAP_EVENT_ENC_CHANGE:
        if (event->enc_change.status == 0) {
            struct ble_gap_conn_desc desc;
            if (ble_gap_conn_find(event->enc_change.conn_handle, &desc) == 0) {
                struct ble_store_key_sec key_sec = {0};
                key_sec.peer_addr = desc.peer_id_addr;
                key_sec.idx = 0;
                struct ble_store_value_sec val_sec = {0};
                int rc = ble_store_read_peer_sec(&key_sec, &val_sec);

                xSemaphoreTake(s_mutex, portMAX_DELAY);
                if (s_pairing_active) {
                    if (rc == 0 && val_sec.irk_present) {
                        cfg_device_t dev_in = {0};
                        dev_in.person_id = s_pair_person_id;
                        strlcpy(dev_in.label, s_pair_label, sizeof(dev_in.label));
                        dev_in.match_type = MATCH_IRK;
                        memcpy(dev_in.irk, val_sec.irk, 16);
                        memcpy(dev_in.mac, desc.peer_id_addr.val, 6);
                        dev_in.peer_addr_type = desc.peer_id_addr.type;
                        dev_in.enter_rssi = -75;
                        dev_in.exit_rssi = -85;
                        dev_in.away_timeout_s = 120;

                        cfg_device_t saved = {0};
                        esp_err_t err = cfg_device_add(&dev_in, &saved);
                        if (err == ESP_OK) {
                            ESP_LOGI(TAG, "Paired IRK device id=%u (%s)", saved.id, saved.label);
                            memset(s_rpa_cache, 0, sizeof(s_rpa_cache));
                            finish_pairing_locked("success", saved.id, NULL);
                        } else {
                            finish_pairing_locked("error", 0, "保存设备失败（数量上限或人员不存在）");
                        }
                    } else {
                        ESP_LOGW(TAG, "Peer bonded without IRK (rc=%d, irk_present=%d)", rc, val_sec.irk_present);
                        finish_pairing_locked("error", 0, "对端设备未提供 IRK 密钥");
                    }
                }
                xSemaphoreGive(s_mutex);
            }
        } else {
            ESP_LOGW(TAG, "BLE pairing encryption failed: %d", event->enc_change.status);
            xSemaphoreTake(s_mutex, portMAX_DELAY);
            if (s_pairing_active) {
                finish_pairing_locked("error", 0, "蓝牙配对加密失败");
            }
            xSemaphoreGive(s_mutex);
        }
        break;

    default:
        break;
    }
    return 0;
}

static void ble_host_on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_hs_id_infer_auto failed: %d", rc);
        return;
    }
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_host_synced = true;
    start_scan_if_allowed();
    xSemaphoreGive(s_mutex);
    ESP_LOGI(TAG, "NimBLE synced, scanning started");
}

static void ble_host_on_reset(int reason)
{
    ESP_LOGW(TAG, "NimBLE reset, reason=%d", reason);
}

static void nimble_host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void presence_eval_task(void *arg)
{
    int prev_home_persons = 0;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        int64_t ts = now_ms();

        xSemaphoreTake(s_mutex, portMAX_DELAY);

        // Check pairing timeout
        if (s_pairing_active && ts >= s_pair_deadline_ms) {
            ESP_LOGW(TAG, "BLE pairing timed out");
            finish_pairing_locked("timeout", 0, "配对超时，请重试");
        }

        static cfg_device_t devs[CFG_MAX_DEVICES];
        size_t dev_cnt = cfg_devices_list(devs, CFG_MAX_DEVICES);

        // Evaluate per-device hysteresis state machine
        for (size_t i = 0; i < dev_cnt; i++) {
            dev_rt_state_t *rt = find_dev_rt(devs[i].id, true);
            if (!rt || !rt->has_seen) continue;

            int64_t unseen_ms = ts - rt->last_seen_ms;
            int8_t smoothed = (int8_t)(rt->smoothed_rssi + (rt->smoothed_rssi >= 0 ? 0.5f : -0.5f));

            if (!rt->is_home) {
                if (unseen_ms < 5000 && smoothed >= devs[i].enter_rssi) {
                    rt->is_home = true;
                    rt->below_exit_since_ms = 0;
                }
            } else {
                int64_t away_ms = (int64_t)devs[i].away_timeout_s * 1000LL;
                int64_t hyst_s = devs[i].away_timeout_s < 30 ? devs[i].away_timeout_s : 30;
                int64_t hyst_ms = hyst_s * 1000LL;

                if (unseen_ms >= away_ms) {
                    rt->is_home = false;
                    rt->below_exit_since_ms = 0;
                } else if (smoothed < devs[i].exit_rssi) {
                    if (rt->below_exit_since_ms == 0) {
                        rt->below_exit_since_ms = ts;
                    } else if (ts - rt->below_exit_since_ms >= hyst_ms) {
                        rt->is_home = false;
                        rt->below_exit_since_ms = 0;
                    }
                } else {
                    rt->below_exit_since_ms = 0;
                }
            }
        }

        // Aggregate per-person state & emit events
        static cfg_person_t persons[CFG_MAX_PERSONS];
        size_t person_cnt = cfg_persons_list(persons, CFG_MAX_PERSONS);
        int home_persons = 0;

        for (size_t p = 0; p < person_cnt; p++) {
            bool any_home = false;
            const char *trigger_dev = "";
            int8_t trigger_rssi = -127;
            int64_t latest_dev_ts = -1;

            for (size_t d = 0; d < dev_cnt; d++) {
                if (devs[d].person_id != persons[p].id) continue;
                dev_rt_state_t *rt = find_dev_rt(devs[d].id, false);
                if (rt && rt->is_home) {
                    any_home = true;
                    trigger_dev = devs[d].label;
                    trigger_rssi = (int8_t)rt->smoothed_rssi;
                    break;
                }
                if (rt && rt->has_seen && rt->last_seen_ms > latest_dev_ts) {
                    latest_dev_ts = rt->last_seen_ms;
                    trigger_dev = devs[d].label;
                    trigger_rssi = (int8_t)rt->smoothed_rssi;
                }
            }

            if (any_home) home_persons++;

            person_rt_state_t *prt = find_person_rt(persons[p].id, true);
            if (prt && prt->is_home != any_home) {
                prt->is_home = any_home;
                bool synced = wifi_mgr_is_time_synced();
                presence_event_type_t ev_type = any_home ? PRESENCE_EVENT_ARRIVE : PRESENCE_EVENT_LEAVE;
                const char *ev_str = any_home ? "ARRIVE" : "LEAVE";

                presence_log_append(persons[p].id, persons[p].name, ev_type, trigger_dev, trigger_rssi, synced);
                emit_presence_event(ev_str, persons[p].id, persons[p].name, trigger_dev, trigger_rssi);
                ESP_LOGI(TAG, "Presence event: %s %s (via %s, rssi=%d)",
                         persons[p].name, ev_str, trigger_dev, trigger_rssi);
            }
        }

        led_ctrl_set_home_count(home_persons);
        int old_home = prev_home_persons;
        prev_home_persons = home_persons;
        xSemaphoreGive(s_mutex);

        if (s_home_cb && old_home != home_persons) {
            s_home_cb(old_home, home_persons);
        }
    }
}

void ble_presence_set_ws_cb(ble_ws_event_cb_t cb)
{
    s_ws_cb = cb;
}

void ble_presence_set_home_count_cb(ble_home_count_cb_t cb)
{
    s_home_cb = cb;
}

esp_err_t ble_presence_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed: %s", esp_err_to_name(err));
        return err;
    }

    ble_hs_cfg.reset_cb = ble_host_on_reset;
    ble_hs_cfg.sync_cb = ble_host_on_sync;
    ble_hs_cfg.sm_io_cap = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding = 1;
    ble_hs_cfg.sm_mitm = 0;
    ble_hs_cfg.sm_sc = 1;
    ble_hs_cfg.sm_our_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("SSP32S3-Pair");
    ble_svc_gap_device_appearance_set(0x03C0);

    ble_gatts_count_cfg(s_gatt_svcs);
    ble_gatts_add_svcs(s_gatt_svcs);

    ble_store_config_init();
    nimble_port_freertos_init(nimble_host_task);

    xTaskCreate(presence_eval_task, "ble_eval", 6144, NULL, 4, NULL);
    ESP_LOGI(TAG, "BLE presence subsystem initialized");
    return ESP_OK;
}

void ble_presence_pause_scan(bool pause)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (pause) {
        s_pause_depth++;
        stop_scan_if_running();
    } else {
        if (s_pause_depth > 0) s_pause_depth--;
        if (s_pause_depth == 0) {
            start_scan_if_allowed();
        }
    }
    xSemaphoreGive(s_mutex);
}

esp_err_t ble_presence_start_pairing(uint8_t person_id, const char *label, uint16_t timeout_s)
{
    if (!cfg_person_get(person_id, NULL)) return ESP_ERR_NOT_FOUND;
    if (!label || label[0] == '\0') return ESP_ERR_INVALID_ARG;
    if (timeout_s < 15) timeout_s = 15;
    if (timeout_s > 180) timeout_s = 180;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (!s_host_synced) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_pairing_active) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    stop_scan_if_running();

    s_pairing_active = true;
    s_pair_person_id = person_id;
    strlcpy(s_pair_label, label, sizeof(s_pair_label));
    s_pair_deadline_ms = now_ms() + (int64_t)timeout_s * 1000LL;
    s_pair_conn_handle = BLE_HS_CONN_HANDLE_NONE;

    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids16 = (ble_uuid16_t *)&s_hid_svc_uuid;
    fields.num_uuids16 = 1;
    fields.uuids16_is_complete = 1;
    const char *name = "SSP32S3-Pair";
    fields.name = (uint8_t *)name;
    fields.name_len = strlen(name);
    fields.name_is_complete = 1;
    fields.appearance = 0x03C0; // Generic HID (required for iOS Settings -> Bluetooth discovery)
    fields.appearance_is_present = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGW(TAG, "ble_gap_adv_set_fields failed: %d", rc);
        s_pairing_active = false;
        start_scan_if_allowed();
        xSemaphoreGive(s_mutex);
        return ESP_FAIL;
    }

    struct ble_gap_adv_params adv_params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min = 32,  // 20ms
        .itvl_max = 64,  // 40ms
    };
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event_cb, NULL);
    if (rc != 0) {
        s_pairing_active = false;
        start_scan_if_allowed();
        xSemaphoreGive(s_mutex);
        return ESP_FAIL;
    }

    led_ctrl_set_flag(LED_FLAG_BLE_PAIRING, true);
    xSemaphoreGive(s_mutex);
    ESP_LOGI(TAG, "Started BLE pairing mode (%us) for person=%u label=%s", timeout_s, person_id, label);
    return ESP_OK;
}

void ble_presence_stop_pairing(void)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_pairing_active) {
        finish_pairing_locked("cancelled", 0, "已取消配对");
    }
    xSemaphoreGive(s_mutex);
}

void ble_presence_on_device_deleted(uint8_t device_id)
{
    cfg_device_t dev;
    if (cfg_device_get(device_id, &dev) && dev.match_type == MATCH_IRK) {
        ble_addr_t peer = { .type = dev.peer_addr_type };
        memcpy(peer.val, dev.mac, 6);
        ble_store_util_delete_peer(&peer);
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < CFG_MAX_DEVICES; i++) {
        if (s_dev_rt[i].device_id == device_id) {
            memset(&s_dev_rt[i], 0, sizeof(dev_rt_state_t));
        }
    }
    memset(s_rpa_cache, 0, sizeof(s_rpa_cache));
    xSemaphoreGive(s_mutex);
}

void ble_presence_on_person_deleted(uint8_t person_id)
{
    cfg_device_t *devs = calloc(CFG_MAX_DEVICES, sizeof(cfg_device_t));
    if (!devs) return;
    size_t cnt = cfg_devices_list(devs, CFG_MAX_DEVICES);
    for (size_t i = 0; i < cnt; i++) {
        if (devs[i].person_id == person_id && devs[i].match_type == MATCH_IRK) {
            ble_addr_t peer = { .type = devs[i].peer_addr_type };
            memcpy(peer.val, devs[i].mac, 6);
            ble_store_util_delete_peer(&peer);
        }
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < CFG_MAX_PERSONS; i++) {
        if (s_person_rt[i].person_id == person_id) {
            memset(&s_person_rt[i], 0, sizeof(person_rt_state_t));
        }
    }
    for (size_t i = 0; i < cnt; i++) {
        if (devs[i].person_id == person_id) {
            for (int j = 0; j < CFG_MAX_DEVICES; j++) {
                if (s_dev_rt[j].device_id == devs[i].id) {
                    memset(&s_dev_rt[j], 0, sizeof(dev_rt_state_t));
                }
            }
        }
    }
    memset(s_rpa_cache, 0, sizeof(s_rpa_cache));
    xSemaphoreGive(s_mutex);
    free(devs);
}

void ble_presence_reload_config(void)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(s_rpa_cache, 0, sizeof(s_rpa_cache));
    xSemaphoreGive(s_mutex);
}

void ble_presence_get_summary(ble_summary_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    if (!s_mutex) return;

    cfg_device_t *devs = calloc(CFG_MAX_DEVICES, sizeof(cfg_device_t));
    cfg_person_t *persons = calloc(CFG_MAX_PERSONS, sizeof(cfg_person_t));
    if (!devs || !persons) {
        free(devs);
        free(persons);
        return;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_pairing_active) {
        out->state = BLE_RUN_PAIRING;
        int64_t rem = (s_pair_deadline_ms - now_ms()) / 1000LL;
        out->pairing_remaining_s = rem > 0 ? (uint16_t)rem : 0;
        out->pairing_active = true;
        out->pairing_person_id = s_pair_person_id;
    } else if (s_scanning) {
        out->state = BLE_RUN_SCANNING;
    } else {
        out->state = BLE_RUN_IDLE;
    }

    out->tracked_devices = cfg_devices_list(devs, CFG_MAX_DEVICES);

    size_t p_cnt = cfg_persons_list(persons, CFG_MAX_PERSONS);
    size_t home = 0;
    for (size_t i = 0; i < p_cnt; i++) {
        person_rt_state_t *prt = find_person_rt(persons[i].id, false);
        if (prt && prt->is_home) home++;
    }
    out->home_persons = home;
    xSemaphoreGive(s_mutex);

    free(devs);
    free(persons);
}

static int cmp_nearby_rssi_desc(const void *a, const void *b)
{
    const ble_nearby_dev_t *pa = (const ble_nearby_dev_t *)a;
    const ble_nearby_dev_t *pb = (const ble_nearby_dev_t *)b;
    return (int)pb->rssi - (int)pa->rssi;
}

size_t ble_presence_get_nearby(ble_nearby_dev_t *out, size_t max_count)
{
    if (!out || max_count == 0 || !s_mutex) return 0;
    int64_t ts = now_ms();
    size_t cnt = 0;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < BLE_NEARBY_MAX && cnt < max_count; i++) {
        if (!s_nearby[i].used) continue;
        if (ts - s_nearby[i].last_seen_ms > 30000) continue;
        memcpy(out[cnt].mac, s_nearby[i].mac, 6);
        out[cnt].addr_type = s_nearby[i].addr_type;
        strlcpy(out[cnt].name, s_nearby[i].name, sizeof(out[cnt].name));
        out[cnt].rssi = s_nearby[i].rssi;
        out[cnt].seen_ago_s = (uint32_t)((ts - s_nearby[i].last_seen_ms) / 1000LL);
        cnt++;
    }
    xSemaphoreGive(s_mutex);

    qsort(out, cnt, sizeof(ble_nearby_dev_t), cmp_nearby_rssi_desc);
    return cnt;
}

size_t ble_presence_get_persons_runtime(ble_person_runtime_t *out, size_t max_count)
{
    if (!out || max_count == 0) return 0;
    cfg_person_t *persons = calloc(CFG_MAX_PERSONS, sizeof(cfg_person_t));
    if (!persons) return 0;
    size_t cnt = cfg_persons_list(persons, max_count < CFG_MAX_PERSONS ? max_count : CFG_MAX_PERSONS);

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (size_t i = 0; i < cnt; i++) {
        out[i].id = persons[i].id;
        strlcpy(out[i].name, persons[i].name, sizeof(out[i].name));
        person_rt_state_t *prt = find_person_rt(persons[i].id, false);
        out[i].is_home = prt ? prt->is_home : false;
    }
    xSemaphoreGive(s_mutex);
    free(persons);
    return cnt;
}

size_t ble_presence_get_devices_runtime(ble_device_runtime_t *out, size_t max_count)
{
    if (!out || max_count == 0) return 0;
    cfg_device_t *devs = calloc(CFG_MAX_DEVICES, sizeof(cfg_device_t));
    if (!devs) return 0;
    size_t cnt = cfg_devices_list(devs, max_count < CFG_MAX_DEVICES ? max_count : CFG_MAX_DEVICES);
    int64_t ts = now_ms();

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (size_t i = 0; i < cnt; i++) {
        out[i].id = devs[i].id;
        out[i].person_id = devs[i].person_id;
        strlcpy(out[i].label, devs[i].label, sizeof(out[i].label));
        out[i].match_type = devs[i].match_type;
        memcpy(out[i].mac, devs[i].mac, 6);
        out[i].enter_rssi = devs[i].enter_rssi;
        out[i].exit_rssi = devs[i].exit_rssi;
        out[i].away_timeout_s = devs[i].away_timeout_s;

        dev_rt_state_t *rt = find_dev_rt(devs[i].id, false);
        if (rt && rt->has_seen) {
            out[i].is_home = rt->is_home;
            out[i].smoothed_rssi = (int8_t)(rt->smoothed_rssi + (rt->smoothed_rssi >= 0 ? 0.5f : -0.5f));
            out[i].raw_rssi = rt->raw_rssi;
            out[i].seen_ago_s = (int32_t)((ts - rt->last_seen_ms) / 1000LL);
        } else {
            out[i].is_home = false;
            out[i].smoothed_rssi = -127;
            out[i].raw_rssi = -127;
            out[i].seen_ago_s = -1;
        }
    }
    xSemaphoreGive(s_mutex);
    free(devs);
    return cnt;
}
