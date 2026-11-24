#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float mhz;
    float bandwidth_khz;
    float rate_kbaud;
} rf_settings_t;

bool cc1101_settings_valid(const rf_settings_t *settings);
esp_err_t cc1101_init(const rf_settings_t *settings);
esp_err_t cc1101_configure(const rf_settings_t *settings);
esp_err_t cc1101_receive(void);
esp_err_t cc1101_transmit(void);
esp_err_t cc1101_idle(void);
esp_err_t cc1101_status(uint8_t *version, uint8_t *state, int *rssi);

#ifdef __cplusplus
}
#endif
