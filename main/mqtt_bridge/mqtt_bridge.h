#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool enabled;
    bool connected;
    char last_error[80];
} mqtt_bridge_status_t;

esp_err_t mqtt_bridge_init(void);
esp_err_t mqtt_bridge_reload(void);
void mqtt_bridge_get_status(mqtt_bridge_status_t *out);

#ifdef __cplusplus
}
#endif
