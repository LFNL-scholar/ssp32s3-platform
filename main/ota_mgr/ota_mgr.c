#include "ota_mgr.h"

#include <string.h>
#include <stdlib.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_ota_ops.h"
#include "esp_app_format.h"
#include "esp_partition.h"
#include "esp_littlefs.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_log.h"

#include "led_ctrl.h"
#include "ble_presence.h"

static const char *TAG = "ota_mgr";

static void reboot_timer_cb(void *arg)
{
    esp_restart();
}

static esp_err_t send_json_err(httpd_req_t *req, const char *status, const char *msg)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    char buf[192];
    snprintf(buf, sizeof(buf), "{\"ok\":false,\"error\":\"%s\"}", msg);
    httpd_resp_send(req, buf, HTTPD_RESP_USE_STRLEN);
    return ESP_OK;
}

esp_err_t ota_mgr_handle_upload(httpd_req_t *req)
{
    if (req->content_len <= 0) {
        return send_json_err(req, "400 Bad Request", "固件文件为空");
    }

    const esp_partition_t *update_part = esp_ota_get_next_update_partition(NULL);
    if (!update_part) {
        return send_json_err(req, "500 Internal Server Error", "未找到可用 OTA 分区");
    }

    if ((size_t)req->content_len > update_part->size) {
        return send_json_err(req, "413 Payload Too Large", "固件大小超出 OTA 分区容量");
    }

    char *buf = malloc(4096);
    if (!buf) {
        return send_json_err(req, "500 Internal Server Error", "内存不足");
    }

    ble_presence_pause_scan(true);
    led_ctrl_set_flag(LED_FLAG_OTA, true);

    esp_ota_handle_t ota_handle = 0;
    bool ota_begun = false;
    bool header_checked = false;
    int remaining = req->content_len;
    esp_err_t err = ESP_OK;
    const char *err_msg = "OTA 写入失败";

    while (remaining > 0) {
        int to_read = remaining > 4096 ? 4096 : remaining;
        int recv_len = httpd_req_recv(req, buf, to_read);
        if (recv_len <= 0) {
            if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) continue;
            err = ESP_FAIL;
            err_msg = "网络传输中断";
            break;
        }

        if (!header_checked) {
            if (recv_len < (int)(sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(esp_app_desc_t))) {
                err = ESP_ERR_INVALID_ARG;
                err_msg = "固件头不完整";
                break;
            }
            const esp_image_header_t *img_hdr = (const esp_image_header_t *)buf;
            if (img_hdr->magic != ESP_IMAGE_HEADER_MAGIC) {
                err = ESP_ERR_INVALID_ARG;
                err_msg = "无效的 ESP32 固件格式";
                break;
            }
            header_checked = true;

            err = esp_ota_begin(update_part, OTA_WITH_SEQUENTIAL_WRITES, &ota_handle);
            if (err != ESP_OK) {
                err_msg = "esp_ota_begin 失败";
                break;
            }
            ota_begun = true;
        }

        err = esp_ota_write(ota_handle, buf, recv_len);
        if (err != ESP_OK) {
            err_msg = "写入 Flash 失败";
            break;
        }
        remaining -= recv_len;
    }

    free(buf);

    if (err == ESP_OK && ota_begun) {
        err = esp_ota_end(ota_handle);
        ota_begun = false;
        if (err != ESP_OK) {
            err_msg = "固件校验失败";
        } else {
            err = esp_ota_set_boot_partition(update_part);
            if (err != ESP_OK) {
                err_msg = "设置启动分区失败";
            }
        }
    }

    if (ota_begun) {
        esp_ota_abort(ota_handle);
    }

    if (err != ESP_OK) {
        led_ctrl_set_flag(LED_FLAG_OTA, false);
        ble_presence_pause_scan(false);
        ESP_LOGE(TAG, "OTA failed: %s (%s)", err_msg, esp_err_to_name(err));
        return send_json_err(req, "400 Bad Request", err_msg);
    }

    ESP_LOGI(TAG, "OTA update succeeded! Target partition=%s, rebooting in 1s...", update_part->label);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"rebooting\":true}", HTTPD_RESP_USE_STRLEN);

    const esp_timer_create_args_t targs = { .callback = reboot_timer_cb, .name = "ota_reboot" };
    esp_timer_handle_t t = NULL;
    if (esp_timer_create(&targs, &t) == ESP_OK) {
        esp_timer_start_once(t, 1000000ULL);
    } else {
        esp_restart();
    }
    return ESP_OK;
}

void ota_mgr_confirm_if_pending(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK) {
        if (state == ESP_OTA_IMG_PENDING_VERIFY) {
            ESP_LOGI(TAG, "Confirming newly booted OTA partition '%s' as valid", running->label);
            esp_ota_mark_app_valid_cancel_rollback();
        }
    }
}

esp_err_t ota_mgr_handle_www_upload(httpd_req_t *req)
{
    if (req->content_len < 4096) {
        return send_json_err(req, "400 Bad Request", "Web 镜像文件过小或为空");
    }

    const esp_partition_t *www_part = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_LITTLEFS, "www");
    if (!www_part) {
        return send_json_err(req, "500 Internal Server Error", "未找到 www 分区");
    }

    if ((size_t)req->content_len > www_part->size) {
        return send_json_err(req, "413 Payload Too Large", "Web 镜像超出 www 分区容量");
    }

    char *buf = malloc(4096);
    if (!buf) {
        return send_json_err(req, "500 Internal Server Error", "内存不足");
    }

    ble_presence_pause_scan(true);
    led_ctrl_set_flag(LED_FLAG_OTA, true);
    esp_vfs_littlefs_unregister("www");

    esp_err_t err = esp_partition_erase_range(www_part, 0, www_part->size);
    const char *err_msg = "擦除 www 分区失败";
    size_t offset = 0;
    int remaining = req->content_len;

    while (err == ESP_OK && remaining > 0) {
        int to_read = remaining > 4096 ? 4096 : remaining;
        int recv_len = httpd_req_recv(req, buf, to_read);
        if (recv_len <= 0) {
            if (recv_len == HTTPD_SOCK_ERR_TIMEOUT) continue;
            err = ESP_FAIL;
            err_msg = "网络传输中断";
            break;
        }
        err = esp_partition_write(www_part, offset, buf, (size_t)recv_len);
        if (err != ESP_OK) {
            err_msg = "写入 www 分区失败";
            break;
        }
        offset += (size_t)recv_len;
        remaining -= recv_len;
    }

    free(buf);

    if (err != ESP_OK) {
        led_ctrl_set_flag(LED_FLAG_OTA, false);
        ble_presence_pause_scan(false);
        ESP_LOGE(TAG, "WWW OTA failed: %s (%s)", err_msg, esp_err_to_name(err));
        return send_json_err(req, "400 Bad Request", err_msg);
    }

    ESP_LOGI(TAG, "WWW OTA succeeded (%u bytes), rebooting in 1s...", (unsigned)offset);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_send(req, "{\"ok\":true,\"rebooting\":true}", HTTPD_RESP_USE_STRLEN);

    const esp_timer_create_args_t targs = { .callback = reboot_timer_cb, .name = "www_ota_reboot" };
    esp_timer_handle_t t = NULL;
    if (esp_timer_create(&targs, &t) == ESP_OK) {
        esp_timer_start_once(t, 1000000ULL);
    } else {
        esp_restart();
    }
    return ESP_OK;
}
