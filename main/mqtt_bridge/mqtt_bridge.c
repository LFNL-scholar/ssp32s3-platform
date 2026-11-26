#include "mqtt_bridge.h"
#include "cfg_store.h"
#include "wol_mgr.h"
#include "lamp_controller.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "mqtt_client.h"

static const char *TAG = "mqtt_bridge";

static SemaphoreHandle_t s_mutex = NULL;
static esp_mqtt_client_handle_t s_client = NULL;
static bool s_connected = false;
static char s_last_error[80] = "";

static void set_error(const char *err)
{
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    strlcpy(s_last_error, err ? err : "", sizeof(s_last_error));
    xSemaphoreGive(s_mutex);
}

static void trim_lower(const char *src, int src_len, char *dst, size_t dst_len)
{
    int start = 0;
    int end = src_len;
    while (start < end && isspace((unsigned char)src[start])) start++;
    while (end > start && isspace((unsigned char)src[end - 1])) end--;

    size_t n = 0;
    for (int i = start; i < end && n + 1 < dst_len; i++) {
        dst[n++] = (char)tolower((unsigned char)src[i]);
    }
    dst[n] = '\0';
}

static void handle_mqtt_message(const char *topic, int topic_len, const char *data, int data_len)
{
    cfg_mqtt_t cfg;
    cfg_mqtt_get(&cfg);

    char tbuf[64];
    int tcopy = topic_len < (int)sizeof(tbuf) - 1 ? topic_len : (int)sizeof(tbuf) - 1;
    memcpy(tbuf, topic, tcopy);
    tbuf[tcopy] = '\0';

    char msg[32];
    trim_lower(data, data_len, msg, sizeof(msg));

    ESP_LOGI(TAG, "RX topic='%s' msg='%s'", tbuf, msg);

    if (cfg.wol_topic[0] != '\0' && strcmp(tbuf, cfg.wol_topic) == 0) {
        if (strcmp(msg, "on") == 0 || strcmp(msg, "wake") == 0 ||
            strcmp(msg, "1") == 0 || strcmp(msg, "true") == 0) {
            wol_mgr_wake("MQTT 外网", NULL);
        }
        return;
    }

    if (cfg.lamp_topic[0] != '\0' && strcmp(tbuf, cfg.lamp_topic) == 0) {
        bool transmitted = false;
        esp_err_t err = ESP_ERR_INVALID_ARG;
        const char *act_cn = NULL;

        if (strcmp(msg, "on") == 0 || strcmp(msg, "1") == 0) {
            err = lamp_controller_set_power(true, false, &transmitted);
            act_cn = "开灯";
        } else if (strcmp(msg, "off") == 0 || strcmp(msg, "0") == 0) {
            err = lamp_controller_set_power(false, false, &transmitted);
            act_cn = "关灯";
        } else if (strcmp(msg, "toggle") == 0) {
            err = lamp_controller_toggle(&transmitted);
            act_cn = "切换";
        }

        if (act_cn) {
            char title[48];
            char detail[192];
            snprintf(title, sizeof(title), "MQTT 外网 · 远程%s", act_cn);
            if (err == ESP_OK) {
                snprintf(detail, sizeof(detail), "主题 %.32s 收到 %.16s → %s",
                         tbuf, msg, transmitted ? "CC1101 已发射信号" : "状态已一致，未重复发射");
                wol_mgr_log_event(title, detail, "dark");
            } else {
                snprintf(detail, sizeof(detail), "主题 %.32s 收到 %.16s → 控制失败（请检查台灯校准/样本）", tbuf, msg);
                wol_mgr_log_event(title, detail, "gray");
            }
        }
    }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t ev = (esp_mqtt_event_handle_t)event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED: {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_connected = true;
        s_last_error[0] = '\0';
        xSemaphoreGive(s_mutex);

        cfg_mqtt_t cfg;
        cfg_mqtt_get(&cfg);
        if (cfg.wol_topic[0] != '\0') {
            esp_mqtt_client_subscribe(ev->client, cfg.wol_topic, 1);
            ESP_LOGI(TAG, "Subscribed WOL topic: %s", cfg.wol_topic);
        }
        if (cfg.lamp_topic[0] != '\0') {
            esp_mqtt_client_subscribe(ev->client, cfg.lamp_topic, 1);
            ESP_LOGI(TAG, "Subscribed Lamp topic: %s", cfg.lamp_topic);
        }
        wol_mgr_broadcast_state();
        break;
    }
    case MQTT_EVENT_DISCONNECTED:
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_connected = false;
        xSemaphoreGive(s_mutex);
        wol_mgr_broadcast_state();
        break;

    case MQTT_EVENT_DATA:
        if (ev->topic && ev->topic_len > 0 && ev->data && ev->data_len > 0) {
            handle_mqtt_message(ev->topic, ev->topic_len, ev->data, ev->data_len);
        }
        break;

    case MQTT_EVENT_ERROR:
        set_error("MQTT 连接错误，自动重试中");
        wol_mgr_broadcast_state();
        break;

    default:
        break;
    }
}

