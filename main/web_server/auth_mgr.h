#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_http_server.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t auth_mgr_init(void);
esp_err_t auth_mgr_login(const char *password, char *out_token, size_t token_len, int *out_retry_after_s);
esp_err_t auth_mgr_create_session(char *out_token, size_t token_len);
bool auth_mgr_check_req(httpd_req_t *req);
void auth_mgr_logout_req(httpd_req_t *req);
void auth_mgr_clear_all(void);

#ifdef __cplusplus
}
#endif
