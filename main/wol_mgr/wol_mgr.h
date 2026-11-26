#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*wol_ws_cb_t)(const char *json_str);

void wol_mgr_set_ws_cb(wol_ws_cb_t cb);
esp_err_t wol_mgr_init(void);

// Validate and normalize MAC string ("XX:XX:XX:XX:XX:XX")
bool wol_mgr_parse_mac(const char *str, uint8_t out[6]);
bool wol_mgr_format_mac(const uint8_t mac[6], char *out, size_t out_len);

// Trigger WOL magic packet burst (18 packets: 3 rounds x 3 targets x 2 ports)
esp_err_t wol_mgr_wake(const char *source, int *out_sent);

// Run immediate online probe (TCP 445/135 + lwIP ARP MAC match)
bool wol_mgr_probe_now(void);
bool wol_mgr_is_online(void);

// Record an event into the WOL/MQTT activity log and push WS update
void wol_mgr_log_event(const char *title, const char *detail, const char *level);

// Broadcast current wol_state JSON over WebSocket
void wol_mgr_broadcast_state(void);

// Build full JSON snapshot for GET /api/wol/state and WS push
cJSON *wol_mgr_build_state_json(void);

// Hook called by BLE presence engine when home_persons transitions 0 <-> >0
void wol_mgr_on_presence_change(int prev_home, int cur_home);

#ifdef __cplusplus
}
#endif
