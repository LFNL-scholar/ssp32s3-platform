#include "sys_monitor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_chip_info.h"
#include "esp_system.h"
#include "esp_mac.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_image_format.h"
#include "esp_littlefs.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_idf_version.h"
#include "esp_private/esp_clk.h"
#include "driver/temperature_sensor.h"
#include "esp_log.h"

#include "wifi_mgr.h"
#include "ble_presence.h"

static const char *TAG = "sys_monitor";

#define MAX_TRACKED_TASKS 36

typedef struct {
    UBaseType_t task_number;
    uint32_t run_time;
} task_runtime_snap_t;

static temperature_sensor_handle_t s_tsens = NULL;
static SemaphoreHandle_t s_mutex = NULL;
static EXT_RAM_BSS_ATTR task_runtime_snap_t s_prev_snap[MAX_TRACKED_TASKS];
static UBaseType_t s_prev_count = 0;
static uint32_t s_prev_total_rt = 0;

static const char *reset_reason_str(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    default:                return "OTHER";
    }
}

esp_err_t sys_monitor_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    temperature_sensor_config_t cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    esp_err_t err = temperature_sensor_install(&cfg, &s_tsens);
    if (err == ESP_OK) {
        err = temperature_sensor_enable(s_tsens);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Temperature sensor init failed: %s", esp_err_to_name(err));
    }
    return ESP_OK;
}

cJSON *sys_monitor_build_info_json(void)
{
    cJSON *root = cJSON_CreateObject();

    esp_chip_info_t chip;
    esp_chip_info(&chip);
    const esp_app_desc_t *app = esp_app_get_description();

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char mac_str[18];
    snprintf(mac_str, sizeof(mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    cJSON_AddStringToObject(root, "chip", "ESP32-S3");
    cJSON_AddNumberToObject(root, "revision", chip.revision);
    cJSON_AddNumberToObject(root, "cores", chip.cores);
    cJSON_AddNumberToObject(root, "cpu_mhz", esp_clk_cpu_freq() / 1000000);
    cJSON_AddStringToObject(root, "mac", mac_str);
    cJSON_AddStringToObject(root, "idf_version", esp_get_idf_version());
    cJSON_AddStringToObject(root, "fw_version", app->version);
    cJSON_AddStringToObject(root, "project_name", app->project_name);
    cJSON_AddStringToObject(root, "compile_date", app->date);
    cJSON_AddStringToObject(root, "compile_time", app->time);
    cJSON_AddStringToObject(root, "reset_reason", reset_reason_str(esp_reset_reason()));

    const esp_partition_t *running = esp_ota_get_running_partition();
    cJSON_AddStringToObject(root, "running_partition", running ? running->label : "unknown");

    // Partition table
    cJSON *parts = cJSON_CreateArray();
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    while (it != NULL) {
        const esp_partition_t *p = esp_partition_get(it);
        cJSON *po = cJSON_CreateObject();
        cJSON_AddStringToObject(po, "label", p->label);
        cJSON_AddNumberToObject(po, "type", p->type);
        cJSON_AddNumberToObject(po, "subtype", p->subtype);
        cJSON_AddNumberToObject(po, "offset", p->address);
        cJSON_AddNumberToObject(po, "size", p->size);
        if (p->type == ESP_PARTITION_TYPE_APP) {
            esp_partition_pos_t pos = { .offset = p->address, .size = p->size };
            esp_image_metadata_t meta;
            if (esp_image_get_metadata(&pos, &meta) == ESP_OK && meta.image_len > 0 && meta.image_len <= p->size) {
                cJSON_AddNumberToObject(po, "used", meta.image_len);
            } else {
                cJSON_AddNumberToObject(po, "used", 0);
            }
        }
        cJSON_AddItemToArray(parts, po);
        it = esp_partition_next(it);
    }
    esp_partition_iterator_release(it);
    cJSON_AddItemToObject(root, "partitions", parts);

    // LittleFS partitions usage
    cJSON *fs = cJSON_CreateObject();
    size_t total = 0, used = 0;
    if (esp_littlefs_info("www", &total, &used) == ESP_OK) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "total", total);
        cJSON_AddNumberToObject(o, "used", used);
        cJSON_AddItemToObject(fs, "www", o);
    }
    if (esp_littlefs_info("data", &total, &used) == ESP_OK) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "total", total);
        cJSON_AddNumberToObject(o, "used", used);
        cJSON_AddItemToObject(fs, "data", o);
    }
    cJSON_AddItemToObject(root, "littlefs", fs);

    return root;
}

static uint32_t find_prev_task_rt(UBaseType_t task_num)
{
    for (UBaseType_t i = 0; i < s_prev_count; i++) {
        if (s_prev_snap[i].task_number == task_num) {
            return s_prev_snap[i].run_time;
        }
    }
    return 0;
}

