#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "sdkconfig.h"

#include "cfg_store.h"
#include "led_ctrl.h"
#include "btn_reset.h"
#include "presence_log.h"
#include "sys_monitor.h"
#include "wifi_mgr.h"
#include "ble_presence.h"
#include "web_server.h"
#include "ota_mgr.h"
#include "lamp_controller.h"
#include "wol_mgr.h"
#include "mqtt_bridge.h"

static const char *TAG = "app_main";

static void on_presence_home_count_change(int prev_home, int cur_home)
{
    lamp_controller_on_presence_change(prev_home, cur_home);
    wol_mgr_on_presence_change(prev_home, cur_home);
}

static bool mount_littlefs(void)
{
    esp_vfs_littlefs_conf_t www_conf = {
        .base_path = "/www",
        .partition_label = "www",
        .format_if_mount_failed = false,
        .dont_mount = false,
    };
    esp_err_t err = esp_vfs_littlefs_register(&www_conf);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to mount /www LittleFS: %s", esp_err_to_name(err));
    } else {
        size_t total = 0, used = 0;
        esp_littlefs_info("www", &total, &used);
        ESP_LOGI(TAG, "Mounted /www (%u / %u bytes)", (unsigned)used, (unsigned)total);
    }

    esp_vfs_littlefs_conf_t data_conf = {
        .base_path = "/data",
        .partition_label = "data",
        .format_if_mount_failed = true,
        .dont_mount = false,
    };
    err = esp_vfs_littlefs_register(&data_conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to mount /data LittleFS: %s", esp_err_to_name(err));
        return false;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info("data", &total, &used);
    ESP_LOGI(TAG, "Mounted /data (%u / %u bytes)", (unsigned)used, (unsigned)total);
    return true;
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    bool data_mounted = mount_littlefs();
    ESP_ERROR_CHECK(cfg_store_init());

    cfg_settings_t settings;
    cfg_settings_get(&settings);

    ESP_ERROR_CHECK(led_ctrl_init(settings.led_gpio, settings.led_brightness,
                                  settings.led_away_mode, settings.led_idle_enabled));
    ESP_ERROR_CHECK(btn_reset_init(CONFIG_SSP_BOOT_BTN_GPIO));
    ESP_ERROR_CHECK(presence_log_init());
    ESP_ERROR_CHECK(sys_monitor_init());

    lamp_controller_set_ws_cb(web_server_ws_broadcast);
    ESP_ERROR_CHECK(lamp_controller_init(data_mounted));

    wifi_mgr_set_ble_pause_cb(ble_presence_pause_scan);
    ESP_ERROR_CHECK(wifi_mgr_init());

    wol_mgr_set_ws_cb(web_server_ws_broadcast);
    ESP_ERROR_CHECK(wol_mgr_init());
    mqtt_bridge_init();

    ble_presence_set_ws_cb(web_server_ws_broadcast);
    ble_presence_set_home_count_cb(on_presence_home_count_change);
    ESP_ERROR_CHECK(web_server_start());
    ESP_ERROR_CHECK(ble_presence_init());

    // Confirm newly booted OTA image only after 10s of stable uptime
    vTaskDelay(pdMS_TO_TICKS(10000));
    ota_mgr_confirm_if_pending();
}
