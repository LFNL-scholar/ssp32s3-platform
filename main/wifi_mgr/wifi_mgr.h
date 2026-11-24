#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_wifi_types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define WIFI_SCAN_MAX_APS 24

typedef struct {
    char ssid[33];
    int8_t rssi;
    uint8_t channel;
    wifi_auth_mode_t authmode;
} wifi_scan_ap_t;

typedef struct {
    char mode[8];       // "AP", "STA", "APSTA"
    bool ap_active;
    bool sta_connected;
    char ap_ssid[33];
    char sta_ssid[33];
    int8_t rssi;
    uint8_t channel;
    char ip[16];
    char netmask[16];
    char gateway[16];
    char dns[16];
    bool time_synced;
} wifi_status_info_t;

typedef void (*wifi_ble_pause_cb_t)(bool pause);

void wifi_mgr_set_ble_pause_cb(wifi_ble_pause_cb_t cb);
esp_err_t wifi_mgr_init(void);

esp_err_t wifi_mgr_scan(wifi_scan_ap_t *out_aps, size_t max_aps, size_t *out_count);
esp_err_t wifi_mgr_connect_test(const char *ssid, const char *password,
                                char *out_ip, size_t ip_len,
                                char *err_buf, size_t err_len);

esp_err_t wifi_mgr_start_ap_mode(void);
void wifi_mgr_apply_settings(void);

void wifi_mgr_get_status(wifi_status_info_t *out);
bool wifi_mgr_is_ap_active(void);
bool wifi_mgr_is_time_synced(void);

#ifdef __cplusplus
}
#endif
