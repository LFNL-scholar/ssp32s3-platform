#include "cc1101.h"
#include "lamp_config.h"

#include <math.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "cc1101";
static spi_device_handle_t device;

static esp_err_t ready(void)
{
    int64_t deadline = esp_timer_get_time() + 10000;
    while (gpio_get_level(RF_MISO)) {
        if (esp_timer_get_time() >= deadline) return ESP_ERR_TIMEOUT;
        esp_rom_delay_us(5);
    }
    return ESP_OK;
}

static esp_err_t transfer(uint8_t *tx, uint8_t *rx, size_t length)
{
    if (!device) return ESP_ERR_INVALID_STATE;
    esp_err_t err = spi_device_acquire_bus(device, portMAX_DELAY);
    if (err != ESP_OK) return err;
    gpio_set_level(RF_CS, 0);
    err = ready();
    if (err == ESP_OK) {
        spi_transaction_t transaction = {.length = length * 8, .tx_buffer = tx, .rx_buffer = rx};
        err = spi_device_polling_transmit(device, &transaction);
        if (err == ESP_OK && tx[0] == 0x30) err = ready();
    }
    gpio_set_level(RF_CS, 1);
    spi_device_release_bus(device);
    return err;
}

static esp_err_t write_reg(uint8_t address, uint8_t value)
{
    uint8_t tx[] = {address, value};
    return transfer(tx, NULL, sizeof(tx));
}

static esp_err_t read_reg(uint8_t address, uint8_t *value)
{
    uint8_t tx[] = {address | (address >= 0x30 ? 0xC0 : 0x80), 0};
    uint8_t rx[2] = {0};
    esp_err_t err = transfer(tx, rx, sizeof(tx));
    if (err == ESP_OK) *value = rx[1];
    return err;
}

static esp_err_t strobe(uint8_t command)
{
    return transfer(&command, NULL, 1);
}

static esp_err_t wait_state(uint8_t wanted)
{
    int64_t deadline = esp_timer_get_time() + 50000;
    do {
        uint8_t state = 0;
        esp_err_t err = read_reg(0x35, &state);
        if (err != ESP_OK) return err;
        if ((state & 0x1F) == wanted) return ESP_OK;
        vTaskDelay(1);
    } while (esp_timer_get_time() < deadline);
    return ESP_ERR_TIMEOUT;
}

esp_err_t cc1101_idle(void)
{
    esp_err_t err = strobe(0x36);
    return err == ESP_OK ? wait_state(0x01) : err;
}

esp_err_t cc1101_receive(void)
{
    ESP_RETURN_ON_ERROR(cc1101_idle(), TAG, "idle before RX");
    ESP_RETURN_ON_ERROR(strobe(0x34), TAG, "SRX");
    return wait_state(0x0D);
}

esp_err_t cc1101_transmit(void)
{
    ESP_RETURN_ON_ERROR(cc1101_idle(), TAG, "idle before TX");
    ESP_RETURN_ON_ERROR(strobe(0x35), TAG, "STX");
    return wait_state(0x13);
}

bool cc1101_settings_valid(const rf_settings_t *s)
{
    return s && isfinite(s->mhz) && s->mhz >= 433.05f && s->mhz <= 434.79f &&
           isfinite(s->bandwidth_khz) && s->bandwidth_khz >= 58 && s->bandwidth_khz <= 812 &&
           isfinite(s->rate_kbaud) && s->rate_kbaud >= 0.6f && s->rate_kbaud <= 100;
}

