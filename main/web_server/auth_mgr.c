#include "auth_mgr.h"

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"

#include "cfg_store.h"

static const char *TAG = "auth_mgr";

#define MAX_SESSIONS        8
#define TOKEN_HEX_LEN       64
#define SESSION_IDLE_TTL_MS (24LL * 3600LL * 1000LL)
#define MAX_FAIL_ATTEMPTS   5
#define LOCKOUT_MS          (60LL * 1000LL)

typedef struct {
    bool valid;
    char token[TOKEN_HEX_LEN + 1];
    int64_t last_seen_ms;
} session_slot_t;

static SemaphoreHandle_t s_mutex = NULL;
static session_slot_t s_sessions[MAX_SESSIONS];
static int s_fail_count = 0;
static int64_t s_lockout_until_ms = 0;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000LL;
}

esp_err_t auth_mgr_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }
    memset(s_sessions, 0, sizeof(s_sessions));
    s_fail_count = 0;
    s_lockout_until_ms = 0;
    return ESP_OK;
}

static esp_err_t create_session_locked(char *out_token, size_t token_len)
{
    if (!out_token || token_len < TOKEN_HEX_LEN + 1) return ESP_ERR_INVALID_ARG;

    uint8_t rnd[32];
    esp_fill_random(rnd, sizeof(rnd));
    char tok[TOKEN_HEX_LEN + 1];
    for (int i = 0; i < 32; i++) {
        snprintf(&tok[i * 2], 3, "%02x", rnd[i]);
    }
    tok[TOKEN_HEX_LEN] = '\0';

    int64_t ts = now_ms();
    int empty = -1;
    int oldest = 0;
    int64_t oldest_ts = INT64_MAX;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (s_sessions[i].valid && ts - s_sessions[i].last_seen_ms > SESSION_IDLE_TTL_MS) {
            s_sessions[i].valid = false;
        }
        if (!s_sessions[i].valid) {
            if (empty < 0) empty = i;
        } else if (s_sessions[i].last_seen_ms < oldest_ts) {
            oldest_ts = s_sessions[i].last_seen_ms;
            oldest = i;
        }
    }

    int slot = (empty >= 0) ? empty : oldest;
    s_sessions[slot].valid = true;
    memcpy(s_sessions[slot].token, tok, sizeof(tok));
    s_sessions[slot].last_seen_ms = ts;
    strlcpy(out_token, tok, token_len);
    return ESP_OK;
}

esp_err_t auth_mgr_create_session(char *out_token, size_t token_len)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    esp_err_t err = create_session_locked(out_token, token_len);
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t auth_mgr_login(const char *password, char *out_token, size_t token_len, int *out_retry_after_s)
{
    if (out_retry_after_s) *out_retry_after_s = 0;
    if (!password) return ESP_ERR_INVALID_ARG;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    int64_t ts = now_ms();
    if (s_lockout_until_ms > ts) {
        if (out_retry_after_s) {
            *out_retry_after_s = (int)((s_lockout_until_ms - ts + 999) / 1000);
        }
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    if (!cfg_auth_verify_password(password)) {
        s_fail_count++;
        if (s_fail_count >= MAX_FAIL_ATTEMPTS) {
            s_lockout_until_ms = ts + LOCKOUT_MS;
            if (out_retry_after_s) *out_retry_after_s = (int)(LOCKOUT_MS / 1000);
            ESP_LOGW(TAG, "Too many failed logins, locked out for 60s");
        }
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_ARG;
    }

    s_fail_count = 0;
    s_lockout_until_ms = 0;
    esp_err_t err = create_session_locked(out_token, token_len);
    xSemaphoreGive(s_mutex);
    return err;
}

static bool extract_token_from_req(httpd_req_t *req, char *out_tok, size_t max_len)
{
    // 1. Authorization: Bearer <token>
    size_t auth_len = httpd_req_get_hdr_value_len(req, "Authorization");
    if (auth_len > 7 && auth_len < 256) {
        char *buf = malloc(auth_len + 1);
        if (buf) {
            if (httpd_req_get_hdr_value_str(req, "Authorization", buf, auth_len + 1) == ESP_OK) {
                if (strncasecmp(buf, "Bearer ", 7) == 0) {
                    strlcpy(out_tok, buf + 7, max_len);
                    free(buf);
                    return true;
                }
            }
            free(buf);
        }
    }

    // 2. Cookie: ... sid=<token> ...
    size_t ck_len = httpd_req_get_hdr_value_len(req, "Cookie");
    if (ck_len > 0 && ck_len < 512) {
        char *buf = malloc(ck_len + 1);
        if (buf) {
            if (httpd_req_get_hdr_value_str(req, "Cookie", buf, ck_len + 1) == ESP_OK) {
                const char *p = strstr(buf, "sid=");
                while (p) {
                    if (p == buf || p[-1] == ' ' || p[-1] == ';') {
                        p += 4;
                        size_t i = 0;
                        while (p[i] && p[i] != ';' && p[i] != ' ' && i < max_len - 1) {
                            out_tok[i] = p[i];
                            i++;
                        }
                        out_tok[i] = '\0';
                        free(buf);
                        return i == TOKEN_HEX_LEN;
                    }
                    p = strstr(p + 4, "sid=");
                }
            }
            free(buf);
        }
    }

    return false;
}

static bool constant_time_eq(const char *a, const char *b, size_t len)
{
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(a[i] ^ b[i]);
    }
    return diff == 0;
}

bool auth_mgr_check_req(httpd_req_t *req)
{
    char tok[TOKEN_HEX_LEN + 1];
    if (!extract_token_from_req(req, tok, sizeof(tok))) return false;
    if (strlen(tok) != TOKEN_HEX_LEN) return false;

    int64_t ts = now_ms();
    bool ok = false;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (s_sessions[i].valid) {
            if (ts - s_sessions[i].last_seen_ms > SESSION_IDLE_TTL_MS) {
                s_sessions[i].valid = false;
                continue;
            }
            if (constant_time_eq(s_sessions[i].token, tok, TOKEN_HEX_LEN)) {
                s_sessions[i].last_seen_ms = ts;
                ok = true;
                break;
            }
        }
    }
    xSemaphoreGive(s_mutex);
    return ok;
}

void auth_mgr_logout_req(httpd_req_t *req)
{
    char tok[TOKEN_HEX_LEN + 1];
    if (!extract_token_from_req(req, tok, sizeof(tok))) return;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (s_sessions[i].valid && constant_time_eq(s_sessions[i].token, tok, TOKEN_HEX_LEN)) {
            s_sessions[i].valid = false;
            memset(s_sessions[i].token, 0, sizeof(s_sessions[i].token));
        }
    }
    xSemaphoreGive(s_mutex);
}

void auth_mgr_clear_all(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memset(s_sessions, 0, sizeof(s_sessions));
    xSemaphoreGive(s_mutex);
}
