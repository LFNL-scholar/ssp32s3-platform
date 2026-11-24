#include "led_ctrl.h"

#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "led_strip.h"

static const char *TAG = "led_ctrl";

static SemaphoreHandle_t s_mutex = NULL;
static led_strip_handle_t s_strip = NULL;
static int s_gpio = -1;
static uint8_t s_brightness = 20;
static uint8_t s_away_mode = 0; // 0 = dim red, 1 = off
static uint32_t s_flags = 0;
static int s_home_count = 0;

static esp_err_t create_strip(int gpio)
{
    if (gpio < 0 || gpio > 48 || gpio == 35 || gpio == 36 || gpio == 37) {
        ESP_LOGE(TAG, "Invalid LED GPIO %d (avoid 35/36/37 OPI PSRAM)", gpio);
        return ESP_ERR_INVALID_ARG;
    }

    if (s_strip) {
        led_strip_clear(s_strip);
        led_strip_del(s_strip);
        s_strip = NULL;
    }

    led_strip_config_t strip_cfg = {
        .strip_gpio_num = gpio,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_cfg = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000, // 10MHz
        .mem_block_symbols = 64,
        .flags.with_dma = false,
    };

    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip);
    if (err == ESP_OK) {
        s_gpio = gpio;
        led_strip_clear(s_strip);
        ESP_LOGI(TAG, "WS2812B initialized on GPIO%d", gpio);
    } else {
        ESP_LOGE(TAG, "Failed to init led_strip on GPIO%d: %s", gpio, esp_err_to_name(err));
    }
    return err;
}

static void set_rgb_scaled(uint8_t r, uint8_t g, uint8_t b, uint8_t scale_pct)
{
    if (!s_strip) return;
    uint32_t sr = (uint32_t)r * scale_pct / 100;
    uint32_t sg = (uint32_t)g * scale_pct / 100;
    uint32_t sb = (uint32_t)b * scale_pct / 100;
    led_strip_set_pixel(s_strip, 0, sr, sg, sb);
    led_strip_refresh(s_strip);
}

static void led_task(void *arg)
{
    uint32_t tick = 0;
    while (1) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        uint32_t flags = s_flags;
        uint8_t bri = s_brightness;
        uint8_t away_mode = s_away_mode;
        int home_cnt = s_home_count;

        uint8_t r = 0, g = 0, b = 0;
        if (flags & LED_FLAG_FACTORY_RESET) {
            // Red/White fast blink (100ms)
            if ((tick / 3) % 2 == 0) {
                r = 255; g = 0; b = 0;
            } else {
                r = 255; g = 255; b = 255;
            }
        } else if (flags & LED_FLAG_OTA) {
            // Purple breathing (~1.2s period)
            float phase = (tick % 36) / 36.0f * 2.0f * (float)M_PI;
            float val = 0.25f + 0.75f * (0.5f - 0.5f * cosf(phase));
            r = (uint8_t)(200 * val);
            g = 0;
            b = (uint8_t)(255 * val);
        } else if (flags & LED_FLAG_BLE_PAIRING) {
            // Cyan fast blink (2Hz -> 250ms on, 250ms off)
            if ((tick / 8) % 2 == 0) {
                r = 0; g = 220; b = 255;
            }
        } else if (flags & LED_FLAG_AP_MODE) {
            // Blue slow breathing (~3s period)
            float phase = (tick % 90) / 90.0f * 2.0f * (float)M_PI;
            float val = 0.08f + 0.92f * (0.5f - 0.5f * cosf(phase));
            r = 0;
            g = (uint8_t)(40 * val);
            b = (uint8_t)(255 * val);
        } else {
            // Presence indication
            if (home_cnt > 0) {
                r = 0; g = 255; b = 20;
            } else if (away_mode == 0) {
                r = 60; g = 0; b = 0; // dim red
            }
        }

        set_rgb_scaled(r, g, b, bri);
        xSemaphoreGive(s_mutex);

        tick++;
        vTaskDelay(pdMS_TO_TICKS(33));
    }
}

esp_err_t led_ctrl_init(int gpio_num, uint8_t brightness, uint8_t away_mode)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_brightness = (brightness <= 100) ? brightness : 20;
    s_away_mode = away_mode;
    esp_err_t err = create_strip(gpio_num);
    xSemaphoreGive(s_mutex);

    if (err == ESP_OK) {
        xTaskCreate(led_task, "led_task", 3072, NULL, 3, NULL);
    }
    return err;
}

void led_ctrl_set_flag(led_flag_t flag, bool active)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (active) {
        s_flags |= (uint32_t)flag;
    } else {
        s_flags &= ~(uint32_t)flag;
    }
    xSemaphoreGive(s_mutex);
}

void led_ctrl_set_home_count(int count)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_home_count = count;
    xSemaphoreGive(s_mutex);
}

esp_err_t led_ctrl_apply_settings(int gpio_num, uint8_t brightness, uint8_t away_mode)
{
    if (!s_mutex) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    esp_err_t err = ESP_OK;
    if (gpio_num != s_gpio) {
        err = create_strip(gpio_num);
    }
    if (err == ESP_OK) {
        s_brightness = (brightness <= 100) ? brightness : 20;
        s_away_mode = away_mode;
    }
    xSemaphoreGive(s_mutex);
    return err;
}