esp_err_t cc1101_configure(const rf_settings_t *s)
{
    if (!cc1101_settings_valid(s)) return ESP_ERR_INVALID_ARG;
    ESP_RETURN_ON_ERROR(cc1101_idle(), TAG, "idle before configuration");
    static const uint8_t registers[][2] = {
        {0x00, 0x0D}, {0x01, 0x2E}, {0x02, 0x2E}, {0x06, 0x00},
        {0x07, 0x00}, {0x08, 0x30}, {0x09, 0x00}, {0x0A, 0x00},
        {0x0B, 0x06}, {0x0C, 0x00}, {0x12, 0x30}, {0x13, 0x00},
        {0x14, 0x00}, {0x15, 0x00}, {0x16, 0x07}, {0x17, 0x00},
        {0x18, 0x18}, {0x19, 0x16}, {0x1A, 0x1C}, {0x1B, 0xC7},
        {0x1C, 0x00}, {0x1D, 0xB2}, {0x21, 0x56}, {0x22, 0x11},
        {0x23, 0xE9}, {0x24, 0x2A}, {0x25, 0x00}, {0x26, 0x1F},
        {0x29, 0x59}, {0x2C, 0x81}, {0x2D, 0x35}, {0x2E, 0x09},
    };
    for (size_t i = 0; i < sizeof(registers) / sizeof(registers[0]); ++i)
        ESP_RETURN_ON_ERROR(write_reg(registers[i][0], registers[i][1]), TAG, "write register");

    uint32_t word = (uint32_t)lround(s->mhz * 65536.0 / 26.0);
    ESP_RETURN_ON_ERROR(write_reg(0x0D, word >> 16), TAG, "FREQ2");
    ESP_RETURN_ON_ERROR(write_reg(0x0E, word >> 8), TAG, "FREQ1");
    ESP_RETURN_ON_ERROR(write_reg(0x0F, word), TAG, "FREQ0");

    float bw_error = INFINITY, rate_error = INFINITY;
    uint8_t best_bw = 0, best_e = 0, best_m = 0;
    for (int e = 0; e <= 3; ++e) for (int m = 0; m <= 3; ++m) {
        float actual = 26000.0f / (8 * (4 + m) * (1 << e));
        float error = fabsf(actual - s->bandwidth_khz);
        if (error < bw_error) { bw_error = error; best_bw = (uint8_t)((e << 6) | (m << 4)); }
    }
    for (int e = 0; e <= 15; ++e) for (int m = 0; m <= 255; ++m) {
        float actual = (256.0f + m) * (1U << e) * 26000.0f / 268435456.0f;
        float error = fabsf(actual - s->rate_kbaud);
        if (error < rate_error) { rate_error = error; best_e = (uint8_t)e; best_m = (uint8_t)m; }
    }
    ESP_RETURN_ON_ERROR(write_reg(0x10, best_bw | best_e), TAG, "MDMCFG4");
    ESP_RETURN_ON_ERROR(write_reg(0x11, best_m), TAG, "MDMCFG3");
    uint8_t pa[] = {0x7E, 0, 0x60, 0, 0, 0, 0, 0, 0};
    ESP_RETURN_ON_ERROR(transfer(pa, NULL, sizeof(pa)), TAG, "PATABLE");
    uint8_t check = 0;
    ESP_RETURN_ON_ERROR(read_reg(0x08, &check), TAG, "readback");
    if (check != 0x30) return ESP_ERR_INVALID_RESPONSE;
    ESP_RETURN_ON_ERROR(read_reg(0x12, &check), TAG, "readback");
    if (check != 0x30) return ESP_ERR_INVALID_RESPONSE;
    return cc1101_receive();
}

esp_err_t cc1101_init(const rf_settings_t *s)
{
    if (!device) {
        gpio_config_t cs = {.pin_bit_mask = 1ULL << RF_CS, .mode = GPIO_MODE_OUTPUT};
        ESP_RETURN_ON_ERROR(gpio_config(&cs), TAG, "CS GPIO");
        gpio_set_level(RF_CS, 1);
        spi_bus_config_t bus = {
            .mosi_io_num = RF_MOSI, .miso_io_num = RF_MISO, .sclk_io_num = RF_SCK,
            .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = 32,
        };
        ESP_RETURN_ON_ERROR(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED), TAG, "SPI bus");
        spi_device_interface_config_t cfg = {
            .clock_speed_hz = 2000000, .mode = 0, .spics_io_num = -1, .queue_size = 1,
        };
        esp_err_t err = spi_bus_add_device(SPI2_HOST, &cfg, &device);
        if (err != ESP_OK) { spi_bus_free(SPI2_HOST); return err; }
        ESP_RETURN_ON_ERROR(gpio_set_pull_mode(RF_MISO, GPIO_PULLUP_ONLY), TAG, "MISO pull-up");
    }
    gpio_set_level(RF_CS, 1);
    esp_rom_delay_us(5);
    gpio_set_level(RF_CS, 0);
    esp_rom_delay_us(10);
    gpio_set_level(RF_CS, 1);
    esp_rom_delay_us(45);
    ESP_RETURN_ON_ERROR(strobe(0x30), TAG, "reset (check wiring / power)");
    uint8_t version = 0;
    ESP_RETURN_ON_ERROR(read_reg(0x31, &version), TAG, "VERSION");
    if (version == 0 || version == 0xFF) return ESP_ERR_INVALID_RESPONSE;
    ESP_LOGI(TAG, "CC1101 VERSION=0x%02X", version);
    return cc1101_configure(s);
}

esp_err_t cc1101_status(uint8_t *version, uint8_t *state, int *rssi)
{
    uint8_t raw = 0;
    ESP_RETURN_ON_ERROR(read_reg(0x31, version), TAG, "VERSION");
    ESP_RETURN_ON_ERROR(read_reg(0x35, state), TAG, "MARCSTATE");
    ESP_RETURN_ON_ERROR(read_reg(0x34, &raw), TAG, "RSSI");
    *state &= 0x1F;
    *rssi = (raw >= 128 ? (int)raw - 256 : raw) / 2 - 74;
    return ESP_OK;
}
