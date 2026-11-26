#include "wol_mgr.h"
#include "mqtt_bridge.h"
#include "cfg_store.h"
#include "wifi_mgr.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "lwip/etharp.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"
#include "lwip/tcpip.h"

static const char *TAG = "wol_mgr";

#define WOL_LOG_MAX          16
#define WOL_ROUNDS           3
#define WOL_ROUND_GAP_MS     200
#define WOL_WATCH_DURATION_S 90
#define WOL_WATCH_POLL_S     3
#define WOL_IDLE_POLL_S      15

typedef struct {
    uint32_t seq;
    int64_t epoch;
    uint32_t uptime_s;
    bool time_synced;
    char title[48];
    char detail[128];
    char level[12]; // "red" | "dark" | "gray"
} wol_log_entry_t;

static SemaphoreHandle_t s_mutex = NULL;
static TaskHandle_t s_task = NULL;
static wol_ws_cb_t s_ws_cb = NULL;

static bool s_online = false;
static bool s_waking = false;
static int64_t s_watch_until_us = 0;
static int64_t s_watch_start_us = 0;
static int64_t s_last_wake_epoch = 0;
static uint32_t s_last_wake_uptime_s = 0;
static bool s_last_wake_time_synced = false;
static char s_last_wake_source[32] = "";
static int s_last_sent_packets = 0;
static int64_t s_last_auto_attempt_us = 0;
static volatile bool s_auto_wake_pending = false;

static wol_log_entry_t s_logs[WOL_LOG_MAX];
static size_t s_log_count = 0;
static size_t s_log_head = 0;
static uint32_t s_log_seq = 0;

static uint32_t now_uptime_s(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000000ULL);
}

void wol_mgr_set_ws_cb(wol_ws_cb_t cb)
{
    s_ws_cb = cb;
}

bool wol_mgr_parse_mac(const char *str, uint8_t out[6])
{
    if (!str || !out) return false;
    uint8_t bytes[6] = {0};
    int nibbles = 0;
    uint8_t cur = 0;

    for (const char *p = str; *p != '\0'; p++) {
        if (*p == ':' || *p == '-' || *p == '.' || *p == ' ') continue;
        int val = -1;
        if (*p >= '0' && *p <= '9') val = *p - '0';
        else if (*p >= 'a' && *p <= 'f') val = 10 + (*p - 'a');
        else if (*p >= 'A' && *p <= 'F') val = 10 + (*p - 'A');
        else return false;

        if (nibbles >= 12) return false;
        if ((nibbles & 1) == 0) {
            cur = (uint8_t)(val << 4);
        } else {
            bytes[nibbles / 2] = (uint8_t)(cur | val);
        }
        nibbles++;
    }
    if (nibbles != 12) return false;
    memcpy(out, bytes, 6);
    return true;
}

bool wol_mgr_format_mac(const uint8_t mac[6], char *out, size_t out_len)
{
    if (!mac || !out || out_len < 18) return false;
    snprintf(out, out_len, "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return true;
}

static void log_event_locked(const char *title, const char *detail, const char *level)
{
    wol_log_entry_t *e = &s_logs[s_log_head];
    memset(e, 0, sizeof(*e));
    e->seq = ++s_log_seq;
    e->uptime_s = now_uptime_s();
    e->time_synced = wifi_mgr_is_time_synced();
    e->epoch = e->time_synced ? (int64_t)time(NULL) : 0;
    strlcpy(e->title, title ? title : "", sizeof(e->title));
    strlcpy(e->detail, detail ? detail : "", sizeof(e->detail));
    strlcpy(e->level, level ? level : "gray", sizeof(e->level));

    s_log_head = (s_log_head + 1) % WOL_LOG_MAX;
    if (s_log_count < WOL_LOG_MAX) s_log_count++;
}

void wol_mgr_log_event(const char *title, const char *detail, const char *level)
{
    if (!s_mutex) return;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    log_event_locked(title, detail, level);
    xSemaphoreGive(s_mutex);
    wol_mgr_broadcast_state();
}

static bool probe_tcp_port(const char *ip_str, uint16_t port, int timeout_ms)
{
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    if (inet_pton(AF_INET, ip_str, &addr.sin_addr) != 1) return false;

    int sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock < 0) return false;

    int flags = fcntl(sock, F_GETFL, 0);
    if (flags >= 0) fcntl(sock, F_SETFL, flags | O_NONBLOCK);

    int rc = connect(sock, (struct sockaddr *)&addr, sizeof(addr));
    bool alive = false;
    if (rc == 0) {
        alive = true;
    } else if (errno == EINPROGRESS) {
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(sock, &wfds);
        struct timeval tv = {
            .tv_sec = timeout_ms / 1000,
            .tv_usec = (timeout_ms % 1000) * 1000,
        };
        if (select(sock + 1, NULL, &wfds, NULL, &tv) > 0) {
            int so_err = 0;
            socklen_t len = sizeof(so_err);
            if (getsockopt(sock, SOL_SOCKET, SO_ERROR, &so_err, &len) == 0) {
                // Connected or actively refused (RST) both prove host TCP/IP stack is up
                if (so_err == 0 || so_err == ECONNREFUSED) {
                    alive = true;
                }
            }
        }
    } else if (errno == ECONNREFUSED) {
        alive = true;
    }

    close(sock);
    return alive;
}

