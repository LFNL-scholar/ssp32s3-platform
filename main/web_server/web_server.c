#include "web_server.h"
#include "auth_mgr.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_http_server.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_log.h"
#include "cJSON.h"

#include "cfg_store.h"
#include "wifi_mgr.h"
#include "sys_monitor.h"
#include "ble_presence.h"
#include "presence_log.h"
#include "led_ctrl.h"
#include "ota_mgr.h"
#include "lamp_controller.h"
#include "lamp_history.h"
#include "wol_mgr.h"
#include "mqtt_bridge.h"
#include "cloud_tunnel.h"
#include "env_sensor.h"

static const char *TAG = "web_server";

#define MAX_WS_CLIENTS 8
#define LIVING_COST_PATH      "/data/living_cost.json"
#define LIVING_COST_TMP_PATH  "/data/living_cost.tmp"
#define LIVING_COST_MAX_BYTES 16384

static httpd_handle_t s_httpd = NULL;
static SemaphoreHandle_t s_ws_mutex = NULL;
static SemaphoreHandle_t s_cost_mutex = NULL;
static int s_ws_fds[MAX_WS_CLIENTS];

typedef struct {
    char *msg;
} ws_bcast_work_t;

static void ws_client_add(int fd)
{
    xSemaphoreTake(s_ws_mutex, portMAX_DELAY);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (s_ws_fds[i] == fd) {
            xSemaphoreGive(s_ws_mutex);
            return;
        }
    }
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (s_ws_fds[i] < 0) {
            s_ws_fds[i] = fd;
            break;
        }
    }
    xSemaphoreGive(s_ws_mutex);
}

static void ws_client_remove(int fd)
{
    xSemaphoreTake(s_ws_mutex, portMAX_DELAY);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (s_ws_fds[i] == fd) {
            s_ws_fds[i] = -1;
        }
    }
    xSemaphoreGive(s_ws_mutex);
}

static int ws_client_count(void)
{
    int cnt = 0;
    xSemaphoreTake(s_ws_mutex, portMAX_DELAY);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (s_ws_fds[i] >= 0) cnt++;
    }
    xSemaphoreGive(s_ws_mutex);
    return cnt;
}

static void on_httpd_close(httpd_handle_t hd, int sockfd)
{
    ws_client_remove(sockfd);
    close(sockfd);
}

static void ws_bcast_work_cb(void *arg)
{
    ws_bcast_work_t *w = (ws_bcast_work_t *)arg;
    if (!w || !w->msg) {
        free(w);
        return;
    }

    int fds[MAX_WS_CLIENTS];
    xSemaphoreTake(s_ws_mutex, portMAX_DELAY);
    memcpy(fds, s_ws_fds, sizeof(fds));
    xSemaphoreGive(s_ws_mutex);

    httpd_ws_frame_t pkt = {
        .final = true,
        .fragmented = false,
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)w->msg,
        .len = strlen(w->msg),
    };

    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (fds[i] >= 0) {
            if (httpd_ws_send_frame_async(s_httpd, fds[i], &pkt) != ESP_OK) {
                ws_client_remove(fds[i]);
            }
        }
    }

    free(w->msg);
    free(w);
}

void web_server_ws_broadcast(const char *json_str)
{
    if (!json_str) return;
    cloud_tunnel_forward_ws_bcast(json_str);
    if (!s_httpd || ws_client_count() == 0) return;

    ws_bcast_work_t *w = malloc(sizeof(ws_bcast_work_t));
    if (!w) return;
    w->msg = strdup(json_str);
    if (!w->msg) {
        free(w);
        return;
    }
    if (httpd_queue_work(s_httpd, ws_bcast_work_cb, w) != ESP_OK) {
        free(w->msg);
        free(w);
    }
}

// ---------- Helpers ----------

static esp_err_t send_json(httpd_req_t *req, const char *status, cJSON *obj)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char *str = cJSON_PrintUnformatted(obj);
    cJSON_Delete(obj);
    if (!str) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }
    httpd_resp_send(req, str, HTTPD_RESP_USE_STRLEN);
    cJSON_free(str);
    return ESP_OK;
}

static esp_err_t send_err(httpd_req_t *req, const char *status, const char *msg)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", false);
    cJSON_AddStringToObject(o, "error", msg);
    return send_json(req, status, o);
}

static cJSON *read_json_body(httpd_req_t *req, size_t max_len)
{
    if (req->content_len <= 0 || (size_t)req->content_len > max_len) return NULL;
    char *buf = malloc(req->content_len + 1);
    if (!buf) return NULL;

    int total = 0;
    while (total < req->content_len) {
        int r = httpd_req_recv(req, buf + total, req->content_len - total);
        if (r <= 0) {
            if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
            free(buf);
            return NULL;
        }
        total += r;
    }
    buf[total] = '\0';
    cJSON *json = cJSON_Parse(buf);
    free(buf);
    return json;
}

static bool require_auth(httpd_req_t *req)
{
    if (auth_mgr_check_req(req)) return true;
    send_err(req, "401 Unauthorized", "unauthorized");
    return false;
}

static bool require_setup_or_auth(httpd_req_t *req)
{
    if (!cfg_auth_is_initialized() || auth_mgr_check_req(req)) return true;
    send_err(req, "401 Unauthorized", "unauthorized");
    return false;
}

static void format_mac_str(const uint8_t mac[6], char *out, size_t len)
{
    snprintf(out, len, "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[5], mac[4], mac[3], mac[2], mac[1], mac[0]);
}

static bool parse_mac_str(const char *str, uint8_t out_le[6])
{
    if (!str) return false;
    unsigned int b[6];
    if (sscanf(str, "%2x:%2x:%2x:%2x:%2x:%2x",
               &b[5], &b[4], &b[3], &b[2], &b[1], &b[0]) != 6) {
        return false;
    }
    for (int i = 0; i < 6; i++) out_le[i] = (uint8_t)b[i];
    return true;
}

static void set_session_cookie(httpd_req_t *req, const char *token)
{
    static char hdr[160];
    snprintf(hdr, sizeof(hdr), "sid=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400", token);
    httpd_resp_set_hdr(req, "Set-Cookie", hdr);
}

static void delayed_reboot_cb(void *arg)
{
    esp_restart();
}

static void schedule_reboot_ms(uint32_t ms)
{
    const esp_timer_create_args_t targs = { .callback = delayed_reboot_cb, .name = "sys_reboot" };
    esp_timer_handle_t t = NULL;
    if (esp_timer_create(&targs, &t) == ESP_OK) {
        esp_timer_start_once(t, (uint64_t)ms * 1000ULL);
    }
}

// ---------- Auth & Setup Handlers ----------

static esp_err_t handle_auth_status(httpd_req_t *req)
{
    cfg_settings_t cfg;
    cfg_settings_get(&cfg);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "setup_required", !cfg_auth_is_initialized());
    cJSON_AddBoolToObject(o, "authenticated", auth_mgr_check_req(req));
    cJSON_AddBoolToObject(o, "ap_mode", wifi_mgr_is_ap_active());
    cJSON_AddStringToObject(o, "hostname", cfg.hostname);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_setup_init(httpd_req_t *req)
{
    if (cfg_auth_is_initialized()) {
        return send_err(req, "403 Forbidden", "管理员密码已初始化");
    }
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *pw = cJSON_GetObjectItem(body, "password");
    if (!cJSON_IsString(pw) || strlen(pw->valuestring) < 4) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "密码长度至少 4 位");
    }

    esp_err_t err = cfg_auth_set_password(pw->valuestring);
    cJSON_Delete(body);
    if (err != ESP_OK) {
        return send_err(req, "500 Internal Server Error", "保存密码失败");
    }

    char tok[65];
    if (auth_mgr_create_session(tok, sizeof(tok)) == ESP_OK) {
        set_session_cookie(req, tok);
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_auth_login(httpd_req_t *req)
{
    if (!cfg_auth_is_initialized()) {
        return send_err(req, "400 Bad Request", "请先完成首次初始化");
    }
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *pw = cJSON_GetObjectItem(body, "password");
    if (!cJSON_IsString(pw)) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "缺少密码");
    }

    char tok[65];
    int retry_s = 0;
    esp_err_t err = auth_mgr_login(pw->valuestring, tok, sizeof(tok), &retry_s);
    cJSON_Delete(body);

    if (err == ESP_ERR_INVALID_STATE) {
        char msg[96];
        snprintf(msg, sizeof(msg), "登录失败次数过多，请在 %d 秒后重试", retry_s);
        return send_err(req, "429 Too Many Requests", msg);
    }
    if (err != ESP_OK) {
        return send_err(req, "401 Unauthorized", "密码错误");
    }

    set_session_cookie(req, tok);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_auth_logout(httpd_req_t *req)
{
    auth_mgr_logout_req(req);
    httpd_resp_set_hdr(req, "Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_auth_password(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *old_pw = cJSON_GetObjectItem(body, "old_password");
    const cJSON *new_pw = cJSON_GetObjectItem(body, "new_password");
    if (!cJSON_IsString(old_pw) || !cJSON_IsString(new_pw) || strlen(new_pw->valuestring) < 4) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "新密码长度至少 4 位");
    }
    if (!cfg_auth_verify_password(old_pw->valuestring)) {
        cJSON_Delete(body);
        return send_err(req, "403 Forbidden", "原密码错误");
    }

    esp_err_t err = cfg_auth_set_password(new_pw->valuestring);
    cJSON_Delete(body);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存失败");

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

