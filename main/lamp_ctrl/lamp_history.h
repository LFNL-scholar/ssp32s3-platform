#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LAMP_HIST_CONTINUATION = 0,
    LAMP_HIST_WEB          = 1,
    LAMP_HIST_CALIBRATION  = 2,
    LAMP_HIST_TIME_SYNC    = 3,
    LAMP_HIST_AUTO         = 4,
} lamp_history_cause_t;

typedef struct {
    int64_t now;
    int64_t oldest;
    bool time_synced;
    bool ready;
    bool recording;
    esp_err_t error;
} lamp_history_status_t;

typedef esp_err_t (*lamp_history_writer_t)(void *ctx, const char *data, size_t len);

esp_err_t lamp_history_init(bool storage_ready);
void lamp_history_clock_synced(void);
void lamp_history_tick(bool known, bool on);
void lamp_history_change(bool on, lamp_history_cause_t cause);
void lamp_history_status(lamp_history_status_t *status);
esp_err_t lamp_history_write_json(int64_t from, int64_t to, lamp_history_writer_t writer, void *ctx);

#ifdef __cplusplus
}
#endif
