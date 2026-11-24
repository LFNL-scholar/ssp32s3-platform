#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool radio_ready;
    bool storage_ready;
    bool sample_loaded;
    uint32_t sample_pulses;
    float sample_mhz;
    bool power_known;
    bool power_on;
    uint32_t power_transmissions;
    char last_action[24];
    char last_error[80];
    bool learning_active;
    bool pending_ready;
    uint32_t pending_pulses;
    uint32_t pending_duration_ms;
} lamp_status_t;

typedef void (*lamp_ws_cb_t)(const char *json_str);

void lamp_controller_set_ws_cb(lamp_ws_cb_t cb);
esp_err_t lamp_controller_init(bool data_mounted);

void lamp_controller_status(lamp_status_t *out);
cJSON *lamp_controller_build_state_json(void);

esp_err_t lamp_controller_sync_power(bool on);
esp_err_t lamp_controller_set_power(bool on, bool is_auto, bool *transmitted);

// Web RF learning workflow
esp_err_t lamp_controller_learn_start(void);
esp_err_t lamp_controller_learn_test(void);
esp_err_t lamp_controller_learn_save(void);
void lamp_controller_learn_cancel(void);
esp_err_t lamp_controller_import_sample(const uint8_t *raw_rf_file, size_t len);

// Hook called by BLE presence engine when home_persons transitions 0 <-> >0
void lamp_controller_on_presence_change(int prev_home, int cur_home);

#ifdef __cplusplus
}
#endif