// ---------- Wi-Fi Handlers ----------

static const char *authmode_str(wifi_auth_mode_t m)
{
    switch (m) {
    case WIFI_AUTH_OPEN:         return "OPEN";
    case WIFI_AUTH_WEP:          return "WEP";
    case WIFI_AUTH_WPA_PSK:      return "WPA";
    case WIFI_AUTH_WPA2_PSK:     return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA3_PSK:     return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK:return "WPA2/WPA3";
    default:                     return "SECURED";
    }
}

static esp_err_t handle_wifi_scan(httpd_req_t *req)
{
    if (!require_setup_or_auth(req)) return ESP_OK;

    wifi_scan_ap_t *aps = calloc(WIFI_SCAN_MAX_APS, sizeof(wifi_scan_ap_t));
    if (!aps) return send_err(req, "500 Internal Server Error", "内存不足");

    size_t cnt = 0;
    esp_err_t err = wifi_mgr_scan(aps, WIFI_SCAN_MAX_APS, &cnt);

    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_CreateArray();
    for (size_t i = 0; i < cnt; i++) {
        cJSON *a = cJSON_CreateObject();
        cJSON_AddStringToObject(a, "ssid", aps[i].ssid);
        cJSON_AddNumberToObject(a, "rssi", aps[i].rssi);
        cJSON_AddNumberToObject(a, "channel", aps[i].channel);
        cJSON_AddStringToObject(a, "auth", authmode_str(aps[i].authmode));
        cJSON_AddItemToArray(arr, a);
    }
    free(aps);

    cJSON_AddBoolToObject(root, "ok", err == ESP_OK);
    cJSON_AddItemToObject(root, "aps", arr);
    return send_json(req, err == ESP_OK ? "200 OK" : "500 Internal Server Error", root);
}

static esp_err_t handle_wifi_connect(httpd_req_t *req)
{
    if (!require_setup_or_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *ssid = cJSON_GetObjectItem(body, "ssid");
    const cJSON *pw = cJSON_GetObjectItem(body, "password");
    if (!cJSON_IsString(ssid) || ssid->valuestring[0] == '\0') {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "SSID 不能为空");
    }
    const char *pass_str = cJSON_IsString(pw) ? pw->valuestring : "";

    char ip[16] = {0};
    char err_msg[128] = {0};
    esp_err_t err = wifi_mgr_connect_test(ssid->valuestring, pass_str, ip, sizeof(ip), err_msg, sizeof(err_msg));
    cJSON_Delete(body);

    if (err != ESP_OK) {
        return send_err(req, "400 Bad Request", err_msg[0] ? err_msg : "连接失败");
    }

    cfg_settings_t cfg;
    cfg_settings_get(&cfg);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddStringToObject(o, "ip", ip);
    cJSON_AddStringToObject(o, "hostname", cfg.hostname);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_wifi_status(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    wifi_status_info_t ws;
    wifi_mgr_get_status(&ws);

    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "mode", ws.mode);
    cJSON_AddBoolToObject(o, "ap_active", ws.ap_active);
    cJSON_AddBoolToObject(o, "sta_connected", ws.sta_connected);
    cJSON_AddStringToObject(o, "ap_ssid", ws.ap_ssid);
    cJSON_AddStringToObject(o, "sta_ssid", ws.sta_ssid);
    cJSON_AddNumberToObject(o, "rssi", ws.rssi);
    cJSON_AddNumberToObject(o, "channel", ws.channel);
    cJSON_AddStringToObject(o, "ip", ws.ip);
    cJSON_AddStringToObject(o, "netmask", ws.netmask);
    cJSON_AddStringToObject(o, "gateway", ws.gateway);
    cJSON_AddStringToObject(o, "dns", ws.dns);
    cJSON_AddBoolToObject(o, "time_synced", ws.time_synced);
    return send_json(req, "200 OK", o);
}

// ---------- System & Settings & OTA Handlers ----------

static esp_err_t handle_system_info(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *info = sys_monitor_build_info_json();
    return send_json(req, "200 OK", info);
}

static esp_err_t handle_system_status(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *st = sys_monitor_build_telemetry_json();
    return send_json(req, "200 OK", st);
}

static esp_err_t handle_settings_get(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "hostname", cfg.hostname);
    cJSON_AddNumberToObject(o, "led_gpio", cfg.led_gpio);
    cJSON_AddNumberToObject(o, "led_brightness", cfg.led_brightness);
    cJSON_AddNumberToObject(o, "led_away_mode", cfg.led_away_mode);
    cJSON_AddBoolToObject(o, "led_idle_enabled", cfg.led_idle_enabled);
    cJSON_AddStringToObject(o, "ntp_server1", cfg.ntp_server1);
    cJSON_AddStringToObject(o, "ntp_server2", cfg.ntp_server2);
    cJSON_AddStringToObject(o, "timezone", cfg.timezone);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_settings_put(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 1024);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    const cJSON *v;
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "hostname"))) && v->valuestring[0]) {
        strlcpy(cfg.hostname, v->valuestring, sizeof(cfg.hostname));
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "led_gpio")))) {
        cfg.led_gpio = (int32_t)v->valuedouble;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "led_brightness")))) {
        int b = (int)v->valuedouble;
        cfg.led_brightness = (uint8_t)(b < 0 ? 0 : (b > 100 ? 100 : b));
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "led_away_mode")))) {
        cfg.led_away_mode = v->valuedouble ? 1 : 0;
    }
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "led_idle_enabled")))) {
        cfg.led_idle_enabled = cJSON_IsTrue(v);
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "ntp_server1"))) && v->valuestring[0]) {
        strlcpy(cfg.ntp_server1, v->valuestring, sizeof(cfg.ntp_server1));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "ntp_server2")))) {
        strlcpy(cfg.ntp_server2, v->valuestring, sizeof(cfg.ntp_server2));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "timezone"))) && v->valuestring[0]) {
        strlcpy(cfg.timezone, v->valuestring, sizeof(cfg.timezone));
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_settings_set(&cfg);
    if (err != ESP_OK) {
        return send_err(req, "400 Bad Request", "参数无效（注意 GPIO 35/36/37 不可用于 LED）");
    }

    led_ctrl_apply_settings(cfg.led_gpio, cfg.led_brightness, cfg.led_away_mode, cfg.led_idle_enabled);
    wifi_mgr_apply_settings();

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_ota_post(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    return ota_mgr_handle_upload(req);
}

static esp_err_t handle_ota_www_post(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    return ota_mgr_handle_www_upload(req);
}

static esp_err_t handle_system_reboot(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    send_json(req, "200 OK", o);
    schedule_reboot_ms(500);
    return ESP_OK;
}

static esp_err_t handle_system_factory_reset(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    led_ctrl_set_flag(LED_FLAG_FACTORY_RESET, true);
    auth_mgr_clear_all();
    cfg_store_factory_reset();

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    send_json(req, "200 OK", o);
    schedule_reboot_ms(700);
    return ESP_OK;
}

// ---------- Presence Handlers ----------

static cJSON *build_presence_persons_json(bool include_device_config)
{
    cJSON *arr = cJSON_CreateArray();
    ble_person_runtime_t *persons = calloc(CFG_MAX_PERSONS, sizeof(ble_person_runtime_t));
    ble_device_runtime_t *devs = calloc(CFG_MAX_DEVICES, sizeof(ble_device_runtime_t));
    if (!persons || !devs) {
        free(persons);
        free(devs);
        return arr;
    }

    size_t p_cnt = ble_presence_get_persons_runtime(persons, CFG_MAX_PERSONS);
    size_t d_cnt = ble_presence_get_devices_runtime(devs, CFG_MAX_DEVICES);

    for (size_t i = 0; i < p_cnt; i++) {
        cJSON *po = cJSON_CreateObject();
        cJSON_AddNumberToObject(po, "id", persons[i].id);
        cJSON_AddStringToObject(po, "name", persons[i].name);
        cJSON_AddBoolToObject(po, "is_home", persons[i].is_home);

        cJSON *darr = cJSON_CreateArray();
        for (size_t j = 0; j < d_cnt; j++) {
            if (devs[j].person_id != persons[i].id) continue;
            cJSON *do_ = cJSON_CreateObject();
            cJSON_AddNumberToObject(do_, "id", devs[j].id);
            cJSON_AddStringToObject(do_, "label", devs[j].label);
            cJSON_AddBoolToObject(do_, "is_home", devs[j].is_home);
            cJSON_AddNumberToObject(do_, "rssi", devs[j].smoothed_rssi);
            cJSON_AddNumberToObject(do_, "raw_rssi", devs[j].raw_rssi);
            cJSON_AddNumberToObject(do_, "seen_ago_s", devs[j].seen_ago_s);

            if (include_device_config) {
                char mac_str[18];
                format_mac_str(devs[j].mac, mac_str, sizeof(mac_str));
                cJSON_AddStringToObject(do_, "match_type", devs[j].match_type == MATCH_IRK ? "IRK" : "MAC");
                cJSON_AddStringToObject(do_, "mac", mac_str);
                cJSON_AddNumberToObject(do_, "enter_rssi", devs[j].enter_rssi);
                cJSON_AddNumberToObject(do_, "exit_rssi", devs[j].exit_rssi);
                cJSON_AddNumberToObject(do_, "away_timeout_s", devs[j].away_timeout_s);
            }
            cJSON_AddItemToArray(darr, do_);
        }
        cJSON_AddItemToObject(po, "devices", darr);
        cJSON_AddItemToArray(arr, po);
    }
    free(persons);
    free(devs);
    return arr;
}

static esp_err_t handle_presence_state(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    ble_summary_t bs;
    ble_presence_get_summary(&bs);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddItemToObject(root, "persons", build_presence_persons_json(true));

    cJSON *pair = cJSON_CreateObject();
    cJSON_AddBoolToObject(pair, "active", bs.pairing_active);
    cJSON_AddNumberToObject(pair, "person_id", bs.pairing_person_id);
    cJSON_AddNumberToObject(pair, "remaining_s", bs.pairing_remaining_s);
    cJSON_AddItemToObject(root, "pairing", pair);
    return send_json(req, "200 OK", root);
}

static esp_err_t handle_persons_post(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 256);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *name = cJSON_GetObjectItem(body, "name");
    if (!cJSON_IsString(name) || name->valuestring[0] == '\0') {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "姓名不能为空");
    }

    cfg_person_t created = {0};
    esp_err_t err = cfg_person_add(name->valuestring, &created);
    cJSON_Delete(body);

    if (err != ESP_OK) return send_err(req, "400 Bad Request", "添加失败（可能已达人数上限）");

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddNumberToObject(o, "id", created.id);
    cJSON_AddStringToObject(o, "name", created.name);
    return send_json(req, "200 OK", o);
}

