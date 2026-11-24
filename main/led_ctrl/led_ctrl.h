#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LED_FLAG_FACTORY_RESET = (1 << 0),
    LED_FLAG_OTA           = (1 << 1),
    LED_FLAG_BLE_PAIRING   = (1 << 2),
    LED_FLAG_AP_MODE       = (1 << 3),
} led_flag_t;

esp_err_t led_ctrl_init(int gpio_num, uint8_t brightness, uint8_t away_mode, bool idle_enabled);
void led_ctrl_set_flag(led_flag_t flag, bool active);
void led_ctrl_set_home_count(int count);
esp_err_t led_ctrl_apply_settings(int gpio_num, uint8_t brightness, uint8_t away_mode, bool idle_enabled);

#ifdef __cplusplus
}
#endif
