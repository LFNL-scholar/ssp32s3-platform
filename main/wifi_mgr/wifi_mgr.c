#include "wifi_mgr.h"
#include "captive_dns.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "lwip/ip4_addr.h"
#include "mdns.h"

#include "cfg_store.h"
#include "led_ctrl.h"

static const char *TAG = "wifi_mgr";

#define BIT_TEST_GOT_IP   BIT0
#define BIT_TEST_FAIL     BIT1

static esp_netif_t *s_netif_ap = NULL;
static esp_netif_t *s_netif_sta = NULL;
static EventGroupHandle_t s_eg = NULL;
static SemaphoreHandle_t s_mutex = NULL;

static esp_timer_handle_t s_ap_off_timer = NULL;
static esp_timer_handle_t s_sta_fallback_timer = NULL;
static esp_timer_handle_t s_reconnect_timer = NULL;

static wifi_ble_pause_cb_t s_ble_pause_cb = NULL;

static bool s_ap_active = false;
static bool s_sta_connected = false;
static bool s_testing = false;
static int s_test_retries = 0;
static uint8_t s_last_disc_reason = 0;
static int s_reconnect_attempts = 0;
static bool s_mdns_started = false;
static bool s_sntp_started = false;

static char s_ap_ssid[33] = {0};
static char s_ap_pass[16] = {0};
static char s_sta_ip[16] = {0};
static char s_sta_mask[16] = {0};
static char s_sta_gw[16] = {0};
static char s_sta_dns[16] = {0};

static void start_mdns_and_sntp(void);
static void enable_ap_internal(bool with_sta);

static void ap_off_timer_cb(void *arg)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_sta_connected && s_ap_active) {
        ESP_LOGI(TAG, "STA connected; shutting down SoftAP & Captive Portal");
        captive_dns_stop();
        esp_wifi_set_mode(WIFI_MODE_STA);
        s_ap_active = false;
        led_ctrl_set_flag(LED_FLAG_AP_MODE, false);
    }
    xSemaphoreGive(s_mutex);
}

static void sta_fallback_timer_cb(void *arg)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (!s_sta_connected && !s_ap_active && !s_testing) {
        ESP_LOGW(TAG, "STA connection timeout; falling back to SoftAP + Captive Portal");
        enable_ap_internal(true);
    }
    xSemaphoreGive(s_mutex);
}

static void reconnect_timer_cb(void *arg)
{
    if (!s_testing && !s_sta_connected) {
        esp_wifi_connect();
    }
}

static void start_mdns_and_sntp(void)
{
    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    if (!s_mdns_started) {
        if (mdns_init() == ESP_OK) {
            mdns_hostname_set(cfg.hostname);
            mdns_instance_name_set("SSP32S3 Platform");
            mdns_service_add("SSP32S3 Web", "_http", "_tcp", 80, NULL, 0);
            s_mdns_started = true;
            ESP_LOGI(TAG, "mDNS started: http://%s.local", cfg.hostname);
        }
    } else {
        mdns_hostname_set(cfg.hostname);
    }

    setenv("TZ", cfg.timezone, 1);
    tzset();

    if (!s_sntp_started) {
        esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(cfg.ntp_server1);
        if (cfg.ntp_server2[0] != '\0') {
            sntp_cfg.num_of_servers = 2;
            sntp_cfg.servers[1] = cfg.ntp_server2;
        }
        if (esp_netif_sntp_init(&sntp_cfg) == ESP_OK) {
            s_sntp_started = true;
            ESP_LOGI(TAG, "SNTP started (%s, %s, TZ=%s)", cfg.ntp_server1, cfg.ntp_server2, cfg.timezone);
        }
    }
}