static int parse_id_suffix(const char *uri, const char *prefix)
{
    size_t plen = strlen(prefix);
    if (strncmp(uri, prefix, plen) != 0) return -1;
    const char *p = uri + plen;
    if (*p == '\0') return -1;
    char *end = NULL;
    long val = strtol(p, &end, 10);
    if (end == p || (*end != '\0' && *end != '?') || val <= 0 || val > 255) return -1;
    return (int)val;
}

static esp_err_t handle_person_item(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    int id = parse_id_suffix(req->uri, "/api/presence/persons/");
    if (id < 0) return send_err(req, "400 Bad Request", "无效的人员 ID");

    if (req->method == HTTP_PUT) {
        cJSON *body = read_json_body(req, 256);
        if (!body) return send_err(req, "400 Bad Request", "请求体无效");
        const cJSON *name = cJSON_GetObjectItem(body, "name");
        if (!cJSON_IsString(name) || name->valuestring[0] == '\0') {
            cJSON_Delete(body);
            return send_err(req, "400 Bad Request", "姓名不能为空");
        }
        esp_err_t err = cfg_person_rename((uint8_t)id, name->valuestring);
        cJSON_Delete(body);
        if (err != ESP_OK) return send_err(req, "404 Not Found", "人员不存在");
    } else if (req->method == HTTP_DELETE) {
        ble_presence_on_person_deleted((uint8_t)id);
        esp_err_t err = cfg_person_delete((uint8_t)id);
        if (err != ESP_OK) return send_err(req, "404 Not Found", "人员不存在");
    } else {
        return send_err(req, "405 Method Not Allowed", "不支持的方法");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_devices_post(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *pid = cJSON_GetObjectItem(body, "person_id");
    const cJSON *label = cJSON_GetObjectItem(body, "label");
    const cJSON *mac = cJSON_GetObjectItem(body, "mac");
    if (!cJSON_IsNumber(pid) || !cJSON_IsString(label) || !cJSON_IsString(mac)) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "缺少必要字段");
    }

    cfg_device_t dev = {0};
    dev.person_id = (uint8_t)pid->valuedouble;
    strlcpy(dev.label, label->valuestring, sizeof(dev.label));
    dev.match_type = MATCH_FIXED_MAC;
    if (!parse_mac_str(mac->valuestring, dev.mac)) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "MAC 地址格式无效");
    }

    const cJSON *er = cJSON_GetObjectItem(body, "enter_rssi");
    const cJSON *xr = cJSON_GetObjectItem(body, "exit_rssi");
    const cJSON *at = cJSON_GetObjectItem(body, "away_timeout_s");
    dev.enter_rssi = cJSON_IsNumber(er) ? (int8_t)er->valuedouble : -75;
    dev.exit_rssi = cJSON_IsNumber(xr) ? (int8_t)xr->valuedouble : -85;
    dev.away_timeout_s = cJSON_IsNumber(at) ? (uint16_t)at->valuedouble : 120;
    cJSON_Delete(body);

    cfg_device_t saved = {0};
    esp_err_t err = cfg_device_add(&dev, &saved);
    if (err == ESP_ERR_INVALID_STATE) {
        return send_err(req, "409 Conflict", "该 MAC 设备已绑定");
    }
    if (err != ESP_OK) {
        return send_err(req, "400 Bad Request", "绑定设备失败");
    }
    ble_presence_reload_config();

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddNumberToObject(o, "id", saved.id);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_device_item(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    int id = parse_id_suffix(req->uri, "/api/presence/devices/");
    if (id < 0) return send_err(req, "400 Bad Request", "无效的设备 ID");

    if (req->method == HTTP_PUT) {
        cJSON *body = read_json_body(req, 512);
        if (!body) return send_err(req, "400 Bad Request", "请求体无效");

        cfg_device_t cur;
        if (!cfg_device_get((uint8_t)id, &cur)) {
            cJSON_Delete(body);
            return send_err(req, "404 Not Found", "设备不存在");
        }
        const cJSON *label = cJSON_GetObjectItem(body, "label");
        const cJSON *er = cJSON_GetObjectItem(body, "enter_rssi");
        const cJSON *xr = cJSON_GetObjectItem(body, "exit_rssi");
        const cJSON *at = cJSON_GetObjectItem(body, "away_timeout_s");

        char new_label[32];
        strlcpy(new_label, cJSON_IsString(label) ? label->valuestring : cur.label, sizeof(new_label));
        int8_t enter_rssi = cJSON_IsNumber(er) ? (int8_t)er->valuedouble : cur.enter_rssi;
        int8_t exit_rssi = cJSON_IsNumber(xr) ? (int8_t)xr->valuedouble : cur.exit_rssi;
        uint16_t away_to = cJSON_IsNumber(at) ? (uint16_t)at->valuedouble : cur.away_timeout_s;
        cJSON_Delete(body);

        esp_err_t err = cfg_device_update((uint8_t)id, new_label, enter_rssi, exit_rssi, away_to);
        if (err != ESP_OK) return send_err(req, "400 Bad Request", "更新失败");
    } else if (req->method == HTTP_DELETE) {
        ble_presence_on_device_deleted((uint8_t)id);
        esp_err_t err = cfg_device_delete((uint8_t)id);
        if (err != ESP_OK) return send_err(req, "404 Not Found", "设备不存在");
    } else {
        return send_err(req, "405 Method Not Allowed", "不支持的方法");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_pair_start(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 256);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *pid = cJSON_GetObjectItem(body, "person_id");
    const cJSON *label = cJSON_GetObjectItem(body, "label");
    const cJSON *to = cJSON_GetObjectItem(body, "timeout_s");
    if (!cJSON_IsNumber(pid) || !cJSON_IsString(label) || label->valuestring[0] == '\0') {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "缺少 person_id 或 label");
    }
    uint16_t timeout_s = cJSON_IsNumber(to) ? (uint16_t)to->valuedouble : 60;
    esp_err_t err = ble_presence_start_pairing((uint8_t)pid->valuedouble, label->valuestring, timeout_s);
    cJSON_Delete(body);

    if (err != ESP_OK) {
        return send_err(req, "409 Conflict", "无法启动配对（可能正在配对中或人员不存在）");
    }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_pair_stop(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    ble_presence_stop_pairing();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_presence_scan(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    ble_nearby_dev_t *list = calloc(BLE_NEARBY_MAX, sizeof(ble_nearby_dev_t));
    if (!list) return send_err(req, "500 Internal Server Error", "内存不足");

    size_t cnt = ble_presence_get_nearby(list, BLE_NEARBY_MAX);
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_CreateArray();
    for (size_t i = 0; i < cnt; i++) {
        cJSON *d = cJSON_CreateObject();
        char mac_str[18];
        format_mac_str(list[i].mac, mac_str, sizeof(mac_str));
        cJSON_AddStringToObject(d, "mac", mac_str);
        cJSON_AddStringToObject(d, "addr_type", list[i].addr_type == 0 ? "PUBLIC" : "RANDOM");
        cJSON_AddStringToObject(d, "name", list[i].name);
        cJSON_AddNumberToObject(d, "rssi", list[i].rssi);
        cJSON_AddNumberToObject(d, "seen_ago_s", list[i].seen_ago_s);
        cJSON_AddItemToArray(arr, d);
    }
    free(list);
    cJSON_AddItemToObject(root, "devices", arr);
    return send_json(req, "200 OK", root);
}

static esp_err_t handle_presence_logs_get(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    size_t limit = 50;
    size_t offset = 0;
    char qbuf[64];
    if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
        char val[16];
        if (httpd_query_key_value(qbuf, "limit", val, sizeof(val)) == ESP_OK) {
            long l = strtol(val, NULL, 10);
            if (l > 0 && l <= 200) limit = (size_t)l;
        }
        if (httpd_query_key_value(qbuf, "offset", val, sizeof(val)) == ESP_OK) {
            long o = strtol(val, NULL, 10);
            if (o >= 0) offset = (size_t)o;
        }
    }

    presence_log_entry_t *entries = calloc(limit, sizeof(presence_log_entry_t));
    if (!entries) return send_err(req, "500 Internal Server Error", "内存不足");

    size_t ret = 0, total = 0;
    presence_log_query(offset, limit, entries, &ret, &total);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "total", total);
    cJSON_AddNumberToObject(root, "offset", offset);
    cJSON_AddNumberToObject(root, "limit", limit);
    cJSON *arr = cJSON_CreateArray();
    for (size_t i = 0; i < ret; i++) {
        cJSON *e = cJSON_CreateObject();
        cJSON_AddNumberToObject(e, "seq", entries[i].seq);
        cJSON_AddNumberToObject(e, "timestamp", (double)entries[i].timestamp);
        cJSON_AddNumberToObject(e, "uptime_s", entries[i].uptime_s);
        cJSON_AddBoolToObject(e, "time_synced", entries[i].time_synced != 0);
        cJSON_AddNumberToObject(e, "person_id", entries[i].person_id);
        cJSON_AddStringToObject(e, "person_name", entries[i].person_name);
        cJSON_AddStringToObject(e, "event", entries[i].event == PRESENCE_EVENT_ARRIVE ? "ARRIVE" : "LEAVE");
        cJSON_AddStringToObject(e, "device", entries[i].device_label);
        cJSON_AddNumberToObject(e, "rssi", entries[i].rssi);
        cJSON_AddItemToArray(arr, e);
    }
    free(entries);
    cJSON_AddItemToObject(root, "logs", arr);
    return send_json(req, "200 OK", root);
}

