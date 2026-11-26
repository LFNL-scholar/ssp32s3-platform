# Copy this file to `k230-cam/config.py` (never commit `config.py` to git).
# Note: LCSC Lushan-Pi K230 onboard RTL8189FTV Wi-Fi supports 2.4GHz networks ONLY.

WIFI_SSID = "你的2.4G_WiFi名称"
WIFI_PASS = "你的WiFi密码"

# External Cloudflare Worker camera tunnel endpoint + shared TUNNEL_SECRET
# (Matches the secret configured on your Cloudflare Worker `TUNNEL_SECRET`)
TUNNEL_URL = "wss://s3.lfnltech.xyz/cam/connect"
TUNNEL_SECRET = "你的TUNNEL_SECRET"

# Local LAN HTTP MJPEG server port
LAN_PORT = 8080

# Default video settings: "640x368" | "1280x720" | "1920x1080"
DEFAULT_RES = "1280x720"
DEFAULT_FPS = 20
DEFAULT_QUALITY = 75

# Camera sensor orientation
H_MIRROR = False
V_FLIP = False