static void enable_ap_internal(bool with_sta)
{
    wifi_config_t ap_cfg = {0};
    strlcpy((char *)ap_cfg.ap.ssid, s_ap_ssid, sizeof(ap_cfg.ap.ssid));
    ap_cfg.ap.ssid_len = (uint8_t)strlen(s_ap_ssid);
    strlcpy((char *)ap_cfg.ap.password, s_ap_pass, sizeof(ap_cfg.ap.password));
    ap_cfg.ap.channel = 1;
    ap_cfg.ap.max_connection = 4;
    ap_cfg.ap.authmode = WIFI_AUTH_WPA2_PSK;
    ap_cfg.ap.pmf_cfg.required = false;

    esp_wifi_set_mode(with_sta ? WIFI_MODE_APSTA : WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &ap_cfg);

    s_ap_active = true;
    captive_dns_start();
    led_ctrl_set_flag(LED_FLAG_AP_MODE, true);
    ESP_LOGI(TAG, "SoftAP active -> SSID: %s | Password: %s | IP: 192.168.4.1", s_ap_ssid, s_ap_pass);
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        cfg_wifi_t w;
        cfg_wifi_get(&w);
        if (w.configured && !s_testing) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *ev = (wifi_event_sta_disconnected_t *)data;
        s_sta_connected = false;
        s_last_disc_reason = ev ? ev->reason : 0;
        memset(s_sta_ip, 0, sizeof(s_sta_ip));

        if (s_testing) {
            s_test_retries++;
            bool auth_fail = (s_last_disc_reason == WIFI_REASON_AUTH_FAIL ||
                              s_last_disc_reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT ||
                              s_last_disc_reason == WIFI_REASON_HANDSHAKE_TIMEOUT ||
                              s_last_disc_reason == WIFI_REASON_NO_AP_FOUND);
            if (auth_fail && s_test_retries >= 2) {
                xEventGroupSetBits(s_eg, BIT_TEST_FAIL);
            } else if (s_test_retries >= 4) {
                xEventGroupSetBits(s_eg, BIT_TEST_FAIL);
            } else {
                esp_wifi_connect();
            }
            return;
        }

        cfg_wifi_t w;
        cfg_wifi_get(&w);
        if (w.configured) {
            // Exponential backoff reconnect (1s, 2s, 4s, 8s, max 15s)
            int delay_ms = 1000 << (s_reconnect_attempts < 4 ? s_reconnect_attempts : 4);
            if (delay_ms > 15000) delay_ms = 15000;
            s_reconnect_attempts++;
            esp_timer_stop(s_reconnect_timer);
            esp_timer_start_once(s_reconnect_timer, (uint64_t)delay_ms * 1000ULL);

            // Start 60s AP fallback timer if not already running & AP not active
            if (!s_ap_active && !esp_timer_is_active(s_sta_fallback_timer)) {
                esp_timer_start_once(s_sta_fallback_timer, 60ULL * 1000000ULL);
            }
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        s_sta_connected = true;
        s_reconnect_attempts = 0;
        esp_timer_stop(s_sta_fallback_timer);

        snprintf(s_sta_ip, sizeof(s_sta_ip), IPSTR, IP2STR(&ev->ip_info.ip));
        snprintf(s_sta_mask, sizeof(s_sta_mask), IPSTR, IP2STR(&ev->ip_info.netmask));
        snprintf(s_sta_gw, sizeof(s_sta_gw), IPSTR, IP2STR(&ev->ip_info.gw));

        esp_netif_dns_info_t dns_info = {0};
        if (esp_netif_get_dns_info(s_netif_sta, ESP_NETIF_DNS_MAIN, &dns_info) == ESP_OK) {
            snprintf(s_sta_dns, sizeof(s_sta_dns), IPSTR, IP2STR(&dns_info.ip.u_addr.ip4));
        }

        ESP_LOGI(TAG, "STA got IP: %s", s_sta_ip);
        start_mdns_and_sntp();

        if (s_testing) {
            xEventGroupSetBits(s_eg, BIT_TEST_GOT_IP);
        } else if (s_ap_active) {
            esp_timer_stop(s_ap_off_timer);
            esp_timer_start_once(s_ap_off_timer, 5ULL * 1000000ULL);
        }
    }
}

