#pragma once

#include "esp_err.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t sys_monitor_init(void);
cJSON *sys_monitor_build_info_json(void);
cJSON *sys_monitor_build_telemetry_json(void);

#ifdef __cplusplus
}
#endif
