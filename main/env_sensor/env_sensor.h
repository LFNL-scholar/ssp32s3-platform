#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*env_ws_event_cb_t)(const char *json_str);

void env_sensor_set_ws_cb(env_ws_event_cb_t cb);
esp_err_t env_sensor_init(bool storage_ready);
void env_sensor_reload_config(void);

// Called from NimBLE GAP discovery callback with LE address (ble_addr_t.val)
void env_sensor_on_ble_adv(const uint8_t addr_le[6], int8_t rssi, const uint8_t *data, uint8_t len);

cJSON *env_sensor_build_state_json(void);
cJSON *env_sensor_build_history_json(const char *range_str);
esp_err_t env_sensor_clear_history(void);
cJSON *env_sensor_build_siri_json(void);

#ifdef __cplusplus
}
#endif
