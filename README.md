# SSP32S3-Platform

基于 **ESP32-S3-DevKitC-1 (N16R8)** 的嵌入式 Web 管理与蓝牙在家检测平台（ESP-IDF v5.5.4 + Preact/Vite/TypeScript）。

详细架构与协议规格见 [DESIGN.md](./DESIGN.md)。

## 硬件要求

- **开发板**：ESP32-S3-DevKitC-1（ESP32-S3-WROOM-1-N16R8）
- **Flash / PSRAM**：16MB QIO Flash + 8MB Octal (OPI) PSRAM（注意：GPIO35/36/37 被 PSRAM 占用，不可复用）
- **板载 RGB LED**：WS2812B（默认 **GPIO48**，可在网页设置调整）
- **恢复出厂按键**：BOOT 按键（**GPIO0**，长按 ≥ 5 秒触发）

## 核心功能

- **零门槛网页配网**：首次上电开启 SoftAP（`SSP32S3-XXXX`，串口打印唯一 8 位 WPA2 密码）+ Captive Portal 强制门户；连网后切换 STA 并广播 mDNS（`http://ssp32s3.local`）；连接失败自动回退 AP。
- **硬件状态实时仪表盘**：通过 WebSocket（1Hz）推送芯片信息、内部 SRAM / 8MB PSRAM / 16MB Flash 分区使用率、芯片内部温度、Wi-Fi/BLE 状态以及 FreeRTOS 任务 CPU 占用率。
- **蓝牙在家检测（NimBLE）**：
  - **配对 + IRK 解析**：通过浏览器向导触发蓝牙配对，提取手机 IRK 并存入 NVS，在手机开启随机 MAC（RPA）的情况下仍可持续识别，无需安装 App。
  - **固定 MAC 绑定**：通过附近 BLE 扫描雷达一键添加手环、信标等固定 MAC 设备；支持“一人多设备”。
  - **RSSI 滤波与迟滞判定**：EMA 平滑 + 双阈值迟滞（默认 `-75 / -85 dBm`，超时 `120s`），配合实时 RSSI 校准曲线。
  - **联动反馈**：GPIO48 WS2812B 优先级灯效 + LittleFS 1000 条环形进出日志 + SNTP 对时（默认 `CST-8`）。
- **安全与运维**：管理员密码保护 + 会话 Token 鉴权；Web OTA 双分区升级与失败自动回滚。

## 目录结构

```text
├── CMakeLists.txt
├── DESIGN.md              # 完整技术设计文档
├── partitions.csv         # 16MB 自定义分区表（双 4MB OTA + www/data LittleFS）
├── sdkconfig.defaults     # N16R8、NimBLE、HTTPD WS、FreeRTOS 统计默认配置
├── build.sh               # 一键编译前端与 ESP-IDF 固件
├── main/                  # ESP-IDF C 固件源码
│   ├── cfg_store/         # NVS 配置与密码哈希存储
│   ├── wifi_mgr/          # SoftAP / Captive DNS / STA / mDNS / SNTP
│   ├── sys_monitor/       # 芯片、内存、分区、温度、任务 CPU 采集
│   ├── ble_presence/      # NimBLE 扫描、IRK/RPA 解析、在家判定状态机
│   ├── presence_log/      # LittleFS 二进制环形进出日志
│   ├── led_ctrl/          # WS2812B 优先级状态机
│   ├── ota_mgr/           # 流式 Web OTA 与回滚确认
│   ├── btn_reset/         # GPIO0 长按恢复出厂
│   └── web_server/        # REST API、WebSocket 与静态 gzip 托管
└── web/                   # Preact + Vite + TypeScript 全离线前端（gzip ~18KB）
```

## 编译与烧录

环境要求：Node.js >= 20、ESP-IDF v5.5.x。

```bash
# 1. 构建前端与固件
./build.sh

# 2. 烧录并打开串口监视器（查看 SoftAP 初始密码）
source ~/.espressif/tools/activate_idf_v5.5.4.sh
idf.py -p /dev/cu.<串口> flash monitor
```
