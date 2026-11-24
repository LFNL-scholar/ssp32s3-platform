#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "lamp_config.h"
#include "cc1101.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    rf_settings_t rf;
    uint32_t count;
    int32_t pulses[PULSE_CAPACITY]; // signed microseconds: positive HIGH, negative LOW
} waveform_t;

bool waveform_valid(const waveform_t *wave);
uint64_t waveform_duration(const waveform_t *wave);
esp_err_t waveform_init(void);
esp_err_t waveform_capture(waveform_t *wave, uint32_t timeout_ms, uint32_t idle_us, uint32_t filter_us);
esp_err_t waveform_play(const waveform_t *wave, uint32_t repeats, uint32_t gap_ms);

#ifdef __cplusplus
}
#endif
