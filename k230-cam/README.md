# K230 Edge Vision Node (`k230-cam`)

将**立创·庐山派 K230 (CanMV)** 作为独立边缘视觉节点接入「S3控制系统」：
- **局域网直连**：提供 `http://<K230_IP>:8080/stream`（MJPEG）与 `/snapshot`、`/status`、`/config`。
- **外网按需隧道**：通过 `wss://s3.lfnltech.xyz/cam/connect` 连入 Cloudflare Worker，平时没人观看时 **0 字节上传**；外网登录后打开「视觉监控」页即按需推流。

## 快速启用步骤

1. 复制配置文件并填写你的 **2.4GHz Wi-Fi** 与 **`TUNNEL_SECRET`**（与 Cloudflare Worker 的 `TUNNEL_SECRET` 相同）：
   ```powershell
   Copy-Item k230-cam\config.example.py k230-cam\config.py
   ```
   > ⚠️ 庐山派 K230 板载 RTL8189FTV 网卡仅支持 **2.4GHz Wi-Fi**，不支持 5GHz 频段；`config.py` 已加入 `.gitignore`，不会上传到 GitHub。

2. 确保 CanMV IDE 已断开串口占用，运行脚本把代码写入 K230 `/sdcard/` 并启动：
   ```powershell
   python k230-cam\deploy_k230.py --port COM12 --run
   ```
   （也可以直接用 CanMV IDE 依次把 `config.py`、`ws_client.py`、`main.py` 保存到开发板 `/sdcard/`。）

3. 启动后串口会打印 `Wi-Fi connected! K230 LAN IP: 192.168.x.x` 与 `Cloud tunnel connected!`：
   - 外网打开 `https://s3.lfnltech.xyz` → 左侧「视觉监控」即可直接观看。
   - 局域网打开 `http://esp32s3.local` → 在「视觉监控」填入 `http://192.168.x.x:8080` 保存即可高帧率直连。
