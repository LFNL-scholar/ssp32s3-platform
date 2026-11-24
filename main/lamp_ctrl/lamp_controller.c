#include "lamp_controller.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs.h"

#include "lamp_config.h"
#include "cc1101.h"
#include "waveform.h"
#include "rf_storage.h"
#include "lamp_history.h"
#include "cfg_store.h"
#include "wifi_mgr.h"
#include "presence_log.h"

static const char *TAG = "lamp_ctrl";
static const char *POWER_SAMPLE = "power_sample_1";

static const rf_settings_t s_default_rf = {
    .mhz = RF_DEFAULT_MHZ,
    .bandwidth_khz = RF_DEFAULT_BW_KHZ,
    .rate_kbaud = RF_DEFAULT_RATE_KBAUD,
};

static SemaphoreHandle_t s_lock = NULL;
static lamp_ws_cb_t s_ws_cb = NULL;
static waveform_t *s_power_wave = NULL;
static waveform_t *s_pending_wave = NULL;
static lamp_status_t s_state = {
    .last_action = "startup",
};

static void set_error_locked(esp_err_t err)
{
    snprintf(s_state.last_error, sizeof(s_state.last_error), "%s", esp_err_to_name(err));
}

static void emit_ws_json(cJSON *obj)
{
    if (!obj) return;
    if (s_ws_cb) {
        char *str = cJSON_PrintUnformatted(obj);
        if (str) {
            s_ws_cb(str);
            cJSON_free(str);
        }
    }
    cJSON_Delete(obj);
}

static void broadcast_lamp_state(void)
{
    cJSON *obj = lamp_controller_build_state_json();
    if (obj) {
        cJSON_AddStringToObject(obj, "type", "lamp_state");
        emit_ws_json(obj);
    }
}

static void broadcast_learn_event(const char *status, uint32_t pulses, uint32_t dur_ms, const char *err_msg)
{
    cJSON *obj = cJSON_CreateObject();
    cJSON_AddStringToObject(obj, "type", "lamp_learn");
    cJSON_AddStringToObject(obj, "status", status);
    if (pulses > 0) cJSON_AddNumberToObject(obj, "pulses", pulses);
    if (dur_ms > 0) cJSON_AddNumberToObject(obj, "duration_ms", dur_ms);
    if (err_msg && err_msg[0]) cJSON_AddStringToObject(obj, "error", err_msg);
    emit_ws_json(obj);
}

static esp_err_t save_power_state_nvs(bool on)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("lamp_state", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, "power_on", on ? 1 : 0);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

static void lamp_tick_task(void *arg)
{
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (wifi_mgr_is_time_synced()) {
            lamp_history_clock_synced();
        }
        xSemaphoreTake(s_lock, portMAX_DELAY);
        bool known = s_state.power_known;
        bool on = s_state.power_on;
        xSemaphoreGive(s_lock);
        lamp_history_tick(known, on);
    }
}

void lamp_controller_set_ws_cb(lamp_ws_cb_t cb)
{
    s_ws_cb = cb;
}