static esp_err_t handle_presence_logs_delete(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    presence_log_clear();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

// ---------- Lamp (433MHz CC1101) Handlers ----------

static esp_err_t handle_lamp_state(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    return send_json(req, "200 OK", lamp_controller_build_state_json());
}

static esp_err_t handle_lamp_action(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 256);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *act = cJSON_GetObjectItem(body, "action");
    if (!cJSON_IsString(act)) {
        cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "缺少 action 字段");
    }
    char action[24];
    strlcpy(action, act->valuestring, sizeof(action));
    cJSON_Delete(body);

    esp_err_t err = ESP_ERR_INVALID_ARG;
    bool transmitted = false;
    if (strcmp(action, "on") == 0 || strcmp(action, "off") == 0) {
        err = lamp_controller_set_power(strcmp(action, "on") == 0, false, &transmitted);
    } else if (strcmp(action, "toggle") == 0) {
        err = lamp_controller_toggle(&transmitted);
    } else if (strcmp(action, "calibrate_on") == 0 || strcmp(action, "calibrate_off") == 0) {
        err = lamp_controller_sync_power(strcmp(action, "calibrate_on") == 0);
    } else {
        return send_err(req, "400 Bad Request", "未知的 action");
    }

    if (err != ESP_OK) {
        return send_err(req, "409 Conflict", "操作失败（请检查射频模块、信号样本或先校准状态）");
    }
    cJSON *o = lamp_controller_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddBoolToObject(o, "transmitted", transmitted);
    return send_json(req, "200 OK", o);
}

static esp_err_t lamp_history_chunk_writer(void *ctx, const char *data, size_t len)
{
    return httpd_resp_send_chunk((httpd_req_t *)ctx, data, (ssize_t)len);
}

static esp_err_t handle_lamp_history(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    char qbuf[96], from_s[24] = {0}, to_s[24] = {0};
    if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) != ESP_OK ||
        httpd_query_key_value(qbuf, "from", from_s, sizeof(from_s)) != ESP_OK ||
        httpd_query_key_value(qbuf, "to", to_s, sizeof(to_s)) != ESP_OK) {
        return send_err(req, "400 Bad Request", "缺少 from/to 参数");
    }
    int64_t from = strtoll(from_s, NULL, 10);
    int64_t to = strtoll(to_s, NULL, 10);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = lamp_history_write_json(from, to, lamp_history_chunk_writer, req);
    if (err == ESP_ERR_INVALID_ARG) {
        return send_err(req, "400 Bad Request", "时间范围无效（需按北京时间零点对齐且不超过 31 天）");
    }
    httpd_resp_send_chunk(req, NULL, 0);
    return ESP_OK;
}

