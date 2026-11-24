#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PRESENCE_LOG_MAX_ENTRIES 1000

typedef enum {
    PRESENCE_EVENT_ARRIVE = 1,
    PRESENCE_EVENT_LEAVE  = 2,
} presence_event_type_t;

typedef struct __attribute__((packed)) {
    uint32_t seq;
    int64_t timestamp;
    uint32_t uptime_s;
    uint8_t time_synced;
    uint8_t person_id;
    uint8_t event;
    int8_t rssi;
    char person_name[32];
    char device_label[32];
    uint8_t reserved[12];
} presence_log_entry_t;

_Static_assert(sizeof(presence_log_entry_t) == 96, "presence_log_entry_t must be 96 bytes");

esp_err_t presence_log_init(void);
esp_err_t presence_log_append(uint8_t person_id, const char *person_name,
                              presence_event_type_t event, const char *device_label,
                              int8_t rssi, bool time_synced);
esp_err_t presence_log_query(size_t offset, size_t limit,
                             presence_log_entry_t *out_entries,
                             size_t *out_returned, size_t *out_total);
esp_err_t presence_log_clear(void);

#ifdef __cplusplus
}
#endif
