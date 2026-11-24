#pragma once

// Exact hardware wiring from light-control (ESP32-S3-DevKitC-1 N16R8)
#define RF_SCK   12
#define RF_MISO  13
#define RF_MOSI  11
#define RF_CS    10
#define RF_GDO0  4
#define RF_GDO2  5

#define RF_DEFAULT_MHZ         433.92f
#define RF_DEFAULT_BW_KHZ      325.0f
#define RF_DEFAULT_RATE_KBAUD  4.8f
#define RX_SYMBOL_CAPACITY     4096
#define PULSE_CAPACITY         (RX_SYMBOL_CAPACITY * 2)
#define MAX_WAVE_US            3000000U
#define RX_DEFAULT_IDLE_US     20000U
#define RX_DEFAULT_FILTER_US   1U
