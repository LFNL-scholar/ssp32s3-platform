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
} cloud_tunnel_status_t;

esp_err_t cloud_tunnel_init(void);
esp_err_t cloud_tunnel_reload(void);
void cloud_tunnel_get_status(cloud_tunnel_status_t *out);
bool cloud_tunnel_is_connected(void);
void cloud_tunnel_forward_ws_bcast(const char *json_str);

#ifdef __cplusplus
}
#endif