static esp_err_t handle_lamp_automation(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 256);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_settings_t cfg;
    cfg_settings_get(&cfg);
    const cJSON *v;
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "auto_off_on_away")))) {
        cfg.lamp_auto_off_on_away = cJSON_IsTrue(v);
    }
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "auto_on_on_arrive")))) {
        cfg.lamp_auto_on_on_arrive = cJSON_IsTrue(v);
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_settings_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存联动设置失败");

    cJSON *o = lamp_controller_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_learn_start(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    esp_err_t err = lamp_controller_learn_start();
    if (err != ESP_OK) return send_err(req, "409 Conflict", "无法启动学习（射频未就绪或正在学习中）");
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_learn_test(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    esp_err_t err = lamp_controller_learn_test();
    if (err != ESP_OK) return send_err(req, "409 Conflict", "试播失败（无待保存信号或射频忙）");
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_learn_save(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    esp_err_t err = lamp_controller_learn_save();
    if (err != ESP_OK) return send_err(req, "409 Conflict", "保存信号失败");
    cJSON *o = lamp_controller_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_learn_cancel(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    lamp_controller_learn_cancel();
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_sample_upload(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    if (req->content_len < 44 || req->content_len > 36000) {
        return send_err(req, "400 Bad Request", "样本文件大小无效");
    }
    uint8_t *buf = malloc((size_t)req->content_len);
    if (!buf) return send_err(req, "500 Internal Server Error", "内存不足");

    int total = 0;
    while (total < req->content_len) {
        int r = httpd_req_recv(req, (char *)buf + total, req->content_len - total);
        if (r <= 0) {
            if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
            free(buf);
            return send_err(req, "400 Bad Request", "传输中断");
        }
        total += r;
    }

    esp_err_t err = lamp_controller_import_sample(buf, (size_t)total);
    free(buf);
    if (err != ESP_OK) {
        return send_err(req, "400 Bad Request", "无效的 .rf 样本文件或 CRC32 校验失败");
    }

    cJSON *o = lamp_controller_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static bool extract_siri_token(httpd_req_t *req, const char *qbuf, char *out, size_t out_len)
{
    out[0] = '\0';
    if (qbuf && qbuf[0] != '\0') {
        if (httpd_query_key_value(qbuf, "token", out, out_len) == ESP_OK && out[0] != '\0') {
            return true;
        }
    }
    if (httpd_req_get_hdr_value_str(req, "X-API-Key", out, out_len) == ESP_OK && out[0] != '\0') {
        return true;
    }
    char auth_hdr[96] = {0};
    if (httpd_req_get_hdr_value_str(req, "Authorization", auth_hdr, sizeof(auth_hdr)) == ESP_OK) {
        if (strncasecmp(auth_hdr, "Bearer ", 7) == 0 && auth_hdr[7] != '\0') {
            strlcpy(out, auth_hdr + 7, out_len);
            return true;
        }
    }
    return false;
}

static esp_err_t handle_lamp_siri(httpd_req_t *req)
{
    char qbuf[192] = {0};
    httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf));

    char token[64] = {0};
    if (!extract_siri_token(req, qbuf, token, sizeof(token)) || !cfg_siri_verify_token(token)) {
        return send_err(req, "401 Unauthorized", "Siri 快捷指令未启用或密钥无效");
    }

    char action[24] = "toggle";
    if (qbuf[0] != '\0') {
        char qa[24] = {0};
        if (httpd_query_key_value(qbuf, "action", qa, sizeof(qa)) == ESP_OK && qa[0] != '\0') {
            strlcpy(action, qa, sizeof(action));
        }
    }

    esp_err_t err = ESP_OK;
    bool transmitted = false;
    const char *msg = "操作成功";

    if (strcmp(action, "on") == 0) {
        err = lamp_controller_set_power(true, false, &transmitted);
        msg = transmitted ? "台灯已打开" : "台灯已经是开启状态";
    } else if (strcmp(action, "off") == 0) {
        err = lamp_controller_set_power(false, false, &transmitted);
        msg = transmitted ? "台灯已关闭" : "台灯已经是关闭状态";
    } else if (strcmp(action, "toggle") == 0) {
        err = lamp_controller_toggle(&transmitted);
        msg = "台灯已切换";
    } else if (strcmp(action, "status") == 0) {
        msg = "查询成功";
    } else {
        return send_err(req, "400 Bad Request", "不支持的 action（可选 on / off / toggle / status）");
    }

    if (err != ESP_OK) {
        lamp_status_t st;
        lamp_controller_status(&st);
        if (!st.power_known && (strcmp(action, "on") == 0 || strcmp(action, "off") == 0)) {
            return send_err(req, "409 Conflict", "台灯未校准，请先在网页校准一次，或使用 action=toggle 直接切换");
        }
        return send_err(req, "409 Conflict", "控制失败，请检查射频模块与遥控样本");
    }

    lamp_status_t st;
    lamp_controller_status(&st);
    if (strcmp(action, "toggle") == 0 && st.power_known) {
        msg = st.power_on ? "台灯已打开" : "台灯已关闭";
    } else if (strcmp(action, "status") == 0) {
        msg = !st.power_known ? "台灯状态未校准" : (st.power_on ? "台灯当前已打开" : "台灯当前已关闭");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddStringToObject(o, "action", action);
    cJSON_AddBoolToObject(o, "transmitted", transmitted);
    cJSON_AddBoolToObject(o, "power_known", st.power_known);
    cJSON_AddBoolToObject(o, "power_on", st.power_on);
    cJSON_AddStringToObject(o, "message", msg);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_lamp_siri_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 256);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    const cJSON *en = cJSON_GetObjectItem(body, "enabled");
    const cJSON *regen = cJSON_GetObjectItem(body, "regenerate");
    bool has_en = cJSON_IsBool(en);
    bool en_val = has_en && cJSON_IsTrue(en);
    bool do_regen = cJSON_IsBool(regen) && cJSON_IsTrue(regen);
    cJSON_Delete(body);

    if (has_en) {
        esp_err_t err = cfg_siri_set_enabled(en_val);
        if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存 Siri 开关失败");
    }
    if (do_regen) {
        esp_err_t err = cfg_siri_regenerate_token(NULL);
        if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "重置 Siri 密钥失败");
    }

    cJSON *o = lamp_controller_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

// ---------- WOL & MQTT Bridge Handlers ----------

static esp_err_t handle_wol_state(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    return send_json(req, "200 OK", wol_mgr_build_state_json());
}

static esp_err_t handle_wol_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_wol_t cfg;
    cfg_wol_get(&cfg);

    const cJSON *v;
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "name"))) && v->valuestring[0]) {
        strlcpy(cfg.name, v->valuestring, sizeof(cfg.name));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "ip")))) {
        strlcpy(cfg.ip, v->valuestring, sizeof(cfg.ip));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "mac"))) && v->valuestring[0]) {
        uint8_t mac_bytes[6];
        if (!wol_mgr_parse_mac(v->valuestring, mac_bytes)) {
            cJSON_Delete(body);
            return send_err(req, "400 Bad Request", "MAC 地址格式无效");
        }
        wol_mgr_format_mac(mac_bytes, cfg.mac, sizeof(cfg.mac));
    }
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "auto_wake_on_arrive")))) {
        cfg.auto_wake_on_arrive = cJSON_IsTrue(v);
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "auto_cooldown_s")))) {
        int cd = (int)v->valuedouble;
        if (cd < 30) cd = 30;
        if (cd > 86400) cd = 86400;
        cfg.auto_cooldown_s = (uint16_t)cd;
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_wol_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存 WOL 配置失败");

    wol_mgr_broadcast_state();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_wol_wake(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    int sent = 0;
    esp_err_t err = wol_mgr_wake("网页控制台", &sent);
    if (err != ESP_OK) {
        return send_err(req, "500 Internal Server Error", "发送魔术包失败（请检查 MAC 格式与 Wi-Fi 连接）");
    }
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddNumberToObject(o, "sent", sent);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_wol_probe(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    wol_mgr_probe_now();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_mqtt_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 1024);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_mqtt_t cfg;
    cfg_mqtt_get(&cfg);

    const cJSON *v;
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "enabled")))) {
        cfg.enabled = cJSON_IsTrue(v);
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "host")))) {
        strlcpy(cfg.host, v->valuestring, sizeof(cfg.host));
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "port")))) {
        int p = (int)v->valuedouble;
        if (p > 0 && p <= 65535) cfg.port = (uint16_t)p;
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "client_id")))) {
        strlcpy(cfg.client_id, v->valuestring, sizeof(cfg.client_id));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "username")))) {
        strlcpy(cfg.username, v->valuestring, sizeof(cfg.username));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "password")))) {
        strlcpy(cfg.password, v->valuestring, sizeof(cfg.password));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "wol_topic")))) {
        strlcpy(cfg.wol_topic, v->valuestring, sizeof(cfg.wol_topic));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "lamp_topic")))) {
        strlcpy(cfg.lamp_topic, v->valuestring, sizeof(cfg.lamp_topic));
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_mqtt_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存 MQTT 配置失败");

    mqtt_bridge_reload();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_mqtt_reconnect(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    mqtt_bridge_reload();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_tunnel_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_tunnel_t cfg;
    cfg_tunnel_get(&cfg);

    const cJSON *v;
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "enabled")))) {
        cfg.enabled = cJSON_IsTrue(v);
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "url")))) {
        strlcpy(cfg.url, v->valuestring, sizeof(cfg.url));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "secret")))) {
        strlcpy(cfg.secret, v->valuestring, sizeof(cfg.secret));
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_tunnel_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存云端隧道配置失败");

    cloud_tunnel_reload();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_tunnel_reconnect(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cloud_tunnel_reload();
    cJSON *o = wol_mgr_build_state_json();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_siri_wol_wake(httpd_req_t *req)
{
    char qbuf[192] = {0};
    httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf));

    char token[64] = {0};
    if (!extract_siri_token(req, qbuf, token, sizeof(token)) || !cfg_siri_verify_token(token)) {
        return send_err(req, "401 Unauthorized", "Siri 快捷指令未启用或密钥无效");
    }

    int sent = 0;
    esp_err_t err = wol_mgr_wake("Siri 快捷指令", &sent);
    if (err != ESP_OK) {
        return send_err(req, "500 Internal Server Error", "发送魔术包失败");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddNumberToObject(o, "sent", sent);
    cJSON_AddBoolToObject(o, "online", wol_mgr_is_online());
    cJSON_AddStringToObject(o, "message", "已发送电脑开机信号");
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_siri_wol_status(httpd_req_t *req)
{
    char qbuf[192] = {0};
    httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf));

    char token[64] = {0};
    if (!extract_siri_token(req, qbuf, token, sizeof(token)) || !cfg_siri_verify_token(token)) {
        return send_err(req, "401 Unauthorized", "Siri 快捷指令未启用或密钥无效");
    }

    cfg_wol_t cfg;
    cfg_wol_get(&cfg);
    bool online = wol_mgr_probe_now();

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddBoolToObject(o, "online", online);
    cJSON_AddStringToObject(o, "ip", cfg.ip);
    cJSON_AddStringToObject(o, "mac", cfg.mac);
    cJSON_AddStringToObject(o, "message", online ? "电脑当前已开机" : "电脑当前已关机");
    return send_json(req, "200 OK", o);
}

