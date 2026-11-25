#pragma once

#include "esp_err.h"
#include "esp_http_server.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t ota_mgr_handle_upload(httpd_req_t *req);
esp_err_t ota_mgr_handle_www_upload(httpd_req_t *req);
void ota_mgr_confirm_if_pending(void);

#ifdef __cplusplus
}
#endif
