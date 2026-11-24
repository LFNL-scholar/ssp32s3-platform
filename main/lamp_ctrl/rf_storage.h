#pragma once

#include "esp_err.h"
#include "waveform.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t rf_storage_save(const char *name, const waveform_t *wave);
esp_err_t rf_storage_load(const char *name, waveform_t *wave);

#ifdef __cplusplus
}
#endif
