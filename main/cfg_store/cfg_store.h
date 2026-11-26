#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CFG_MAX_PERSONS 16
#define CFG_MAX_DEVICES 32

typedef enum {
    MATCH_NONE = 0,
    MATCH_IRK = 1,
    MATCH_FIXED_MAC = 2,
} match_type_t;

typedef struct {
    bool configured;
    char ssid[33];
    char password[65];
} cfg_wifi_t;

typedef struct {
    bool initialized;
    uint8_t salt[16];
    uint8_t pass_hash[32];
} cfg_auth_t;

typedef struct {
    char hostname[32];
    int32_t led_gpio;
    uint8_t led_brightness;   // 0..100
    uint8_t led_away_mode;    // 0 = dim red, 1 = off
    bool led_idle_enabled;    // false = keep RGB off in normal idle state
    bool lamp_auto_off_on_away;
    bool lamp_auto_on_on_arrive;
    char ntp_server1[64];
    char ntp_server2[64];
    char timezone[48];
} cfg_settings_t;

typedef struct {
    uint8_t id;
    bool used;
    char name[32];
} cfg_person_t;

typedef struct {
    uint8_t id;
    bool used;
    uint8_t person_id;
    char label[32];
    uint8_t match_type;       // match_type_t
    uint8_t irk[16];
    uint8_t mac[6];           // fixed MAC or peer identity addr
    uint8_t peer_addr_type;
    int8_t enter_rssi;        // default -75
    int8_t exit_rssi;         // default -85
    uint16_t away_timeout_s;  // default 120
} cfg_device_t;

typedef struct {
    bool enabled;
    char token[33];           // 32-char hex persistent API key for Siri Shortcuts
} cfg_siri_t;

typedef struct {
    char name[32];
    char ip[16];
    char mac[18];             // "XX:XX:XX:XX:XX:XX"
    bool auto_wake_on_arrive;
    uint16_t auto_cooldown_s;
} cfg_wol_t;

typedef struct {
    bool enabled;
    char host[64];
    uint16_t port;
    char client_id[64];       // Bemfa UID / private key or generic MQTT client_id
    char username[32];
    char password[64];
    char wol_topic[48];
    char lamp_topic[48];
} cfg_mqtt_t;

typedef struct {
    bool enabled;
    char url[128];            // e.g. "wss://s3-console.xxx.workers.dev/tunnel/connect"
    char secret[64];          // shared tunnel secret
} cfg_tunnel_t;

typedef struct {
    bool enabled;
    char name[32];
    uint8_t mac[6];           // LE byte order (matching NimBLE ble_addr_t.val)
    bool has_bindkey;
    uint8_t bindkey[16];
    float temp_low;
    float temp_high;
    float hum_low;
    float hum_high;
} cfg_env_t;

typedef struct {
    bool privacy;
    bool away_only;
    char lan_url[96];
    uint8_t fps;
    uint8_t quality;
    char res[16];
} cfg_cam_t;

esp_err_t cfg_store_init(void);

// SoftAP deterministic SSID & password
void cfg_store_get_ap_credentials(char *ssid, size_t ssid_len, char *pass, size_t pass_len);

// Wi-Fi
void cfg_wifi_get(cfg_wifi_t *out);
esp_err_t cfg_wifi_set(const char *ssid, const char *password);
esp_err_t cfg_wifi_clear(void);

// Auth
bool cfg_auth_is_initialized(void);
esp_err_t cfg_auth_set_password(const char *password);
bool cfg_auth_verify_password(const char *password);

// System Settings
void cfg_settings_get(cfg_settings_t *out);
esp_err_t cfg_settings_set(const cfg_settings_t *in);

// Persons CRUD
size_t cfg_persons_list(cfg_person_t *out, size_t max_count);
bool cfg_person_get(uint8_t id, cfg_person_t *out);
esp_err_t cfg_person_add(const char *name, cfg_person_t *out);
esp_err_t cfg_person_rename(uint8_t id, const char *name);
esp_err_t cfg_person_delete(uint8_t id);

// Devices CRUD
size_t cfg_devices_list(cfg_device_t *out, size_t max_count);
bool cfg_device_get(uint8_t id, cfg_device_t *out);
esp_err_t cfg_device_add(const cfg_device_t *in, cfg_device_t *out);
esp_err_t cfg_device_update(uint8_t id, const char *label, int8_t enter_rssi, int8_t exit_rssi, uint16_t away_timeout_s);
esp_err_t cfg_device_delete(uint8_t id);

// Siri Shortcuts persistent API token
void cfg_siri_get(cfg_siri_t *out);
esp_err_t cfg_siri_set_enabled(bool enabled);
esp_err_t cfg_siri_regenerate_token(cfg_siri_t *out);
bool cfg_siri_verify_token(const char *candidate);

// Wake-on-LAN single host config
void cfg_wol_get(cfg_wol_t *out);
esp_err_t cfg_wol_set(const cfg_wol_t *in);

// MQTT external bridge config
void cfg_mqtt_get(cfg_mqtt_t *out);
esp_err_t cfg_mqtt_set(const cfg_mqtt_t *in);

// Cloudflare Workers outbound WSS tunnel config
void cfg_tunnel_get(cfg_tunnel_t *out);
esp_err_t cfg_tunnel_set(const cfg_tunnel_t *in);

// Environment sensor (Xiaomi BLE MiBeacon) config
void cfg_env_get(cfg_env_t *out);
esp_err_t cfg_env_set(const cfg_env_t *in);

// K230 edge camera LAN preferences
void cfg_cam_get(cfg_cam_t *out);
esp_err_t cfg_cam_set(const cfg_cam_t *in);

// Factory reset (clears ssp_cfg + nimble_bond)
esp_err_t cfg_store_factory_reset(void);

#ifdef __cplusplus
}
#endif