typedef struct {
    ip4_addr_t ip;
    uint8_t target_mac[6];
    bool do_request;
    bool matched;
    SemaphoreHandle_t done;
} arp_probe_ctx_t;

static void arp_tcpip_cb(void *arg)
{
    arp_probe_ctx_t *ctx = (arp_probe_ctx_t *)arg;
    struct netif *nf = netif_default;
    if (nf && netif_is_up(nf) && netif_is_link_up(nf)) {
        if (ctx->do_request) {
            etharp_request(nf, &ctx->ip);
        } else {
            struct eth_addr *eth_ret = NULL;
            const ip4_addr_t *ip_ret = NULL;
            if (etharp_find_addr(nf, &ctx->ip, &eth_ret, &ip_ret) >= 0 && eth_ret != NULL) {
                if (memcmp(eth_ret->addr, ctx->target_mac, 6) == 0) {
                    ctx->matched = true;
                }
            }
        }
    }
    xSemaphoreGive(ctx->done);
}

static bool probe_arp_mac(const char *ip_str, const uint8_t target_mac[6])
{
    ip4_addr_t ip4;
    if (!ip4addr_aton(ip_str, &ip4)) return false;

    SemaphoreHandle_t sem = xSemaphoreCreateBinary();
    if (!sem) return false;

    arp_probe_ctx_t ctx = {
        .ip = ip4,
        .do_request = true,
        .matched = false,
        .done = sem,
    };
    memcpy(ctx.target_mac, target_mac, 6);

    if (tcpip_callback(arp_tcpip_cb, &ctx) == ERR_OK) {
        xSemaphoreTake(sem, pdMS_TO_TICKS(500));
    }

    vTaskDelay(pdMS_TO_TICKS(350));

    ctx.do_request = false;
    ctx.matched = false;
    if (tcpip_callback(arp_tcpip_cb, &ctx) == ERR_OK) {
        xSemaphoreTake(sem, pdMS_TO_TICKS(500));
    }

    vSemaphoreDelete(sem);
    return ctx.matched;
}

static bool probe_online_internal(const cfg_wol_t *cfg)
{
    wifi_status_info_t ws;
    wifi_mgr_get_status(&ws);
    if (!ws.sta_connected || cfg->ip[0] == '\0') {
        return false;
    }

    if (probe_tcp_port(cfg->ip, 445, 450)) return true;
    if (probe_tcp_port(cfg->ip, 135, 450)) return true;

    uint8_t mac[6];
    if (wol_mgr_parse_mac(cfg->mac, mac)) {
        if (probe_arp_mac(cfg->ip, mac)) return true;
    }
    return false;
}