// ---------- Living Cost (/data/living_cost.json) Handlers ----------

static esp_err_t handle_living_cost_get(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    xSemaphoreTake(s_cost_mutex, portMAX_DELAY);
    struct stat st;
    if (stat(LIVING_COST_PATH, &st) != 0 || st.st_size <= 0 || st.st_size > LIVING_COST_MAX_BYTES) {
        xSemaphoreGive(s_cost_mutex);
        cJSON *o = cJSON_CreateObject();
        cJSON_AddBoolToObject(o, "initialized", false);
        return send_json(req, "200 OK", o);
    }

    char *buf = malloc((size_t)st.st_size + 1);
    if (!buf) {
        xSemaphoreGive(s_cost_mutex);
        return send_err(req, "500 Internal Server Error", "内存不足");
    }

    FILE *f = fopen(LIVING_COST_PATH, "rb");
    size_t n = 0;
    if (f) {
        n = fread(buf, 1, (size_t)st.st_size, f);
        fclose(f);
    }
    xSemaphoreGive(s_cost_mutex);

    if (!f || n == 0) {
        free(buf);
        cJSON *o = cJSON_CreateObject();
        cJSON_AddBoolToObject(o, "initialized", false);
        return send_json(req, "200 OK", o);
    }

    buf[n] = '\0';
    httpd_resp_set_status(req, "200 OK");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_send(req, buf, (ssize_t)n);
    free(buf);
    return ESP_OK;
}

static esp_err_t handle_living_cost_put(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;

    cJSON *body = read_json_body(req, LIVING_COST_MAX_BYTES);
    if (!body || !cJSON_IsObject(body) || !cJSON_IsArray(cJSON_GetObjectItem(body, "records"))) {
        if (body) cJSON_Delete(body);
        return send_err(req, "400 Bad Request", "账单数据格式无效");
    }

    char *str = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (!str) {
        return send_err(req, "500 Internal Server Error", "序列化账单失败");
    }

    size_t len = strlen(str);
    if (len > LIVING_COST_MAX_BYTES) {
        cJSON_free(str);
        return send_err(req, "400 Bad Request", "账单数据超出大小限制");
    }

    xSemaphoreTake(s_cost_mutex, portMAX_DELAY);
    bool ok = false;
    FILE *f = fopen(LIVING_COST_TMP_PATH, "wb");
    if (f) {
        ok = (fwrite(str, 1, len, f) == len) && (fflush(f) == 0) && (fsync(fileno(f)) == 0);
        if (fclose(f) != 0) ok = false;
        if (ok) {
            remove(LIVING_COST_PATH);
            if (rename(LIVING_COST_TMP_PATH, LIVING_COST_PATH) != 0) {
                ok = false;
            }
        }
        if (!ok) {
            remove(LIVING_COST_TMP_PATH);
        }
    }
    xSemaphoreGive(s_cost_mutex);
    cJSON_free(str);

    if (!ok) {
        return send_err(req, "500 Internal Server Error", "写入 Flash 账单文件失败");
    }

    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddNumberToObject(o, "bytes", (double)len);
    return send_json(req, "200 OK", o);
}

// ---------- Environment Sensor (Xiaomi BLE MiBeacon) Handlers ----------

static void attach_env_siri_info(cJSON *o)
{
    if (!o) return;
    cfg_siri_t siri;
    cfg_siri_get(&siri);
    cJSON *so = cJSON_CreateObject();
    cJSON_AddBoolToObject(so, "enabled", siri.enabled);
    cJSON_AddStringToObject(so, "token", siri.token);
    cJSON_AddItemToObject(o, "siri", so);
}

static bool parse_hex_bindkey(const char *str, uint8_t out[16])
{
    if (!str) return false;
    char clean[33];
    size_t n = 0;
    for (const char *p = str; *p; p++) {
        if (*p == ' ' || *p == '\t' || *p == '-' || *p == ':') continue;
        if (n >= 32) return false;
        char c = *p;
        bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!is_hex) return false;
        clean[n++] = c;
    }
    if (n != 32) return false;
    clean[32] = '\0';
    for (int i = 0; i < 16; i++) {
        unsigned int byte = 0;
        if (sscanf(&clean[i * 2], "%2x", &byte) != 1) return false;
        out[i] = (uint8_t)byte;
    }
    return true;
}

static esp_err_t handle_env_state(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *o = env_sensor_build_state_json();
    attach_env_siri_info(o);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_env_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 768);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_env_t cfg;
    cfg_env_get(&cfg);

    const cJSON *v;
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "enabled")))) {
        cfg.enabled = cJSON_IsTrue(v);
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "name"))) && v->valuestring[0]) {
        strlcpy(cfg.name, v->valuestring, sizeof(cfg.name));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "mac"))) && v->valuestring[0]) {
        uint8_t mac_le[6];
        if (!parse_mac_str(v->valuestring, mac_le)) {
            cJSON_Delete(body);
            return send_err(req, "400 Bad Request", "蓝牙 MAC 地址格式无效（需 AA:BB:CC:DD:EE:FF）");
        }
        memcpy(cfg.mac, mac_le, 6);
    }
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "clear_bindkey"))) && cJSON_IsTrue(v)) {
        cfg.has_bindkey = false;
        memset(cfg.bindkey, 0, sizeof(cfg.bindkey));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "bindkey"))) && v->valuestring[0]) {
        uint8_t key[16];
        if (!parse_hex_bindkey(v->valuestring, key)) {
            cJSON_Delete(body);
            return send_err(req, "400 Bad Request", "Bindkey 格式无效（需 32 位十六进制字符）");
        }
        memcpy(cfg.bindkey, key, 16);
        cfg.has_bindkey = true;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "temp_low")))) {
        cfg.temp_low = (float)v->valuedouble;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "temp_high")))) {
        cfg.temp_high = (float)v->valuedouble;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "hum_low")))) {
        cfg.hum_low = (float)v->valuedouble;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "hum_high")))) {
        cfg.hum_high = (float)v->valuedouble;
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_env_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存环境传感器配置失败");

    env_sensor_reload_config();
    cJSON *o = env_sensor_build_state_json();
    attach_env_siri_info(o);
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_env_history_get(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    char qbuf[64] = {0};
    char range[16] = "24h";
    if (httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf)) == ESP_OK) {
        httpd_query_key_value(qbuf, "range", range, sizeof(range));
    }
    return send_json(req, "200 OK", env_sensor_build_history_json(range));
}

static esp_err_t handle_env_history_delete(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    esp_err_t err = env_sensor_clear_history();
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "清空环境历史失败");
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    return send_json(req, "200 OK", o);
}

static esp_err_t handle_env_siri(httpd_req_t *req)
{
    char qbuf[192] = {0};
    httpd_req_get_url_query_str(req, qbuf, sizeof(qbuf));

    char token[64] = {0};
    if (!extract_siri_token(req, qbuf, token, sizeof(token)) || !cfg_siri_verify_token(token)) {
        return send_err(req, "401 Unauthorized", "Siri 快捷指令未启用或密钥无效");
    }

    return send_json(req, "200 OK", env_sensor_build_siri_json());
}

// ---------- K230 Camera LAN Config Handlers ----------

static cJSON *build_cam_status_json(const cfg_cam_t *c)
{
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", true);
    cJSON_AddStringToObject(o, "via", "lan");
    cJSON_AddBoolToObject(o, "online", c->lan_url[0] != '\0');
    cJSON_AddBoolToObject(o, "streaming", !c->privacy && c->lan_url[0] != '\0');
    cJSON_AddBoolToObject(o, "privacy", c->privacy);
    cJSON_AddBoolToObject(o, "away_only", c->away_only);
    cJSON_AddBoolToObject(o, "home_blocked", false);
    cJSON_AddNumberToObject(o, "viewers", 1);
    cJSON_AddStringToObject(o, "lan_ip", "");
    cJSON_AddStringToObject(o, "lan_url", c->lan_url);
    cJSON_AddStringToObject(o, "res", c->res);
    cJSON_AddNumberToObject(o, "fps", c->fps);
    cJSON_AddNumberToObject(o, "quality", c->quality);
    cJSON_AddNumberToObject(o, "frame_bytes", 0);
    cJSON_AddNumberToObject(o, "actual_fps", 0);
    cJSON_AddNumberToObject(o, "last_frame_ago_s", -1);
    return o;
}

static esp_err_t handle_cam_status(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cfg_cam_t cfg;
    cfg_cam_get(&cfg);
    return send_json(req, "200 OK", build_cam_status_json(&cfg));
}