void wifi_mgr_set_ble_pause_cb(wifi_ble_pause_cb_t cb)
{
    s_ble_pause_cb = cb;
}

esp_err_t wifi_mgr_init(void)
{
    s_eg = xEventGroupCreate();
    s_mutex = xSemaphoreCreateMutex();
    if (!s_eg || !s_mutex) return ESP_ERR_NO_MEM;

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    s_netif_ap = esp_netif_create_default_wifi_ap();
    s_netif_sta = esp_netif_create_default_wifi_sta();

    // Configure AP IP = 192.168.4.1
    esp_netif_dhcps_stop(s_netif_ap);
    esp_netif_ip_info_t ap_ip = {0};
    IP4_ADDR(&ap_ip.ip, 192, 168, 4, 1);
    IP4_ADDR(&ap_ip.gw, 192, 168, 4, 1);
    IP4_ADDR(&ap_ip.netmask, 255, 255, 255, 0);
    esp_netif_set_ip_info(s_netif_ap, &ap_ip);
    esp_netif_dhcps_start(s_netif_ap);

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

    const esp_timer_create_args_t ap_off_args = { .callback = ap_off_timer_cb, .name = "ap_off" };
    const esp_timer_create_args_t fb_args = { .callback = sta_fallback_timer_cb, .name = "sta_fb" };
    const esp_timer_create_args_t rc_args = { .callback = reconnect_timer_cb, .name = "sta_rc" };
    ESP_ERROR_CHECK(esp_timer_create(&ap_off_args, &s_ap_off_timer));
    ESP_ERROR_CHECK(esp_timer_create(&fb_args, &s_sta_fallback_timer));
    ESP_ERROR_CHECK(esp_timer_create(&rc_args, &s_reconnect_timer));

    cfg_store_get_ap_credentials(s_ap_ssid, sizeof(s_ap_ssid), s_ap_pass, sizeof(s_ap_pass));
    ESP_LOGI(TAG, "==========================================");
    ESP_LOGI(TAG, "SoftAP Credentials -> SSID: %s | PASS: %s", s_ap_ssid, s_ap_pass);
    ESP_LOGI(TAG, "==========================================");

    cfg_wifi_t w;
    cfg_wifi_get(&w);
    if (!w.configured) {
        enable_ap_internal(true);
        ESP_ERROR_CHECK(esp_wifi_start());
    } else {
        wifi_config_t sta_cfg = {0};
        strlcpy((char *)sta_cfg.sta.ssid, w.ssid, sizeof(sta_cfg.sta.ssid));
        strlcpy((char *)sta_cfg.sta.password, w.password, sizeof(sta_cfg.sta.password));
        sta_cfg.sta.threshold.authmode = (w.password[0] != '\0') ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_cfg));
        ESP_ERROR_CHECK(esp_wifi_start());
        // 30s initial STA connection fallback timer
        esp_timer_start_once(s_sta_fallback_timer, 30ULL * 1000000ULL);
        ESP_LOGI(TAG, "Connecting to saved Wi-Fi: %s", w.ssid);
    }

    return ESP_OK;
}

static int cmp_ap_rssi_desc(const void *a, const void *b)
{
    const wifi_scan_ap_t *pa = (const wifi_scan_ap_t *)a;
    const wifi_scan_ap_t *pb = (const wifi_scan_ap_t *)b;
    return (int)pb->rssi - (int)pa->rssi;
}