static esp_err_t send_magic_burst(const cfg_wol_t *cfg, int *out_sent)
{
    uint8_t mac[6];
    if (!wol_mgr_parse_mac(cfg->mac, mac)) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t pkt[102];
    memset(pkt, 0xFF, 6);
    for (int i = 0; i < 16; i++) {
        memcpy(pkt + 6 + i * 6, mac, 6);
    }

    // Determine target IPv4 addresses: subnet broadcast + 255.255.255.255 + unicast IP
    uint32_t targets[3];
    int target_cnt = 0;

    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip_info = {0};
    if (sta && esp_netif_get_ip_info(sta, &ip_info) == ESP_OK && ip_info.ip.addr != 0) {
        uint32_t bcast = (ip_info.ip.addr & ip_info.netmask.addr) | (~ip_info.netmask.addr);
        targets[target_cnt++] = bcast;
    }
    targets[target_cnt++] = htonl(INADDR_BROADCAST);

    struct in_addr unicast;
    if (cfg->ip[0] != '\0' && inet_pton(AF_INET, cfg->ip, &unicast) == 1) {
        targets[target_cnt++] = unicast.s_addr;
    }

    static const uint16_t ports[2] = { 9, 7 };
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "UDP socket failed: errno=%d", errno);
        return ESP_FAIL;
    }

    int bcast_en = 1;
    setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &bcast_en, sizeof(bcast_en));

    int sent = 0;
    for (int r = 0; r < WOL_ROUNDS; r++) {
        for (int t = 0; t < target_cnt; t++) {
            for (int p = 0; p < 2; p++) {
                struct sockaddr_in dst = {0};
                dst.sin_family = AF_INET;
                dst.sin_port = htons(ports[p]);
                dst.sin_addr.s_addr = targets[t];
                if (sendto(sock, pkt, sizeof(pkt), 0, (struct sockaddr *)&dst, sizeof(dst)) == sizeof(pkt)) {
                    sent++;
                }
            }
        }
        if (r + 1 < WOL_ROUNDS) {
            vTaskDelay(pdMS_TO_TICKS(WOL_ROUND_GAP_MS));
        }
    }

    close(sock);
    if (out_sent) *out_sent = sent;
    ESP_LOGI(TAG, "Sent %d WOL magic packets to %s (%s)", sent, cfg->mac, cfg->ip);
    return sent > 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t wol_mgr_wake(const char *source, int *out_sent)
{
    cfg_wol_t cfg;
    cfg_wol_get(&cfg);

    int sent = 0;
    esp_err_t err = send_magic_burst(&cfg, &sent);
    if (out_sent) *out_sent = sent;
    if (err != ESP_OK) return err;

    const char *src = (source && source[0]) ? source : "手动触发";
    int64_t now_us = esp_timer_get_time();

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_last_wake_uptime_s = now_uptime_s();
    s_last_wake_time_synced = wifi_mgr_is_time_synced();
    s_last_wake_epoch = s_last_wake_time_synced ? (int64_t)time(NULL) : 0;
    strlcpy(s_last_wake_source, src, sizeof(s_last_wake_source));
    s_last_sent_packets = sent;

    if (!s_online) {
        s_waking = true;
        s_watch_start_us = now_us;
        s_watch_until_us = now_us + (int64_t)WOL_WATCH_DURATION_S * 1000000LL;
    }

    char title[48];
    char detail[128];
    snprintf(title, sizeof(title), "%s · 发送魔术包", src);
    snprintf(detail, sizeof(detail), "向 %s (%s) 发出 %d 个 UDP 魔术包", cfg.ip, cfg.mac, sent);
    log_event_locked(title, detail, "red");
    xSemaphoreGive(s_mutex);

    wol_mgr_broadcast_state();
    if (s_task) xTaskNotifyGive(s_task);
    return ESP_OK;
}

bool wol_mgr_probe_now(void)
{
    cfg_wol_t cfg;
    cfg_wol_get(&cfg);
    bool online = probe_online_internal(&cfg);

    bool changed = false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_online != online) {
        s_online = online;
        changed = true;
    }
    if (online && s_waking) {
        s_waking = false;
        s_watch_until_us = 0;
        changed = true;
        char detail[128];
        snprintf(detail, sizeof(detail), "%s 探测在线（TCP/ARP 匹配 %s）", cfg.ip, cfg.mac);
        log_event_locked("状态探测 · 主机已开机", detail, "dark");
    }
    xSemaphoreGive(s_mutex);

    if (changed) wol_mgr_broadcast_state();
    return online;
}

