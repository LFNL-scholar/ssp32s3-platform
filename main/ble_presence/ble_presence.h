#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define BLE_NEARBY_MAX 64

typedef enum {
    BLE_RUN_IDLE = 0,
    BLE_RUN_SCANNING = 1,
    BLE_RUN_PAIRING = 2,
} ble_run_state_t;

typedef struct {
    uint8_t id;
    uint8_t person_id;
    char label[32];
    uint8_t match_type;
    uint8_t mac[6];
    int8_t enter_rssi;
    int8_t exit_rssi;
    uint16_t away_timeout_s;
    bool is_home;
    int8_t smoothed_rssi;
    int8_t raw_rssi;
    int32_t seen_ago_s; // -1 if never seen
} ble_device_runtime_t;

typedef struct {
    uint8_t id;
    char name[32];
    bool is_home;
} ble_person_runtime_t;

typedef struct {
    uint8_t mac[6];
    uint8_t addr_type;
    char name[32];
    int8_t rssi;
    uint32_t seen_ago_s;
} ble_nearby_dev_t;

typedef struct {
    ble_run_state_t state;
    size_t tracked_devices;
    size_t home_persons;
    bool pairing_active;
    uint8_t pairing_person_id;
    uint16_t pairing_remaining_s;
} ble_summary_t;

// Callback invoked when presence_event or pair_result JSON is emitted for WS broadcast
typedef void (*ble_ws_event_cb_t)(const char *json_str);
typedef void (*ble_home_count_cb_t)(int prev_home, int cur_home);

void ble_presence_set_ws_cb(ble_ws_event_cb_t cb);
void ble_presence_set_home_count_cb(ble_home_count_cb_t cb);
esp_err_t ble_presence_init(void);

// Pause/resume scanning (used by Wi-Fi scan and OTA)
void ble_presence_pause_scan(bool pause);

// Pairing wizard for IRK phone binding
esp_err_t ble_presence_start_pairing(uint8_t person_id, const char *label, uint16_t timeout_s);
void ble_presence_stop_pairing(void);

// Delete NimBLE bond if device is IRK type
void ble_presence_on_device_deleted(uint8_t device_id);
void ble_presence_on_person_deleted(uint8_t person_id);
void ble_presence_reload_config(void);

// Snapshot getters
void ble_presence_get_summary(ble_summary_t *out);
size_t ble_presence_get_nearby(ble_nearby_dev_t *out, size_t max_count);
size_t ble_presence_get_persons_runtime(ble_person_runtime_t *out, size_t max_count);
size_t ble_presence_get_devices_runtime(ble_device_runtime_t *out, size_t max_count);

#ifdef __cplusplus
}
#endif