esp_err_t wifi_mgr_scan(wifi_scan_ap_t *out_aps, size_t max_aps, size_t *out_count)
{
    if (!out_aps || max_aps == 0 || !out_count) return ESP_ERR_INVALID_ARG;
    *out_count = 0;

    xSemaphoreTake(s_mutex, portMAX_DELAY);

    wifi_mode_t mode;
    esp_wifi_get_mode(&mode);
    if (mode == WIFI_MODE_AP) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    }

    if (s_ble_pause_cb) s_ble_pause_cb(true);

    wifi_scan_config_t scan_cfg = {
        .ssid = NULL,
        .bssid = NULL,
        .channel = 0,
        .show_hidden = false,
        .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    };
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, true);
    if (err == ESP_OK) {
        uint16_t ap_num = 0;
        esp_wifi_scan_get_ap_num(&ap_num);
        if (ap_num > 0) {
            uint16_t fetch = ap_num > 48 ? 48 : ap_num;
            wifi_ap_record_t *recs = calloc(fetch, sizeof(wifi_ap_record_t));
            if (recs) {
                if (esp_wifi_scan_get_ap_records(&fetch, recs) == ESP_OK) {
                    size_t cnt = 0;
                    for (uint16_t i = 0; i < fetch; i++) {
                        const char *ssid = (const char *)recs[i].ssid;
                        if (ssid[0] == '\0') continue;

                        // Deduplicate by SSID keeping strongest RSSI
                        bool dup = false;
                        for (size_t j = 0; j < cnt; j++) {
                            if (strcmp(out_aps[j].ssid, ssid) == 0) {
                                if (recs[i].rssi > out_aps[j].rssi) {
                                    out_aps[j].rssi = recs[i].rssi;
                                    out_aps[j].channel = recs[i].primary;
                                    out_aps[j].authmode = recs[i].authmode;
                                }
                                dup = true;
                                break;
                            }
                        }
                        if (!dup && cnt < max_aps) {
                            strlcpy(out_aps[cnt].ssid, ssid, sizeof(out_aps[cnt].ssid));
                            out_aps[cnt].rssi = recs[i].rssi;
                            out_aps[cnt].channel = recs[i].primary;
                            out_aps[cnt].authmode = recs[i].authmode;
                            cnt++;
                        }
                    }
                    qsort(out_aps, cnt, sizeof(wifi_scan_ap_t), cmp_ap_rssi_desc);
                    *out_count = cnt;
                }
                free(recs);
            }
        }
    }

    if (s_ble_pause_cb) s_ble_pause_cb(false);
    xSemaphoreGive(s_mutex);
    return err;
}

static const char *reason_to_str(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND: return "找不到该 Wi-Fi 网络 (SSID 不存在或信号过弱)";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT: return "Wi-Fi 密码错误或认证失败";
    default: return "连接超时或路由器拒绝连接";
    }
}

