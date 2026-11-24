#include "rf_storage.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "esp_crc.h"

// 100% binary compatible with light-control power_sample_1.rf
#define RF_MAGIC 0x49444631U

typedef struct {
    uint32_t magic, version, count;
    rf_settings_t rf;
    uint32_t crc;
} rf_file_header_t;

static bool path_for(const char *name, char path[64])
{
    if (!name) return false;
    size_t len = strlen(name);
    if (!len || len > 24) return false;
    for (size_t i = 0; i < len; ++i) {
        if (!isalnum((unsigned char)name[i]) && name[i] != '_' && name[i] != '-') return false;
    }
    snprintf(path, 64, "/data/%s.rf", name);
    return true;
}

static uint32_t checksum(const rf_file_header_t *header, const int32_t *pulses)
{
    uint32_t crc = esp_crc32_le(0, (const uint8_t *)header, offsetof(rf_file_header_t, crc));
    return esp_crc32_le(crc, (const uint8_t *)pulses, header->count * sizeof(*pulses));
}

esp_err_t rf_storage_save(const char *name, const waveform_t *wave)
{
    char path[64];
    if (!path_for(name, path) || !waveform_valid(wave)) return ESP_ERR_INVALID_ARG;
    rf_file_header_t header = {.magic = RF_MAGIC, .version = 1, .count = wave->count, .rf = wave->rf};
    header.crc = checksum(&header, wave->pulses);
    FILE *file = fopen(path, "wb");
    if (!file) return ESP_FAIL;
    bool ok = fwrite(&header, sizeof(header), 1, file) == 1 &&
              fwrite(wave->pulses, sizeof(int32_t), wave->count, file) == wave->count;
    if (ok) ok = fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file)) ok = false;
    if (!ok) remove(path);
    return ok ? ESP_OK : ESP_FAIL;
}

esp_err_t rf_storage_load(const char *name, waveform_t *wave)
{
    char path[64];
    if (!wave) return ESP_ERR_INVALID_ARG;
    wave->count = 0;
    if (!path_for(name, path)) return ESP_ERR_INVALID_ARG;
    FILE *file = fopen(path, "rb");
    if (!file) return ESP_ERR_NOT_FOUND;

    rf_file_header_t header = {0};
    struct stat info;
    bool ok = !stat(path, &info) && fread(&header, sizeof(header), 1, file) == 1 &&
              header.magic == RF_MAGIC && header.version == 1 && header.count >= 4 &&
              header.count <= PULSE_CAPACITY && cc1101_settings_valid(&header.rf) &&
              info.st_size == (off_t)(sizeof(header) + header.count * sizeof(int32_t));
    if (ok) {
        ok = fread(wave->pulses, sizeof(int32_t), header.count, file) == header.count &&
             checksum(&header, wave->pulses) == header.crc;
    }
    fclose(file);
    if (!ok) return ESP_ERR_INVALID_CRC;
    wave->rf = header.rf;
    wave->count = header.count;
    if (!waveform_valid(wave)) {
        wave->count = 0;
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}