bool wol_mgr_is_online(void)
{
    if (!s_mutex) return false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    bool on = s_online;
    xSemaphoreGive(s_mutex);
    return on;
}

void wol_mgr_on_presence_change(int prev_home, int cur_home)
{
    if (prev_home == 0 && cur_home > 0) {
        s_auto_wake_pending = true;
        if (s_task) xTaskNotifyGive(s_task);
    }
}

cJSON *wol_mgr_build_state_json(void)
{
    cfg_wol_t wcfg;
    cfg_mqtt_t mcfg;
    cfg_siri_t scfg;
    cfg_wol_get(&wcfg);
    cfg_mqtt_get(&mcfg);
    cfg_siri_get(&scfg);

    mqtt_bridge_status_t mst;
    mqtt_bridge_get_status(&mst);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "type", "wol_state");

    cJSON *host = cJSON_CreateObject();
    cJSON_AddStringToObject(host, "name", wcfg.name);
    cJSON_AddStringToObject(host, "ip", wcfg.ip);
    cJSON_AddStringToObject(host, "mac", wcfg.mac);
    cJSON_AddBoolToObject(host, "auto_wake_on_arrive", wcfg.auto_wake_on_arrive);
    cJSON_AddNumberToObject(host, "auto_cooldown_s", wcfg.auto_cooldown_s);
    cJSON_AddItemToObject(root, "host", host);

    xSemaphoreTake(s_mutex, portMAX_DELAY);
    cJSON_AddBoolToObject(root, "online", s_online);
    cJSON_AddBoolToObject(root, "waking", s_waking);

    int prog = s_online ? 100 : 0;
    if (s_waking && s_watch_until_us > s_watch_start_us) {
        int64_t now_us = esp_timer_get_time();
        int64_t elapsed = now_us - s_watch_start_us;
        int64_t total = s_watch_until_us - s_watch_start_us;
        prog = (int)((elapsed * 100) / total);
        if (prog < 5) prog = 5;
        if (prog > 98) prog = 98;
    }
    cJSON_AddNumberToObject(root, "wake_progress", prog);

    cJSON *lw = cJSON_CreateObject();
    cJSON_AddNumberToObject(lw, "epoch", (double)s_last_wake_epoch);
    cJSON_AddNumberToObject(lw, "uptime_s", s_last_wake_uptime_s);
    cJSON_AddBoolToObject(lw, "time_synced", s_last_wake_time_synced);
    cJSON_AddStringToObject(lw, "source", s_last_wake_source);
    cJSON_AddNumberToObject(lw, "sent", s_last_sent_packets);
    cJSON_AddItemToObject(root, "last_wake", lw);

    cJSON *logs = cJSON_CreateArray();
    for (size_t i = 0; i < s_log_count; i++) {
        size_t idx = (s_log_head + WOL_LOG_MAX - 1 - i) % WOL_LOG_MAX;
        const wol_log_entry_t *e = &s_logs[idx];
        cJSON *le = cJSON_CreateObject();
        cJSON_AddNumberToObject(le, "seq", e->seq);
        cJSON_AddNumberToObject(le, "epoch", (double)e->epoch);
        cJSON_AddNumberToObject(le, "uptime_s", e->uptime_s);
        cJSON_AddBoolToObject(le, "time_synced", e->time_synced);
        cJSON_AddStringToObject(le, "title", e->title);
        cJSON_AddStringToObject(le, "detail", e->detail);
        cJSON_AddStringToObject(le, "level", e->level);
        cJSON_AddItemToArray(logs, le);
    }
    xSemaphoreGive(s_mutex);
    cJSON_AddItemToObject(root, "logs", logs);

    cJSON *mqtt = cJSON_CreateObject();
    cJSON_AddBoolToObject(mqtt, "enabled", mcfg.enabled);
    cJSON_AddBoolToObject(mqtt, "connected", mst.connected);
    cJSON_AddStringToObject(mqtt, "host", mcfg.host);
    cJSON_AddNumberToObject(mqtt, "port", mcfg.port);
    cJSON_AddStringToObject(mqtt, "client_id", mcfg.client_id);
    cJSON_AddStringToObject(mqtt, "username", mcfg.username);
    cJSON_AddBoolToObject(mqtt, "has_password", mcfg.password[0] != '\0');
    cJSON_AddStringToObject(mqtt, "wol_topic", mcfg.wol_topic);
    cJSON_AddStringToObject(mqtt, "lamp_topic", mcfg.lamp_topic);
    cJSON_AddStringToObject(mqtt, "last_error", mst.last_error);
    cJSON_AddItemToObject(root, "mqtt", mqtt);

    cJSON *siri = cJSON_CreateObject();
    cJSON_AddBoolToObject(siri, "enabled", scfg.enabled);
    cJSON_AddStringToObject(siri, "token", scfg.token);
    cJSON_AddItemToObject(root, "siri", siri);

    return root;
}