esp_err_t wifi_mgr_connect_test(const char *ssid, const char *password,
                                char *out_ip, size_t ip_len,
                                char *err_buf, size_t err_len)
{
    if (!ssid || ssid[0] == '\0') {
        if (err_buf) strlcpy(err_buf, "SSID 不能为空", err_len);
        return ESP_ERR_INVALID_ARG;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    esp_timer_stop(s_ap_off_timer);
    esp_timer_stop(s_sta_fallback_timer);
    esp_timer_stop(s_reconnect_timer);

    s_testing = true;
    s_test_retries = 0;
    s_last_disc_reason = 0;
    xEventGroupClearBits(s_eg, BIT_TEST_GOT_IP | BIT_TEST_FAIL);

    if (s_ap_active) {
        esp_wifi_set_mode(WIFI_MODE_APSTA);
    } else {
        esp_wifi_set_mode(WIFI_MODE_STA);
    }

    esp_wifi_disconnect();
    vTaskDelay(pdMS_TO_TICKS(100));

    wifi_config_t sta_cfg = {0};
    strlcpy((char *)sta_cfg.sta.ssid, ssid, sizeof(sta_cfg.sta.ssid));
    if (password) {
        strlcpy((char *)sta_cfg.sta.password, password, sizeof(sta_cfg.sta.password));
    }
    sta_cfg.sta.threshold.authmode = (password && password[0] != '\0') ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    esp_wifi_set_config(WIFI_IF_STA, &sta_cfg);

    if (s_ble_pause_cb) s_ble_pause_cb(true);
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(s_eg, BIT_TEST_GOT_IP | BIT_TEST_FAIL,
                                           pdTRUE, pdFALSE, pdMS_TO_TICKS(15000));
    if (s_ble_pause_cb) s_ble_pause_cb(false);

    s_testing = false;

    if (bits & BIT_TEST_GOT_IP) {
        cfg_wifi_set(ssid, password ? password : "");
        if (out_ip && ip_len > 0) {
            strlcpy(out_ip, s_sta_ip, ip_len);
        }
        if (s_ap_active) {
            // Keep SoftAP alive for 5s so the browser receives the HTTP response with STA IP
            esp_timer_start_once(s_ap_off_timer, 5ULL * 1000000ULL);
        }
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }

    esp_wifi_disconnect();
    if (err_buf && err_len > 0) {
        strlcpy(err_buf, reason_to_str(s_last_disc_reason), err_len);
    }

    // Restore saved Wi-Fi if one existed, or keep AP active
    cfg_wifi_t saved;
    cfg_wifi_get(&saved);
    if (saved.configured && !s_ap_active) {
        wifi_config_t prev = {0};
        strlcpy((char *)prev.sta.ssid, saved.ssid, sizeof(prev.sta.ssid));
        strlcpy((char *)prev.sta.password, saved.password, sizeof(prev.sta.password));
        esp_wifi_set_config(WIFI_IF_STA, &prev);
        esp_wifi_connect();
    }

    xSemaphoreGive(s_mutex);
    return ESP_FAIL;
}

esp_err_t wifi_mgr_start_ap_mode(void)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    enable_ap_internal(true);
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

void wifi_mgr_apply_settings(void)
{
    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    if (s_mdns_started) {
        mdns_hostname_set(cfg.hostname);
    }

    setenv("TZ", cfg.timezone, 1);
    tzset();

    if (s_sntp_started) {
        esp_netif_sntp_deinit();
        s_sntp_started = false;
        esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG(cfg.ntp_server1);
        if (cfg.ntp_server2[0] != '\0') {
            sntp_cfg.num_of_servers = 2;
            sntp_cfg.servers[1] = cfg.ntp_server2;
        }
        if (esp_netif_sntp_init(&sntp_cfg) == ESP_OK) {
            s_sntp_started = true;
        }
    }
}

void wifi_mgr_get_status(wifi_status_info_t *out)
{
    if (!out) return;
    memset(out, 0, sizeof(*out));
    out->ap_active = s_ap_active;
    out->sta_connected = s_sta_connected;
    strlcpy(out->ap_ssid, s_ap_ssid, sizeof(out->ap_ssid));
    out->time_synced = wifi_mgr_is_time_synced();

    if (s_ap_active && s_sta_connected) {
        strlcpy(out->mode, "APSTA", sizeof(out->mode));
    } else if (s_ap_active) {
        strlcpy(out->mode, "AP", sizeof(out->mode));
    } else {
        strlcpy(out->mode, "STA", sizeof(out->mode));
    }

    if (s_sta_connected) {
        wifi_ap_record_t ap_info;
        if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
            strlcpy(out->sta_ssid, (const char *)ap_info.ssid, sizeof(out->sta_ssid));
            out->rssi = ap_info.rssi;
            out->channel = ap_info.primary;
        }
        strlcpy(out->ip, s_sta_ip, sizeof(out->ip));
        strlcpy(out->netmask, s_sta_mask, sizeof(out->netmask));
        strlcpy(out->gateway, s_sta_gw, sizeof(out->gateway));
        strlcpy(out->dns, s_sta_dns, sizeof(out->dns));
    } else if (s_ap_active) {
        strlcpy(out->ip, "192.168.4.1", sizeof(out->ip));
        strlcpy(out->netmask, "255.255.255.0", sizeof(out->netmask));
        strlcpy(out->gateway, "192.168.4.1", sizeof(out->gateway));
    }
}

bool wifi_mgr_is_ap_active(void)
{
    return s_ap_active;
}

bool wifi_mgr_is_time_synced(void)
{
    return time(NULL) >= 1704067200LL; // >= 2024-01-01
}
