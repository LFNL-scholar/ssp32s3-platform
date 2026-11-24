#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t btn_reset_init(int gpio_num);

#ifdef __cplusplus
}
#endif
