#include "cloud_tunnel.h"
#include "cfg_store.h"
#include "wol_mgr.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "cJSON.h"

static const char *TAG = "cloud_tunnel";

#define TUNNEL_MAX_REQ_JSON   20480
#define TUNNEL_MAX_HTTP_RESP  65536
#define TUNNEL_QUEUE_LEN      24

static SemaphoreHandle_t s_state_mutex = NULL;
static SemaphoreHandle_t s_send_mutex = NULL;
static QueueHandle_t s_req_queue = NULL;
static esp_websocket_client_handle_t s_client = NULL;
static bool s_connected = false;
static char s_last_error[80] = "";

// Frame reassembly buffer (accessed only from WS event task)
static char *s_rx_buf = NULL;
static size_t s_rx_cap = 0;

static void set_error(const char *err)
{
    xSemaphoreTake(s_state_mutex, portMAX_DELAY);
    strlcpy(s_last_error, err ? err : "", sizeof(s_last_error));
    xSemaphoreGive(s_state_mutex);
}

static bool send_ws_text(const char *text, size_t len, TickType_t wait_ticks)
{
    if (!s_send_mutex || !text || len == 0) return false;
    if (xSemaphoreTake(s_send_mutex, wait_ticks) != pdTRUE) return false;
    bool ok = false;
    if (s_client && s_connected && esp_websocket_client_is_connected(s_client)) {
        int r = esp_websocket_client_send_text(s_client, text, (int)len, pdMS_TO_TICKS(3000));
        ok = (r >= 0);
    }
    xSemaphoreGive(s_send_mutex);
    return ok;
}

static char *find_header_value(const char *headers, const char *name, char *out, size_t out_len)
{
    out[0] = '\0';
    size_t nlen = strlen(name);
    const char *p = headers;
    while (p && *p) {
        const char *eol = strstr(p, "\r\n");
        size_t line_len = eol ? (size_t)(eol - p) : strlen(p);
        if (line_len > nlen && strncasecmp(p, name, nlen) == 0 && p[nlen] == ':') {
            const char *val = p + nlen + 1;
            while (*val == ' ' || *val == '\t') val++;
            size_t vlen = (size_t)((p + line_len) - val);
            if (vlen >= out_len) vlen = out_len - 1;
            memcpy(out, val, vlen);
            out[vlen] = '\0';
            return out;
        }
        if (!eol) break;
        p = eol + 2;
    }
    return out;
}

static size_t decode_chunked_inplace(char *buf, size_t len)
{
    size_t r = 0;
    size_t w = 0;
    while (r < len) {
        char *crlf = strstr(buf + r, "\r\n");
        if (!crlf) break;
        size_t chunk_sz = (size_t)strtoul(buf + r, NULL, 16);
        r = (size_t)((crlf + 2) - buf);
        if (chunk_sz == 0) break;
        if (r + chunk_sz > len) chunk_sz = len - r;
        memmove(buf + w, buf + r, chunk_sz);
        w += chunk_sz;
        r += chunk_sz;
        if (r + 2 <= len && buf[r] == '\r' && buf[r + 1] == '\n') {
            r += 2;
        }
    }
    buf[w] = '\0';
    return w;
}