static esp_err_t handle_cam_config(httpd_req_t *req)
{
    if (!require_auth(req)) return ESP_OK;
    cJSON *body = read_json_body(req, 512);
    if (!body) return send_err(req, "400 Bad Request", "请求体无效");

    cfg_cam_t cfg;
    cfg_cam_get(&cfg);

    const cJSON *v;
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "privacy")))) {
        cfg.privacy = cJSON_IsTrue(v);
    }
    if (cJSON_IsBool((v = cJSON_GetObjectItem(body, "away_only")))) {
        cfg.away_only = cJSON_IsTrue(v);
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "lan_url")))) {
        strlcpy(cfg.lan_url, v->valuestring, sizeof(cfg.lan_url));
    }
    if (cJSON_IsString((v = cJSON_GetObjectItem(body, "res")))) {
        if (strcmp(v->valuestring, "640x368") == 0 ||
            strcmp(v->valuestring, "1280x720") == 0 ||
            strcmp(v->valuestring, "1920x1080") == 0) {
            strlcpy(cfg.res, v->valuestring, sizeof(cfg.res));
        }
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "fps")))) {
        int f = (int)v->valuedouble;
        if (f < 1) f = 1;
        if (f > 30) f = 30;
        cfg.fps = (uint8_t)f;
    }
    if (cJSON_IsNumber((v = cJSON_GetObjectItem(body, "quality")))) {
        int q = (int)v->valuedouble;
        if (q < 30) q = 30;
        if (q > 95) q = 95;
        cfg.quality = (uint8_t)q;
    }
    cJSON_Delete(body);

    esp_err_t err = cfg_cam_set(&cfg);
    if (err != ESP_OK) return send_err(req, "500 Internal Server Error", "保存摄像头配置失败");
    return send_json(req, "200 OK", build_cam_status_json(&cfg));
}

// ---------- WebSocket Handler ----------

#ifdef CONFIG_HTTPD_WS_PRE_HANDSHAKE_CB_SUPPORT
static esp_err_t ws_pre_handshake(httpd_req_t *req)
{
    if (!auth_mgr_check_req(req)) {
        httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "Unauthorized");
        return ESP_FAIL;
    }
    return ESP_OK;
}
#endif

static esp_err_t handle_ws(httpd_req_t *req)
{
    if (req->method == HTTP_GET) {
        if (!auth_mgr_check_req(req)) {
            httpd_sess_trigger_close(req->handle, httpd_req_to_sockfd(req));
            return ESP_FAIL;
        }
        ws_client_add(httpd_req_to_sockfd(req));
        return ESP_OK;
    }

    httpd_ws_frame_t frame;
    memset(&frame, 0, sizeof(frame));
    esp_err_t ret = httpd_ws_recv_frame(req, &frame, 0);
    if (ret != ESP_OK) return ret;

    if (frame.type == HTTPD_WS_TYPE_CLOSE) {
        ws_client_remove(httpd_req_to_sockfd(req));
        return ESP_OK;
    }

    if (frame.len > 0 && frame.len < 512) {
        uint8_t *buf = malloc(frame.len + 1);
        if (buf) {
            frame.payload = buf;
            if (httpd_ws_recv_frame(req, &frame, frame.len) == ESP_OK) {
                if (frame.type == HTTPD_WS_TYPE_PING) {
                    frame.type = HTTPD_WS_TYPE_PONG;
                    httpd_ws_send_frame(req, &frame);
                }
            }
            free(buf);
        }
    }
    return ESP_OK;
}

// ---------- Captive Portal & Static Gzip Handler ----------

static bool is_captive_probe_uri(const char *uri)
{
    return strcmp(uri, "/generate_204") == 0 ||
           strcmp(uri, "/gen_204") == 0 ||
           strcmp(uri, "/hotspot-detect.html") == 0 ||
           strcmp(uri, "/library/test/success.html") == 0 ||
           strcmp(uri, "/connecttest.txt") == 0 ||
           strcmp(uri, "/ncsi.txt") == 0 ||
           strcmp(uri, "/canonical.html") == 0 ||
           strcmp(uri, "/success.txt") == 0;
}

static bool is_local_host_hdr(httpd_req_t *req)
{
    char host[96] = {0};
    if (httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) != ESP_OK) {
        return true;
    }
    char *colon = strchr(host, ':');
    if (colon) *colon = '\0';

    if (strcmp(host, "192.168.4.1") == 0 || strcmp(host, "localhost") == 0) {
        return true;
    }
    size_t len = strlen(host);
    if (len > 6 && strcmp(host + len - 6, ".local") == 0) {
        return true;
    }
    return false;
}

static const char *mime_type_for_path(const char *path)
{
    size_t len = strlen(path);
    if (len >= 5 && strcmp(path + len - 5, ".html") == 0) return "text/html; charset=utf-8";
    if (len >= 3 && strcmp(path + len - 3, ".js") == 0)   return "application/javascript; charset=utf-8";
    if (len >= 4 && strcmp(path + len - 4, ".css") == 0)  return "text/css; charset=utf-8";
    if (len >= 4 && strcmp(path + len - 4, ".svg") == 0)  return "image/svg+xml";
    if (len >= 5 && strcmp(path + len - 5, ".json") == 0) return "application/json";
    if (len >= 4 && strcmp(path + len - 4, ".png") == 0)  return "image/png";
    if (len >= 4 && strcmp(path + len - 4, ".ico") == 0)  return "image/x-icon";
    return "application/octet-stream";
}

static esp_err_t handle_static_get(httpd_req_t *req)
{
    // Strip query string
    char clean_uri[256];
    strlcpy(clean_uri, req->uri, sizeof(clean_uri));
    char *q = strchr(clean_uri, '?');
    if (q) *q = '\0';

    if (strncmp(clean_uri, "/api/", 5) == 0) {
        return send_err(req, "404 Not Found", "API endpoint not found");
    }

    if (wifi_mgr_is_ap_active() && (is_captive_probe_uri(clean_uri) || !is_local_host_hdr(req))) {
        httpd_resp_set_status(req, "302 Found");
        httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
        httpd_resp_send(req, NULL, 0);
        return ESP_OK;
    }

    if (strcmp(clean_uri, "/") == 0) {
        strlcpy(clean_uri, "/index.html", sizeof(clean_uri));
    }

    // Reject path traversal
    if (strstr(clean_uri, "..") != NULL) {
        httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Forbidden");
        return ESP_OK;
    }

    char gz_path[280];
    snprintf(gz_path, sizeof(gz_path), "/www%s.gz", clean_uri);

    struct stat st;
    bool is_gz = false;
    char open_path[280];

    if (stat(gz_path, &st) == 0 && S_ISREG(st.st_mode)) {
        strlcpy(open_path, gz_path, sizeof(open_path));
        is_gz = true;
    } else {
        snprintf(open_path, sizeof(open_path), "/www%s", clean_uri);
        if (stat(open_path, &st) != 0 || !S_ISREG(st.st_mode)) {
            // SPA fallback to index.html.gz
            strlcpy(clean_uri, "/index.html", sizeof(clean_uri));
            strlcpy(open_path, "/www/index.html.gz", sizeof(open_path));
            if (stat(open_path, &st) == 0 && S_ISREG(st.st_mode)) {
                is_gz = true;
            } else {
                httpd_resp_send_404(req);
                return ESP_OK;
            }
        }
    }

    FILE *f = fopen(open_path, "rb");
    if (!f) {
        httpd_resp_send_404(req);
        return ESP_OK;
    }

    httpd_resp_set_type(req, mime_type_for_path(clean_uri));
    if (is_gz) {
        httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    }
    if (strstr(clean_uri, "/assets/") != NULL) {
        httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=86400");
    } else {
        httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    }

    char *buf = malloc(4096);
    if (!buf) {
        fclose(f);
        httpd_resp_send_500(req);
        return ESP_OK;
    }

    size_t n;
    while ((n = fread(buf, 1, 4096, f)) > 0) {
        if (httpd_resp_send_chunk(req, buf, n) != ESP_OK) {
            break;
        }
    }
    httpd_resp_send_chunk(req, NULL, 0);

    free(buf);
    fclose(f);
    return ESP_OK;
}

// ---------- 1Hz Telemetry & Presence Broadcast Task ----------

static void ws_broadcast_task(void *arg)
{
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (ws_client_count() == 0 && !cloud_tunnel_is_connected()) continue;

        cJSON *tel = sys_monitor_build_telemetry_json();
        if (tel) {
            char *str = cJSON_PrintUnformatted(tel);
            cJSON_Delete(tel);
            if (str) {
                web_server_ws_broadcast(str);
                cJSON_free(str);
            }
        }

        cJSON *persons = build_presence_persons_json(false);
        if (persons && cJSON_GetArraySize(persons) > 0) {
            cJSON *tick = cJSON_CreateObject();
            cJSON_AddStringToObject(tick, "type", "presence_tick");
            cJSON_AddItemToObject(tick, "persons", persons);
            char *str = cJSON_PrintUnformatted(tick);
            cJSON_Delete(tick);
            if (str) {
                web_server_ws_broadcast(str);
                cJSON_free(str);
            }
        } else if (persons) {
            cJSON_Delete(persons);
        }
    }
}