esp_err_t lamp_controller_init(bool data_mounted)
{
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;

    s_power_wave = heap_caps_calloc(1, sizeof(waveform_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_pending_wave = heap_caps_calloc(1, sizeof(waveform_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_power_wave) s_power_wave = calloc(1, sizeof(waveform_t));
    if (!s_pending_wave) s_pending_wave = calloc(1, sizeof(waveform_t));
    if (!s_power_wave || !s_pending_wave) return ESP_ERR_NO_MEM;

    s_state.storage_ready = data_mounted;
    esp_err_t hist_err = lamp_history_init(data_mounted);
    if (hist_err != ESP_OK) {
        ESP_LOGW(TAG, "lamp_history_init failed: %s", esp_err_to_name(hist_err));
    }

    esp_err_t err = waveform_init();
    if (err != ESP_OK) {
        set_error_locked(err);
        ESP_LOGE(TAG, "RMT waveform_init failed: %s", esp_err_to_name(err));
    } else {
        err = cc1101_init(&s_default_rf);
        s_state.radio_ready = (err == ESP_OK);
        if (err != ESP_OK) {
            set_error_locked(err);
            ESP_LOGW(TAG, "CC1101 init failed (check wiring): %s", esp_err_to_name(err));
        }
    }

    if (data_mounted) {
        esp_err_t load_err = rf_storage_load(POWER_SAMPLE, s_power_wave);
        s_state.sample_loaded = (load_err == ESP_OK);
        if (load_err == ESP_OK) {
            s_state.sample_pulses = s_power_wave->count;
            s_state.sample_mhz = s_power_wave->rf.mhz;
            ESP_LOGI(TAG, "Loaded '%s': %lu pulses, %.2f MHz",
                     POWER_SAMPLE, (unsigned long)s_power_wave->count, s_power_wave->rf.mhz);
        } else {
            ESP_LOGW(TAG, "Power sample '%s' not loaded: %s", POWER_SAMPLE, esp_err_to_name(load_err));
        }
    }

    // Never assume physical state across reboots; wait for web calibration
    s_state.power_known = false;
    s_state.power_on = false;

    xTaskCreate(lamp_tick_task, "lamp_tick", 3072, NULL, 3, NULL);
    return ESP_OK;
}

void lamp_controller_status(lamp_status_t *out)
{
    if (!out) return;
    if (s_lock) xSemaphoreTake(s_lock, portMAX_DELAY);
    *out = s_state;
    if (s_lock) xSemaphoreGive(s_lock);
}

cJSON *lamp_controller_build_state_json(void)
{
    lamp_status_t st;
    lamp_controller_status(&st);

    lamp_history_status_t hst;
    lamp_history_status(&hst);

    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "radio_ready", st.radio_ready);
    cJSON_AddBoolToObject(root, "storage_ready", st.storage_ready);
    cJSON_AddBoolToObject(root, "sample_loaded", st.sample_loaded);
    cJSON_AddNumberToObject(root, "sample_pulses", st.sample_pulses);
    cJSON_AddNumberToObject(root, "sample_mhz", st.sample_mhz);
    cJSON_AddBoolToObject(root, "power_known", st.power_known);
    cJSON_AddBoolToObject(root, "power_on", st.power_on);
    cJSON_AddNumberToObject(root, "power_transmissions", st.power_transmissions);
    cJSON_AddStringToObject(root, "last_action", st.last_action[0] ? st.last_action : "none");
    cJSON_AddStringToObject(root, "last_error", st.last_error);

    cJSON *learn = cJSON_CreateObject();
    cJSON_AddBoolToObject(learn, "active", st.learning_active);
    cJSON_AddBoolToObject(learn, "pending_ready", st.pending_ready);
    cJSON_AddNumberToObject(learn, "pending_pulses", st.pending_pulses);
    cJSON_AddNumberToObject(learn, "pending_duration_ms", st.pending_duration_ms);
    cJSON_AddItemToObject(root, "learning", learn);

    cJSON *auto_obj = cJSON_CreateObject();
    cJSON_AddBoolToObject(auto_obj, "auto_off_on_away", cfg.lamp_auto_off_on_away);
    cJSON_AddBoolToObject(auto_obj, "auto_on_on_arrive", cfg.lamp_auto_on_on_arrive);
    cJSON_AddItemToObject(root, "automation", auto_obj);

    cJSON *hist = cJSON_CreateObject();
    cJSON_AddBoolToObject(hist, "time_synced", hst.time_synced);
    cJSON_AddBoolToObject(hist, "ready", hst.ready);
    cJSON_AddBoolToObject(hist, "recording", hst.recording);
    cJSON_AddNumberToObject(hist, "now", (double)hst.now);
    cJSON_AddNumberToObject(hist, "oldest", (double)hst.oldest);
    cJSON_AddStringToObject(hist, "error", hst.error ? esp_err_to_name(hst.error) : "");
    cJSON_AddItemToObject(root, "history", hist);

    return root;
}

esp_err_t lamp_controller_sync_power(bool on)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.power_known = true;
    s_state.power_on = on;
    snprintf(s_state.last_action, sizeof(s_state.last_action), "%s", on ? "calibrate_on" : "calibrate_off");
    s_state.last_error[0] = '\0';
    esp_err_t err = save_power_state_nvs(on);
    if (err != ESP_OK) set_error_locked(err);
    xSemaphoreGive(s_lock);

    lamp_history_change(on, LAMP_HIST_CALIBRATION);
    broadcast_lamp_state();
    return err;
}

esp_err_t lamp_controller_set_power(bool on, bool is_auto, bool *transmitted)
{
    if (transmitted) *transmitted = false;
    if (!s_lock) return ESP_ERR_INVALID_STATE;

    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_state.learning_active) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_state.radio_ready || !s_state.sample_loaded) {
        set_error_locked(ESP_ERR_INVALID_STATE);
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (!s_state.power_known) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_state.power_on == on) {
        snprintf(s_state.last_action, sizeof(s_state.last_action), "%s", on ? "already_on" : "already_off");
        s_state.last_error[0] = '\0';
        xSemaphoreGive(s_lock);
        return ESP_OK;
    }

    esp_err_t err = waveform_play(s_power_wave, 1, 30);
    if (err == ESP_OK) {
        s_state.power_on = on;
        ++s_state.power_transmissions;
        snprintf(s_state.last_action, sizeof(s_state.last_action), "%s",
                 is_auto ? (on ? "auto_on" : "auto_off") : (on ? "on" : "off"));
        esp_err_t save_err = save_power_state_nvs(on);
        if (save_err != ESP_OK) set_error_locked(save_err);
        else s_state.last_error[0] = '\0';
        if (transmitted) *transmitted = true;
    } else {
        set_error_locked(err);
    }
    xSemaphoreGive(s_lock);

    if (err == ESP_OK) {
        lamp_history_change(on, is_auto ? LAMP_HIST_AUTO : LAMP_HIST_WEB);
        broadcast_lamp_state();
    }
    return err;
}