static void handle_http_req_json(const char *json_str)
{
    cJSON *req = cJSON_Parse(json_str);
    if (!req) return;

    const cJSON *j_type = cJSON_GetObjectItem(req, "type");
    const cJSON *j_id = cJSON_GetObjectItem(req, "id");
    const cJSON *j_method = cJSON_GetObjectItem(req, "method");
    const cJSON *j_path = cJSON_GetObjectItem(req, "path");
    if (!cJSON_IsString(j_type) || strcmp(j_type->valuestring, "http_req") != 0 ||
        !cJSON_IsNumber(j_id) || !cJSON_IsString(j_method) || !cJSON_IsString(j_path)) {
        cJSON_Delete(req);
        return;
    }

    int req_id = (int)j_id->valuedouble;
    const char *method = j_method->valuestring;
    const char *path = j_path->valuestring;
    const cJSON *j_cookie = cJSON_GetObjectItem(req, "cookie");
    const cJSON *j_ct = cJSON_GetObjectItem(req, "content_type");
    const cJSON *j_body = cJSON_GetObjectItem(req, "body");

    const char *cookie = cJSON_IsString(j_cookie) ? j_cookie->valuestring : "";
    const char *ct = cJSON_IsString(j_ct) ? j_ct->valuestring : "";
    const char *body = cJSON_IsString(j_body) ? j_body->valuestring : "";
    size_t body_len = strlen(body);

    int status = 502;
    char resp_ct[96] = "application/json; charset=utf-8";
    char resp_cookie[200] = "";
    char *resp_body = NULL;

    char *raw_resp = heap_caps_malloc(TUNNEL_MAX_HTTP_RESP + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!raw_resp) raw_resp = malloc(16384);
    size_t raw_cap = raw_resp ? (heap_caps_get_allocated_size(raw_resp) - 1) : 0;
    if (raw_cap > TUNNEL_MAX_HTTP_RESP) raw_cap = TUNNEL_MAX_HTTP_RESP;

    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock >= 0 && raw_resp) {
        struct timeval tv = { .tv_sec = 8, .tv_usec = 0 };
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

        struct sockaddr_in addr = {0};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(80);
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

        if (connect(sock, (struct sockaddr *)&addr, sizeof(addr)) == 0) {
            char hdr[1024];
            int hlen = snprintf(
                hdr, sizeof(hdr),
                "%s %s HTTP/1.1\r\n"
                "Host: esp32s3.local\r\n"
                "Connection: close\r\n"
                "%s%s%s"
                "%s%s%s"
                "Content-Length: %u\r\n\r\n",
                method, path,
                cookie[0] ? "Cookie: " : "", cookie[0] ? cookie : "", cookie[0] ? "\r\n" : "",
                ct[0] ? "Content-Type: " : "", ct[0] ? ct : "", ct[0] ? "\r\n" : "",
                (unsigned)body_len);

            bool sent_ok = (hlen > 0 && send(sock, hdr, hlen, 0) == hlen);
            if (sent_ok && body_len > 0) {
                size_t off = 0;
                while (off < body_len) {
                    int n = send(sock, body + off, body_len - off, 0);
                    if (n <= 0) { sent_ok = false; break; }
                    off += (size_t)n;
                }
            }

            if (sent_ok) {
                size_t total = 0;
                char *hdr_end = NULL;
                long content_len = -1;
                bool is_chunked = false;

                while (total < raw_cap) {
                    int n = recv(sock, raw_resp + total, raw_cap - total, 0);
                    if (n <= 0) break;
                    total += (size_t)n;
                    raw_resp[total] = '\0';

                    if (!hdr_end) {
                        hdr_end = strstr(raw_resp, "\r\n\r\n");
                        if (hdr_end) {
                            *hdr_end = '\0';
                            char cl_str[32];
                            if (find_header_value(raw_resp, "Content-Length", cl_str, sizeof(cl_str))[0]) {
                                content_len = strtol(cl_str, NULL, 10);
                            }
                            char te_str[32];
                            if (find_header_value(raw_resp, "Transfer-Encoding", te_str, sizeof(te_str))[0] &&
                                strcasestr(te_str, "chunked") != NULL) {
                                is_chunked = true;
                            }
                            *hdr_end = '\r';
                        }
                    }

                    if (hdr_end) {
                        char *bptr = hdr_end + 4;
                        size_t blen = total - (size_t)(bptr - raw_resp);
                        if (content_len >= 0 && (long)blen >= content_len) {
                            break;
                        }
                        if (is_chunked) {
                            if ((blen >= 5 && memcmp(bptr, "0\r\n\r\n", 5) == 0) ||
                                (blen >= 7 && strstr(bptr, "\r\n0\r\n\r\n") != NULL)) {
                                break;
                            }
                        }
                    }
                }
                raw_resp[total] = '\0';

                char *sep = strstr(raw_resp, "\r\n\r\n");
                if (sep) {
                    *sep = '\0';
                    char *bptr = sep + 4;
                    size_t blen = total - (size_t)(bptr - raw_resp);

                    // Parse HTTP status line
                    const char *sp = strchr(raw_resp, ' ');
                    if (sp) status = atoi(sp + 1);

                    char tmp[96];
                    if (find_header_value(raw_resp, "Content-Type", tmp, sizeof(tmp))[0]) {
                        strlcpy(resp_ct, tmp, sizeof(resp_ct));
                    }
                    find_header_value(raw_resp, "Set-Cookie", resp_cookie, sizeof(resp_cookie));

                    char te[32];
                    if (find_header_value(raw_resp, "Transfer-Encoding", te, sizeof(te))[0] &&
                        strcasestr(te, "chunked") != NULL) {
                        blen = decode_chunked_inplace(bptr, blen);
                    }
                    bptr[blen] = '\0';
                    resp_body = bptr;
                }
            }
        }
        close(sock);
    } else if (sock >= 0) {
        close(sock);
    }

    cJSON *res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "type", "http_res");
    cJSON_AddNumberToObject(res, "id", req_id);
    cJSON_AddNumberToObject(res, "status", status);
    cJSON_AddStringToObject(res, "content_type", resp_ct);
    if (resp_cookie[0] != '\0') {
        cJSON_AddStringToObject(res, "set_cookie", resp_cookie);
    }
    cJSON_AddStringToObject(res, "body", resp_body ? resp_body : "{\"ok\":false,\"error\":\"local_proxy_error\"}");

    char *out_str = cJSON_PrintUnformatted(res);
    cJSON_Delete(res);
    if (out_str) {
        send_ws_text(out_str, strlen(out_str), pdMS_TO_TICKS(3000));
        cJSON_free(out_str);
    }

    free(raw_resp);
    cJSON_Delete(req);
}