void wol_mgr_broadcast_state(void)
{
    if (!s_ws_cb) return;
    cJSON *o = wol_mgr_build_state_json();
    if (!o) return;
    char *str = cJSON_PrintUnformatted(o);
    cJSON_Delete(o);
    if (str) {
        s_ws_cb(str);
        cJSON_free(str);
    }
}

static void handle_auto_wake_if_pending(void)
{
    if (!s_auto_wake_pending) return;
    s_auto_wake_pending = false;

    cfg_wol_t cfg;
    cfg_wol_get(&cfg);
    if (!cfg.auto_wake_on_arrive) return;

    int64_t now_us = esp_timer_get_time();
    int64_t cooldown_us = (int64_t)cfg.auto_cooldown_s * 1000000LL;
    if (s_last_auto_attempt_us > 0 && (now_us - s_last_auto_attempt_us) < cooldown_us) {
        ESP_LOGI(TAG, "Auto-wake skipped (cooldown active)");
        return;
    }
    s_last_auto_attempt_us = now_us;

    // Guard: always run a fresh online probe first — skip if PC is already ON!
    bool already_on = probe_online_internal(&cfg);
    if (already_on) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        s_online = true;
        char detail[128];
        snprintf(detail, sizeof(detail), "检测到成员回家，但 %s 已在线，守卫跳过发包", cfg.ip);
        log_event_locked("蓝牙到家 · 守卫跳过开机", detail, "gray");
        xSemaphoreGive(s_mutex);
        wol_mgr_broadcast_state();
        ESP_LOGI(TAG, "Auto-wake skipped: host %s is already online", cfg.ip);
        return;
    }

    ESP_LOGI(TAG, "Auto-wake triggered by BLE arrive (host offline)");
    wol_mgr_wake("蓝牙到家自动", NULL);
}

static void wol_monitor_task(void *arg)
{
    // Wait briefly for Wi-Fi to settle after boot
    vTaskDelay(pdMS_TO_TICKS(3000));

    while (1) {
        handle_auto_wake_if_pending();

        bool watching = false;
        int64_t now_us = esp_timer_get_time();
        xSemaphoreTake(s_mutex, portMAX_DELAY);
        if (s_waking) {
            if (now_us >= s_watch_until_us) {
                s_waking = false;
                s_watch_until_us = 0;
                log_event_locked("唤醒轮询超时", "90 秒内未探测到上线，请检查 BIOS/网卡供电", "gray");
                xSemaphoreGive(s_mutex);
                wol_mgr_broadcast_state();
            } else {
                watching = true;
                xSemaphoreGive(s_mutex);
            }
        } else {
            xSemaphoreGive(s_mutex);
        }

        wifi_status_info_t ws;
        wifi_mgr_get_status(&ws);
        if (ws.sta_connected) {
            bool prev_on = wol_mgr_is_online();
            bool cur_on = wol_mgr_probe_now();
            if (watching || prev_on != cur_on) {
                wol_mgr_broadcast_state();
            }
        }

        uint32_t wait_ms = watching ? (WOL_WATCH_POLL_S * 1000) : (WOL_IDLE_POLL_S * 1000);
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms));
    }
}

esp_err_t wol_mgr_init(void)
{
    if (!s_mutex) {
        s_mutex = xSemaphoreCreateMutex();
        if (!s_mutex) return ESP_ERR_NO_MEM;
    }
    xTaskCreate(wol_monitor_task, "wol_mgr", 4096, NULL, 3, &s_task);
    ESP_LOGI(TAG, "WOL manager initialized");
    return ESP_OK;
}
