#include "waveform.h"

#include <inttypes.h>
#include <stdlib.h>
#include "driver/rmt_rx.h"
#include "driver/rmt_tx.h"
#include "driver/rmt_encoder.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static const char *TAG = "waveform";
static rmt_channel_handle_t rx_channel, tx_channel;
static rmt_encoder_handle_t copy_encoder;
static QueueHandle_t rx_queue;
static rmt_symbol_word_t *rx_symbols, *tx_symbols;

static uint32_t magnitude(int32_t pulse)
{
    return pulse < 0 ? (uint32_t)(-(int64_t)pulse) : (uint32_t)pulse;
}

uint64_t waveform_duration(const waveform_t *wave)
{
    uint64_t total = 0;
    for (uint32_t i = 0; i < wave->count && i < PULSE_CAPACITY; ++i)
        total += magnitude(wave->pulses[i]);
    return total;
}

bool waveform_valid(const waveform_t *wave)
{
    if (!wave || !cc1101_settings_valid(&wave->rf) || wave->count < 4 || wave->count > PULSE_CAPACITY)
        return false;
    bool high = false, low = false;
    uint64_t total = 0;
    for (uint32_t i = 0; i < wave->count; ++i) {
        if (!wave->pulses[i]) return false;
        high |= wave->pulses[i] > 0;
        low |= wave->pulses[i] < 0;
        total += magnitude(wave->pulses[i]);
    }
    return high && low && total <= MAX_WAVE_US;
}

static bool rx_done(rmt_channel_handle_t channel, const rmt_rx_done_event_data_t *event, void *context)
{
    (void)channel;
    BaseType_t wake = pdFALSE;
    xQueueSendFromISR((QueueHandle_t)context, event, &wake);
    return wake == pdTRUE;
}