cJSON *sys_monitor_build_telemetry_json(void)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "telemetry");
    cJSON_AddNumberToObject(root, "uptime_s", (double)(esp_timer_get_time() / 1000000ULL));

    bool synced = wifi_mgr_is_time_synced();
    cJSON_AddBoolToObject(root, "time_synced", synced);
    cJSON_AddNumberToObject(root, "epoch", synced ? (double)time(NULL) : 0);

    float temp_c = 0.0f;
    if (s_tsens && temperature_sensor_get_celsius(s_tsens, &temp_c) == ESP_OK) {
        cJSON_AddNumberToObject(root, "temp_c", ((int)(temp_c * 10.0f)) / 10.0);
    } else {
        cJSON_AddNullToObject(root, "temp_c");
    }

    // SRAM & PSRAM
    cJSON *sram = cJSON_CreateObject();
    cJSON_AddNumberToObject(sram, "total", heap_caps_get_total_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(sram, "free", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(sram, "min_free", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddItemToObject(root, "sram", sram);

    cJSON *psram = cJSON_CreateObject();
    cJSON_AddNumberToObject(psram, "total", heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(psram, "free", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(psram, "min_free", heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddItemToObject(root, "psram", psram);

    // Wi-Fi
    wifi_status_info_t ws;
    wifi_mgr_get_status(&ws);
    cJSON *wifi = cJSON_CreateObject();
    cJSON_AddStringToObject(wifi, "mode", ws.mode);
    cJSON_AddStringToObject(wifi, "ssid", ws.sta_connected ? ws.sta_ssid : ws.ap_ssid);
    cJSON_AddNumberToObject(wifi, "rssi", ws.rssi);
    cJSON_AddNumberToObject(wifi, "channel", ws.channel);
    cJSON_AddStringToObject(wifi, "ip", ws.ip);
    cJSON_AddStringToObject(wifi, "gateway", ws.gateway);
    cJSON_AddStringToObject(wifi, "dns", ws.dns);
    cJSON_AddBoolToObject(wifi, "sta_connected", ws.sta_connected);
    cJSON_AddBoolToObject(wifi, "ap_active", ws.ap_active);
    cJSON_AddItemToObject(root, "wifi", wifi);

    // BLE summary
    ble_summary_t bs;
    ble_presence_get_summary(&bs);
    cJSON *ble = cJSON_CreateObject();
    const char *ble_state_str = (bs.state == BLE_RUN_PAIRING) ? "pairing" :
                                (bs.state == BLE_RUN_SCANNING ? "scanning" : "idle");
    cJSON_AddStringToObject(ble, "state", ble_state_str);
    cJSON_AddNumberToObject(ble, "tracked", bs.tracked_devices);
    cJSON_AddNumberToObject(ble, "home_persons", bs.home_persons);
    cJSON_AddItemToObject(root, "ble", ble);

    // FreeRTOS tasks delta CPU
    cJSON *tasks = cJSON_CreateArray();
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    TaskStatus_t *arr = heap_caps_calloc(MAX_TRACKED_TASKS, sizeof(TaskStatus_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!arr) {
        arr = calloc(MAX_TRACKED_TASKS, sizeof(TaskStatus_t));
    }
    if (arr) {
        uint32_t total_rt = 0;
        UBaseType_t cnt = uxTaskGetSystemState(arr, MAX_TRACKED_TASKS, &total_rt);
        uint32_t delta_total = total_rt - s_prev_total_rt;
        // Scale by number of cores since total_rt is single-core timer while tasks run on 2 cores
        double denom = (delta_total > 0) ? ((double)delta_total * (double)portNUM_PROCESSORS) : 0.0;

        for (UBaseType_t i = 0; i < cnt; i++) {
            uint32_t prev_rt = find_prev_task_rt(arr[i].xTaskNumber);
            uint32_t delta_task = arr[i].ulRunTimeCounter - prev_rt;
            double cpu_pct = (denom > 0.0) ? (100.0 * (double)delta_task / denom) : 0.0;
            if (cpu_pct > 100.0) cpu_pct = 100.0;

            cJSON *to = cJSON_CreateObject();
            cJSON_AddStringToObject(to, "name", arr[i].pcTaskName);
            cJSON_AddNumberToObject(to, "cpu", ((int)(cpu_pct * 10.0)) / 10.0);
#if ( configTASKLIST_INCLUDE_COREID == 1 )
            int core = (arr[i].xCoreID == tskNO_AFFINITY) ? -1 : (int)arr[i].xCoreID;
#else
            int core = -1;
#endif
            cJSON_AddNumberToObject(to, "core", core);
            cJSON_AddNumberToObject(to, "stack_hwm", arr[i].usStackHighWaterMark);
            cJSON_AddItemToArray(tasks, to);
        }

        s_prev_count = cnt < MAX_TRACKED_TASKS ? cnt : MAX_TRACKED_TASKS;
        for (UBaseType_t i = 0; i < s_prev_count; i++) {
            s_prev_snap[i].task_number = arr[i].xTaskNumber;
            s_prev_snap[i].run_time = arr[i].ulRunTimeCounter;
        }
        s_prev_total_rt = total_rt;
        free(arr);
    }
    xSemaphoreGive(s_mutex);
    cJSON_AddItemToObject(root, "tasks", tasks);

    return root;
}