static void tunnel_req_task(void *arg)
{
    char *msg = NULL;
    while (1) {
        if (xQueueReceive(s_req_queue, &msg, portMAX_DELAY) == pdTRUE && msg) {
            handle_http_req_json(msg);
            free(msg);
        }
    }
}

static void ws_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        xSemaphoreTake(s_state_mutex, portMAX_DELAY);
        s_connected = true;
        s_last_error[0] = '\0';
        xSemaphoreGive(s_state_mutex);
        ESP_LOGI(TAG, "Cloudflare tunnel connected");
        wol_mgr_broadcast_state();
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
        xSemaphoreTake(s_state_mutex, portMAX_DELAY);
        s_connected = false;
        xSemaphoreGive(s_state_mutex);
        ESP_LOGW(TAG, "Cloudflare tunnel disconnected");
        wol_mgr_broadcast_state();
        break;

    case WEBSOCKET_EVENT_ERROR:
        set_error("WSS 连接异常，自动重试中");
        wol_mgr_broadcast_state();
        break;

    case WEBSOCKET_EVENT_DATA:
        if (!data || data->op_code != 0x01 || data->data_len <= 0) break;
        if (data->payload_len > TUNNEL_MAX_REQ_JSON) {
            ESP_LOGW(TAG, "Drop oversized WS frame: %d bytes", data->payload_len);
            break;
        }
        if ((size_t)data->payload_len + 1 > s_rx_cap) {
            char *nb = heap_caps_realloc(s_rx_buf, (size_t)data->payload_len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!nb) break;
            s_rx_buf = nb;
            s_rx_cap = (size_t)data->payload_len + 1;
        }
        if (data->payload_offset + data->data_len <= data->payload_len) {
            memcpy(s_rx_buf + data->payload_offset, data->data_ptr, data->data_len);
        }
        if (data->payload_offset + data->data_len >= data->payload_len) {
            s_rx_buf[data->payload_len] = '\0';
            if (strcmp(s_rx_buf, "pong") == 0) break;
            char *copy = heap_caps_malloc((size_t)data->payload_len + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!copy) copy = malloc((size_t)data->payload_len + 1);
            if (copy) {
                memcpy(copy, s_rx_buf, (size_t)data->payload_len + 1);
                if (xQueueSend(s_req_queue, &copy, 0) != pdTRUE) {
                    free(copy);
                }
            }
        }
        break;

    default:
        break;
    }
}