esp_err_t web_server_start(void)
{
    auth_mgr_init();
    s_ws_mutex = xSemaphoreCreateMutex();
    s_cost_mutex = xSemaphoreCreateMutex();
    if (!s_ws_mutex || !s_cost_mutex) return ESP_ERR_NO_MEM;
    for (int i = 0; i < MAX_WS_CLIENTS; i++) s_ws_fds[i] = -1;

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = 80;
    cfg.max_uri_handlers = 80;
    cfg.max_open_sockets = 10;
    cfg.lru_purge_enable = true;
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.stack_size = 8192;
    cfg.recv_wait_timeout = 10;
    cfg.send_wait_timeout = 10;
    cfg.close_fn = on_httpd_close;

    esp_err_t err = httpd_start(&s_httpd, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    const httpd_uri_t routes[] = {
        { .uri = "/api/auth/status",           .method = HTTP_GET,    .handler = handle_auth_status },
        { .uri = "/api/setup/init",            .method = HTTP_POST,   .handler = handle_setup_init },
        { .uri = "/api/auth/login",            .method = HTTP_POST,   .handler = handle_auth_login },
        { .uri = "/api/auth/logout",           .method = HTTP_POST,   .handler = handle_auth_logout },
        { .uri = "/api/auth/password",         .method = HTTP_POST,   .handler = handle_auth_password },
        { .uri = "/api/wifi/scan",             .method = HTTP_GET,    .handler = handle_wifi_scan },
        { .uri = "/api/wifi/connect",          .method = HTTP_POST,   .handler = handle_wifi_connect },
        { .uri = "/api/wifi/status",           .method = HTTP_GET,    .handler = handle_wifi_status },
        { .uri = "/api/system/info",           .method = HTTP_GET,    .handler = handle_system_info },
        { .uri = "/api/system/status",         .method = HTTP_GET,    .handler = handle_system_status },
        { .uri = "/api/settings",              .method = HTTP_GET,    .handler = handle_settings_get },
        { .uri = "/api/settings",              .method = HTTP_PUT,    .handler = handle_settings_put },
        { .uri = "/api/ota",                   .method = HTTP_POST,   .handler = handle_ota_post },
        { .uri = "/api/ota/www",               .method = HTTP_POST,   .handler = handle_ota_www_post },
        { .uri = "/api/system/reboot",         .method = HTTP_POST,   .handler = handle_system_reboot },
        { .uri = "/api/system/factory-reset",  .method = HTTP_POST,   .handler = handle_system_factory_reset },
        { .uri = "/api/presence/state",        .method = HTTP_GET,    .handler = handle_presence_state },
        { .uri = "/api/presence/persons",      .method = HTTP_POST,   .handler = handle_persons_post },
        { .uri = "/api/presence/persons/*",    .method = HTTP_PUT,    .handler = handle_person_item },
        { .uri = "/api/presence/persons/*",    .method = HTTP_DELETE, .handler = handle_person_item },
        { .uri = "/api/presence/devices",      .method = HTTP_POST,   .handler = handle_devices_post },
        { .uri = "/api/presence/devices/*",    .method = HTTP_PUT,    .handler = handle_device_item },
        { .uri = "/api/presence/devices/*",    .method = HTTP_DELETE, .handler = handle_device_item },
        { .uri = "/api/presence/pair/start",   .method = HTTP_POST,   .handler = handle_pair_start },
        { .uri = "/api/presence/pair/stop",    .method = HTTP_POST,   .handler = handle_pair_stop },
        { .uri = "/api/presence/scan",         .method = HTTP_GET,    .handler = handle_presence_scan },
        { .uri = "/api/presence/logs",         .method = HTTP_GET,    .handler = handle_presence_logs_get },
        { .uri = "/api/presence/logs",         .method = HTTP_DELETE, .handler = handle_presence_logs_delete },
        { .uri = "/api/lamp/state",            .method = HTTP_GET,    .handler = handle_lamp_state },
        { .uri = "/api/lamp/action",           .method = HTTP_POST,   .handler = handle_lamp_action },
        { .uri = "/api/lamp/history",          .method = HTTP_GET,    .handler = handle_lamp_history },
        { .uri = "/api/lamp/automation",       .method = HTTP_PUT,    .handler = handle_lamp_automation },
        { .uri = "/api/lamp/learn/start",      .method = HTTP_POST,   .handler = handle_lamp_learn_start },
        { .uri = "/api/lamp/learn/test",       .method = HTTP_POST,   .handler = handle_lamp_learn_test },
        { .uri = "/api/lamp/learn/save",       .method = HTTP_POST,   .handler = handle_lamp_learn_save },
        { .uri = "/api/lamp/learn/cancel",     .method = HTTP_POST,   .handler = handle_lamp_learn_cancel },
        { .uri = "/api/lamp/sample/upload",    .method = HTTP_POST,   .handler = handle_lamp_sample_upload },
        { .uri = "/api/lamp/siri",             .method = HTTP_GET,    .handler = handle_lamp_siri },
        { .uri = "/api/lamp/siri",             .method = HTTP_POST,   .handler = handle_lamp_siri },
        { .uri = "/api/lamp/siri/config",      .method = HTTP_PUT,    .handler = handle_lamp_siri_config },
        { .uri = "/api/wol/state",             .method = HTTP_GET,    .handler = handle_wol_state },
        { .uri = "/api/wol/config",            .method = HTTP_PUT,    .handler = handle_wol_config },
        { .uri = "/api/wol/wake",              .method = HTTP_POST,   .handler = handle_wol_wake },
        { .uri = "/api/wol/probe",             .method = HTTP_POST,   .handler = handle_wol_probe },
        { .uri = "/api/mqtt/config",           .method = HTTP_PUT,    .handler = handle_mqtt_config },
        { .uri = "/api/mqtt/reconnect",        .method = HTTP_POST,   .handler = handle_mqtt_reconnect },
        { .uri = "/api/tunnel/config",         .method = HTTP_PUT,    .handler = handle_tunnel_config },
        { .uri = "/api/tunnel/reconnect",      .method = HTTP_POST,   .handler = handle_tunnel_reconnect },
        { .uri = "/api/siri/wol/wake",         .method = HTTP_GET,    .handler = handle_siri_wol_wake },
        { .uri = "/api/siri/wol/wake",         .method = HTTP_POST,   .handler = handle_siri_wol_wake },
        { .uri = "/api/siri/wol/status",       .method = HTTP_GET,    .handler = handle_siri_wol_status },
        { .uri = "/api/living-cost",           .method = HTTP_GET,    .handler = handle_living_cost_get },
        { .uri = "/api/living-cost",           .method = HTTP_PUT,    .handler = handle_living_cost_put },
        { .uri = "/api/env/state",             .method = HTTP_GET,    .handler = handle_env_state },
        { .uri = "/api/env/config",            .method = HTTP_PUT,    .handler = handle_env_config },
        { .uri = "/api/env/history",           .method = HTTP_GET,    .handler = handle_env_history_get },
        { .uri = "/api/env/history",           .method = HTTP_DELETE, .handler = handle_env_history_delete },
        { .uri = "/api/env/siri",              .method = HTTP_GET,    .handler = handle_env_siri },
        { .uri = "/api/env/siri",              .method = HTTP_POST,   .handler = handle_env_siri },
        { .uri = "/api/cam/status",            .method = HTTP_GET,    .handler = handle_cam_status },
        { .uri = "/api/cam/config",            .method = HTTP_PUT,    .handler = handle_cam_config },
    };

    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        ESP_ERROR_CHECK(httpd_register_uri_handler(s_httpd, &routes[i]));
    }

    httpd_uri_t ws_uri = {
        .uri = "/ws",
        .method = HTTP_GET,
        .handler = handle_ws,
        .is_websocket = true,
        .handle_ws_control_frames = true,
#ifdef CONFIG_HTTPD_WS_PRE_HANDSHAKE_CB_SUPPORT
        .ws_pre_handshake_cb = ws_pre_handshake,
#endif
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_httpd, &ws_uri));

    // Catch-all static + Captive Portal handler (must be registered last)
    httpd_uri_t static_uri = {
        .uri = "/*",
        .method = HTTP_GET,
        .handler = handle_static_get,
    };
    ESP_ERROR_CHECK(httpd_register_uri_handler(s_httpd, &static_uri));

    xTaskCreate(ws_broadcast_task, "ws_bcast", 6144, NULL, 4, NULL);
    ESP_LOGI(TAG, "Web server started on :80");
    return ESP_OK;
}