static void learn_task(void *arg)
{
    waveform_t *tmp = heap_caps_calloc(1, sizeof(waveform_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!tmp) tmp = calloc(1, sizeof(waveform_t));

    if (!tmp) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_state.learning_active = false;
        xSemaphoreGive(s_lock);
        broadcast_learn_event("error", 0, 0, "内存不足");
        vTaskDelete(NULL);
        return;
    }

    tmp->rf = s_default_rf;
    broadcast_learn_event("listening", 0, 0, NULL);

    // Ensure CC1101 is configured at 433.92 MHz OOK before capturing
    esp_err_t err = cc1101_configure(&tmp->rf);
    if (err == ESP_OK) {
        err = waveform_capture(tmp, 10000, RX_DEFAULT_IDLE_US, RX_DEFAULT_FILTER_US);
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool still_active = s_state.learning_active;
    s_state.learning_active = false;
    if (still_active && err == ESP_OK) {
        memcpy(s_pending_wave, tmp, sizeof(waveform_t));
        s_state.pending_ready = true;
        s_state.pending_pulses = tmp->count;
        s_state.pending_duration_ms = (uint32_t)(waveform_duration(tmp) / 1000ULL);
        xSemaphoreGive(s_lock);

        ESP_LOGI(TAG, "Captured RF signal: %lu pulses, %lu ms",
                 (unsigned long)tmp->count, (unsigned long)(waveform_duration(tmp) / 1000ULL));
        broadcast_learn_event("captured", tmp->count, (uint32_t)(waveform_duration(tmp) / 1000ULL), NULL);
        broadcast_lamp_state();
    } else {
        xSemaphoreGive(s_lock);
        if (still_active) {
            if (err == ESP_ERR_TIMEOUT) {
                broadcast_learn_event("timeout", 0, 0, "10 秒内未收到遥控器信号");
            } else {
                broadcast_learn_event("error", 0, 0, esp_err_to_name(err));
            }
            broadcast_lamp_state();
        }
    }

    free(tmp);
    vTaskDelete(NULL);
}

esp_err_t lamp_controller_learn_start(void)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_state.radio_ready || s_state.learning_active) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    s_state.learning_active = true;
    s_state.pending_ready = false;
    s_state.pending_pulses = 0;
    s_state.pending_duration_ms = 0;
    xSemaphoreGive(s_lock);

    broadcast_lamp_state();
    if (xTaskCreate(learn_task, "lamp_learn", 4096, NULL, 5, NULL) != pdPASS) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_state.learning_active = false;
        xSemaphoreGive(s_lock);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t lamp_controller_learn_test(void)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_state.radio_ready || s_state.learning_active || !s_state.pending_ready) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t err = waveform_play(s_pending_wave, 1, 30);
    xSemaphoreGive(s_lock);
    return err;
}