void cloud_tunnel_forward_ws_bcast(const char *json_str)
{
    if (!json_str || !s_connected || !s_client) return;
    cJSON *env = cJSON_CreateObject();
    if (!env) return;
    cJSON_AddStringToObject(env, "type", "ws_bcast");
    cJSON_AddStringToObject(env, "payload", json_str);
    char *str = cJSON_PrintUnformatted(env);
    cJSON_Delete(env);
    if (str) {
        send_ws_text(str, strlen(str), pdMS_TO_TICKS(50));
        cJSON_free(str);
    }
}

esp_err_t cloud_tunnel_reload(void)
{
    if (!s_state_mutex) return ESP_ERR_INVALID_STATE;

    xSemaphoreTake(s_send_mutex, portMAX_DELAY);
    if (s_client) {
        esp_websocket_client_stop(s_client);
        esp_websocket_client_destroy(s_client);
        s_client = NULL;
    }
    xSemaphoreTake(s_state_mutex, portMAX_DELAY);
    s_connected = false;
    s_last_error[0] = '\0';
    xSemaphoreGive(s_state_mutex);
    xSemaphoreGive(s_send_mutex);

    cfg_tunnel_t cfg;
    cfg_tunnel_get(&cfg);

    if (!cfg.enabled) {
        ESP_LOGI(TAG, "Cloud tunnel disabled");
        wol_mgr_broadcast_state();
        return ESP_OK;
    }

    if (cfg.url[0] == '\0' || cfg.secret[0] == '\0') {
        set_error("缺少 Worker 地址或隧道密钥");
        wol_mgr_broadcast_state();
        return ESP_ERR_INVALID_ARG;
    }

    char full_uri[256];
    const char *sep = strchr(cfg.url, '?') ? "&" : "?";
    snprintf(full_uri, sizeof(full_uri), "%s%ssecret=%s", cfg.url, sep, cfg.secret);

    esp_websocket_client_config_t ws_cfg = {
        .uri = full_uri,
        .buffer_size = 4096,
        .reconnect_timeout_ms = 8000,
        .network_timeout_ms = 10000,
        .ping_interval_sec = 25,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .task_stack = 6144,
    };

    esp_websocket_client_handle_t cli = esp_websocket_client_init(&ws_cfg);
    if (!cli) {
        set_error("WSS 客户端初始化失败");
        wol_mgr_broadcast_state();
        return ESP_FAIL;
    }

    esp_websocket_register_events(cli, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    esp_err_t err = esp_websocket_client_start(cli);
    if (err != ESP_OK) {
        esp_websocket_client_destroy(cli);
        set_error("WSS 客户端启动失败");
        wol_mgr_broadcast_state();
        return err;
    }

    xSemaphoreTake(s_send_mutex, portMAX_DELAY);
    s_client = cli;
    xSemaphoreGive(s_send_mutex);

    ESP_LOGI(TAG, "Cloud tunnel started -> %s", cfg.url);
    wol_mgr_broadcast_state();
    return ESP_OK;
}

void cloud_tunnel_get_status(cloud_tunnel_status_t *out)
{
    if (!out) return;
    cfg_tunnel_t cfg;
    cfg_tunnel_get(&cfg);
    out->enabled = cfg.enabled;
    if (!s_state_mutex) {
        out->connected = false;
        out->last_error[0] = '\0';
        return;
    }
    xSemaphoreTake(s_state_mutex, portMAX_DELAY);
    out->connected = s_connected;
    strlcpy(out->last_error, s_last_error, sizeof(out->last_error));
    xSemaphoreGive(s_state_mutex);
}

bool cloud_tunnel_is_connected(void)
{
    return s_connected && s_client != NULL;
}

esp_err_t cloud_tunnel_init(void)
{
    if (!s_state_mutex) {
        s_state_mutex = xSemaphoreCreateMutex();
        s_send_mutex = xSemaphoreCreateMutex();
        s_req_queue = xQueueCreate(TUNNEL_QUEUE_LEN, sizeof(char *));
        if (!s_state_mutex || !s_send_mutex || !s_req_queue) return ESP_ERR_NO_MEM;
        xTaskCreate(tunnel_req_task, "tunnel_req", 8192, NULL, 4, NULL);
    }
    return cloud_tunnel_reload();
}