esp_err_t mqtt_bridge_reload(void)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_client) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
    }
    s_connected = false;
    s_last_error[0] = '\0';
    xSemaphoreGive(s_mutex);

    cfg_mqtt_t cfg;
    cfg_mqtt_get(&cfg);

    if (!cfg.enabled) {
        ESP_LOGI(TAG, "MQTT bridge disabled");
        wol_mgr_broadcast_state();
        return ESP_OK;
    }

    if (cfg.host[0] == '\0' || cfg.client_id[0] == '\0') {
        set_error("缺少 Broker 地址或 Client ID / 巴法云私钥");
        wol_mgr_broadcast_state();
        return ESP_ERR_INVALID_ARG;
    }

    char uri[96];
    snprintf(uri, sizeof(uri), "mqtt://%s:%u", cfg.host, (unsigned)(cfg.port ? cfg.port : 9501));

    esp_mqtt_client_config_t mcfg = {0};
    mcfg.broker.address.uri = uri;
    mcfg.credentials.client_id = cfg.client_id;
    if (cfg.username[0] != '\0') mcfg.credentials.username = cfg.username;
    if (cfg.password[0] != '\0') mcfg.credentials.authentication.password = cfg.password;
    mcfg.session.keepalive = 60;
    mcfg.network.reconnect_timeout_ms = 8000;

    esp_mqtt_client_handle_t cli = esp_mqtt_client_init(&mcfg);
    if (!cli) {
        set_error("MQTT 客户端初始化失败");
        wol_mgr_broadcast_state();
        return ESP_FAIL;
    }

    esp_mqtt_client_register_event(cli, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_err_t err = esp_mqtt_client_start(cli);
    if (err != ESP_OK) {
        esp_mqtt_client_destroy(cli);
        set_error("MQTT 启动失败");
        wol_mgr_broadcast_state();
        return err;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_client = cli;
    xSemaphoreGive(s_mutex);

    ESP_LOGI(TAG, "MQTT bridge started -> %s (wol=%s, lamp=%s)", uri, cfg.wol_topic, cfg.lamp_topic);
    wol_mgr_broadcast_state();
    return ESP_OK;
}

void mqtt_bridge_get_status(mqtt_bridge_status_t *out)
{
    if (!out) return;
    cfg_mqtt_t cfg;
    cfg_mqtt_get(&cfg);
    out->enabled = cfg.enabled;
    if (!s_mutex) {
        out->connected = false;
        out->last_error[0] = '\0';
        return;
    }
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    out->connected = s_connected;
    strlcpy(out->last_error, s_last_error, sizeof(out->last_error));
    xSemaphoreGive(s_mutex);
}

esp_err_t mqtt_bridge_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }
    return mqtt_bridge_reload();
}