esp_err_t lamp_controller_learn_save(void)
{
    if (!s_lock) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_state.storage_ready || !s_state.pending_ready) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t err = rf_storage_save(POWER_SAMPLE, s_pending_wave);
    if (err == ESP_OK) {
        memcpy(s_power_wave, s_pending_wave, sizeof(waveform_t));
        s_state.sample_loaded = true;
        s_state.sample_pulses = s_power_wave->count;
        s_state.sample_mhz = s_power_wave->rf.mhz;
        s_state.pending_ready = false;
        s_state.pending_pulses = 0;
        s_state.pending_duration_ms = 0;
        snprintf(s_state.last_action, sizeof(s_state.last_action), "sample_saved");
        s_state.last_error[0] = '\0';
    } else {
        set_error_locked(err);
    }
    xSemaphoreGive(s_lock);

    if (err == ESP_OK) broadcast_lamp_state();
    return err;
}

void lamp_controller_learn_cancel(void)
{
    if (!s_lock) return;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state.learning_active = false;
    s_state.pending_ready = false;
    s_state.pending_pulses = 0;
    s_state.pending_duration_ms = 0;
    xSemaphoreGive(s_lock);
    broadcast_lamp_state();
}

esp_err_t lamp_controller_import_sample(const uint8_t *raw_rf_file, size_t len)
{
    if (!s_lock || !raw_rf_file || len < 44 || len > 28 + PULSE_CAPACITY * sizeof(int32_t)) {
        return ESP_ERR_INVALID_ARG;
    }

    // Write to a temporary slot, validate via rf_storage_load (CRC32 + range checks), then promote
    const char *tmp_path = "/data/power_sample_tmp.rf";
    FILE *f = fopen(tmp_path, "wb");
    if (!f) return ESP_FAIL;
    bool wrote = fwrite(raw_rf_file, 1, len, f) == len;
    fclose(f);
    if (!wrote) {
        remove(tmp_path);
        return ESP_FAIL;
    }

    waveform_t *tmp = heap_caps_calloc(1, sizeof(waveform_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!tmp) tmp = calloc(1, sizeof(waveform_t));
    if (!tmp) {
        remove(tmp_path);
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = rf_storage_load("power_sample_tmp", tmp);
    remove(tmp_path);
    if (err != ESP_OK) {
        free(tmp);
        return err;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    err = rf_storage_save(POWER_SAMPLE, tmp);
    if (err == ESP_OK) {
        memcpy(s_power_wave, tmp, sizeof(waveform_t));
        s_state.sample_loaded = true;
        s_state.sample_pulses = s_power_wave->count;
        s_state.sample_mhz = s_power_wave->rf.mhz;
        snprintf(s_state.last_action, sizeof(s_state.last_action), "sample_imported");
        s_state.last_error[0] = '\0';
    } else {
        set_error_locked(err);
    }
    xSemaphoreGive(s_lock);
    free(tmp);

    if (err == ESP_OK) broadcast_lamp_state();
    return err;
}

void lamp_controller_on_presence_change(int prev_home, int cur_home)
{
    cfg_settings_t cfg;
    cfg_settings_get(&cfg);

    if (prev_home > 0 && cur_home == 0 && cfg.lamp_auto_off_on_away) {
        bool sent = false;
        if (lamp_controller_set_power(false, true, &sent) == ESP_OK && sent) {
            ESP_LOGI(TAG, "Auto-off lamp triggered (all persons away)");
            presence_log_append(0, "台灯联动", PRESENCE_EVENT_LEAVE, "自动关灯", 0, wifi_mgr_is_time_synced());
        }
    } else if (prev_home == 0 && cur_home > 0 && cfg.lamp_auto_on_on_arrive) {
        bool sent = false;
        if (lamp_controller_set_power(true, true, &sent) == ESP_OK && sent) {
            ESP_LOGI(TAG, "Auto-on lamp triggered (first person arrived)");
            presence_log_append(0, "台灯联动", PRESENCE_EVENT_ARRIVE, "自动开灯", 0, wifi_mgr_is_time_synced());
        }
    }
}
