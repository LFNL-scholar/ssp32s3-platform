#include "btn_reset.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"

#include "cfg_store.h"
#include "led_ctrl.h"

static const char *TAG = "btn_reset";
static int s_btn_gpio = 0;

static void btn_task(void *arg)
{
    uint32_t held_ms = 0;
    const uint32_t poll_ms = 50;
    const uint32_t trigger_ms = 5000;

    while (1) {
        if (gpio_get_level((gpio_num_t)s_btn_gpio) == 0) {
            held_ms += poll_ms;
            if (held_ms == 1000) {
                ESP_LOGI(TAG, "BOOT button held for 1s (hold 5s for factory reset)...");
            }
            if (held_ms >= trigger_ms) {
                ESP_LOGW(TAG, "Factory reset triggered via GPIO%d!", s_btn_gpio);
                led_ctrl_set_flag(LED_FLAG_FACTORY_RESET, true);
                vTaskDelay(pdMS_TO_TICKS(600));
                cfg_store_factory_reset();
                esp_restart();
            }
        } else {
            held_ms = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(poll_ms));
    }
}

esp_err_t btn_reset_init(int gpio_num)
{
    s_btn_gpio = gpio_num;
    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << gpio_num),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) return err;

    xTaskCreate(btn_task, "btn_reset", 2560, NULL, 4, NULL);
    ESP_LOGI(TAG, "Factory reset button monitor started on GPIO%d", gpio_num);
    return ESP_OK;
}