esp_err_t waveform_init(void)
{
    rx_queue = xQueueCreate(1, sizeof(rmt_rx_done_event_data_t));
    rx_symbols = heap_caps_calloc(RX_SYMBOL_CAPACITY, sizeof(*rx_symbols), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    tx_symbols = heap_caps_calloc(PULSE_CAPACITY, sizeof(*tx_symbols), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!tx_symbols) {
        tx_symbols = heap_caps_calloc(PULSE_CAPACITY, sizeof(*tx_symbols), MALLOC_CAP_INTERNAL);
    }
    if (!rx_queue || !rx_symbols || !tx_symbols) return ESP_ERR_NO_MEM;
    rmt_rx_channel_config_t rx = {
        .gpio_num = RF_GDO2, .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 1000000, .mem_block_symbols = RX_SYMBOL_CAPACITY,
        .flags.with_dma = true,
    };
    ESP_RETURN_ON_ERROR(rmt_new_rx_channel(&rx, &rx_channel), TAG, "create RMT RX DMA");
    rmt_rx_event_callbacks_t callbacks = {.on_recv_done = rx_done};
    ESP_RETURN_ON_ERROR(rmt_rx_register_event_callbacks(rx_channel, &callbacks, rx_queue), TAG, "RX callback");
    rmt_tx_channel_config_t tx = {
        .gpio_num = RF_GDO0, .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 1000000, .mem_block_symbols = 1024, .trans_queue_depth = 1,
        .flags.with_dma = true,
    };
    ESP_RETURN_ON_ERROR(rmt_new_tx_channel(&tx, &tx_channel), TAG, "create RMT TX DMA");
    rmt_copy_encoder_config_t copy = {};
    return rmt_new_copy_encoder(&copy, &copy_encoder);
}

static esp_err_t append_pulse(waveform_t *wave, unsigned level, unsigned duration)
{
    if (!duration) return ESP_OK;
    int32_t pulse = level ? (int32_t)duration : -(int32_t)duration;
    if (wave->count && (wave->pulses[wave->count - 1] > 0) == (pulse > 0)) {
        int64_t merged = (int64_t)wave->pulses[wave->count - 1] + pulse;
        if (merged > MAX_WAVE_US || merged < -(int64_t)MAX_WAVE_US) return ESP_ERR_INVALID_SIZE;
        wave->pulses[wave->count - 1] = (int32_t)merged;
    } else {
        if (wave->count >= PULSE_CAPACITY) return ESP_ERR_INVALID_SIZE;
        wave->pulses[wave->count++] = pulse;
    }
    return ESP_OK;
}

esp_err_t waveform_capture(waveform_t *wave, uint32_t timeout_ms, uint32_t idle_us, uint32_t filter_us)
{
    if (!rx_channel || !wave || timeout_ms < 100 || timeout_ms > 15000 || idle_us < 1000 ||
        idle_us > 30000 || filter_us > 3 || filter_us >= idle_us)
        return ESP_ERR_INVALID_ARG;
    wave->count = 0;
    ESP_RETURN_ON_ERROR(cc1101_receive(), TAG, "radio RX");
    xQueueReset(rx_queue);
    ESP_RETURN_ON_ERROR(rmt_enable(rx_channel), TAG, "enable RX");
    rmt_receive_config_t config = {
        .signal_range_min_ns = filter_us * 1000,
        .signal_range_max_ns = idle_us * 1000,
    };
    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    esp_err_t result = ESP_ERR_TIMEOUT;
    while (esp_timer_get_time() < deadline) {
        result = rmt_receive(rx_channel, rx_symbols, RX_SYMBOL_CAPACITY * sizeof(*rx_symbols), &config);
        if (result != ESP_OK) break;
        int64_t remaining_ms = (deadline - esp_timer_get_time() + 999) / 1000;
        if (remaining_ms <= 0) { result = ESP_ERR_TIMEOUT; break; }
        rmt_rx_done_event_data_t event;
        TickType_t ticks = pdMS_TO_TICKS(remaining_ms);
        if (xQueueReceive(rx_queue, &event, ticks ? ticks : 1) != pdTRUE) {
            result = ESP_ERR_TIMEOUT; break;
        }
        if (!event.flags.is_last || event.num_symbols >= RX_SYMBOL_CAPACITY) {
            result = ESP_ERR_INVALID_SIZE; break;
        }
        wave->count = 0;
        for (size_t i = 0; i < event.num_symbols; ++i) {
            rmt_symbol_word_t s = event.received_symbols[i];
            result = append_pulse(wave, s.level0, s.duration0);
            if (result == ESP_OK) result = append_pulse(wave, s.level1, s.duration1);
            if (result != ESP_OK) break;
        }
        if (result != ESP_OK) break;
        if (wave->count >= 16) {
            result = waveform_valid(wave) ? ESP_OK : ESP_ERR_INVALID_SIZE;
            break;
        }
        result = ESP_ERR_TIMEOUT;
    }
    esp_err_t stop = rmt_disable(rx_channel);
    xQueueReset(rx_queue);
    if (result == ESP_OK && stop != ESP_OK) result = stop;
    if (result != ESP_OK) wave->count = 0;
    return result;
}

static esp_err_t build_tx(const waveform_t *wave, size_t *symbol_count)
{
    size_t half = 0;
    for (uint32_t i = 0; i < wave->count; ++i) {
        uint32_t remaining = magnitude(wave->pulses[i]);
        while (remaining) {
            if (half >= PULSE_CAPACITY * 2) return ESP_ERR_INVALID_SIZE;
            uint32_t duration = remaining > 32767 ? 32767 : remaining;
            rmt_symbol_word_t *s = &tx_symbols[half / 2];
            if (!(half & 1)) {
                s->val = 0;
                s->level0 = wave->pulses[i] > 0;
                s->duration0 = duration;
            } else {
                s->level1 = wave->pulses[i] > 0;
                s->duration1 = duration;
            }
            ++half;
            remaining -= duration;
        }
    }
    *symbol_count = (half + 1) / 2;
    return ESP_OK;
}

esp_err_t waveform_play(const waveform_t *wave, uint32_t repeats, uint32_t gap_ms)
{
    if (!tx_channel || !waveform_valid(wave) || repeats < 1 || repeats > 3 || gap_ms < 10 || gap_ms > 1000)
        return ESP_ERR_INVALID_ARG;
    size_t count = 0;
    ESP_RETURN_ON_ERROR(build_tx(wave, &count), TAG, "pack TX symbols");
    ESP_RETURN_ON_ERROR(cc1101_configure(&wave->rf), TAG, "restore RF settings");
    ESP_RETURN_ON_ERROR(cc1101_idle(), TAG, "idle before enabling RMT TX");
    ESP_RETURN_ON_ERROR(rmt_enable(tx_channel), TAG, "enable TX");
    esp_err_t result = cc1101_transmit();
    rmt_transmit_config_t tx = {.loop_count = 0, .flags.eot_level = 0};
    for (uint32_t i = 0; result == ESP_OK && i < repeats; ++i) {
        result = rmt_transmit(tx_channel, copy_encoder, tx_symbols, count * sizeof(*tx_symbols), &tx);
        if (result == ESP_OK) result = rmt_tx_wait_all_done(tx_channel, MAX_WAVE_US / 1000 + 1000);
        if (result == ESP_OK && i + 1 < repeats) vTaskDelay(pdMS_TO_TICKS(gap_ms));
    }
    esp_err_t idle = cc1101_idle();
    esp_err_t disable = rmt_disable(tx_channel);
    esp_err_t rx = cc1101_receive();
    if (result != ESP_OK) return result;
    if (idle != ESP_OK) return idle;
    return disable != ESP_OK ? disable : rx;
}
