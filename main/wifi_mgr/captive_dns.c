#include "captive_dns.h"

#include <string.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "esp_log.h"

static const char *TAG = "captive_dns";

static volatile bool s_running = false;
static TaskHandle_t s_task = NULL;
static int s_sock = -1;

// Build DNS answer pointing A-record queries to 192.168.4.1
static int build_dns_response(const uint8_t *req, int req_len, uint8_t *resp, int max_resp)
{
    if (req_len < 12 || req_len + 16 > max_resp) return -1;

    uint16_t qdcount = (uint16_t)((req[4] << 8) | req[5]);
    if (qdcount == 0) return -1;

    // Walk first question QNAME safely
    int idx = 12;
    while (idx < req_len) {
        uint8_t label_len = req[idx];
        if (label_len == 0) {
            idx++;
            break;
        }
        if ((label_len & 0xC0) == 0xC0) {
            // Unexpected pointer in question
            return -1;
        }
        idx += 1 + label_len;
        if (idx >= req_len) return -1;
    }

    // Need 4 bytes for QTYPE + QCLASS
    if (idx + 4 > req_len) return -1;
    uint16_t qtype = (uint16_t)((req[idx] << 8) | req[idx + 1]);
    uint16_t qclass = (uint16_t)((req[idx + 2] << 8) | req[idx + 3]);
    int q_end = idx + 4;

    memcpy(resp, req, q_end);
    // Standard response, AA=1, RD copied, RA=0, RCODE=0
    resp[2] = (uint8_t)(0x84 | (req[2] & 0x01));
    resp[3] = 0x00;
    resp[4] = 0x00;
    resp[5] = 0x01; // QDCOUNT = 1

    // Answer only A (1) or ANY (255) IN queries; return 0 answers for AAAA (28) etc.
    if ((qtype == 1 || qtype == 255) && qclass == 1) {
        resp[6] = 0x00;
        resp[7] = 0x01; // ANCOUNT = 1
        resp[8] = 0; resp[9] = 0;
        resp[10] = 0; resp[11] = 0;

        int off = q_end;
        resp[off++] = 0xC0; resp[off++] = 0x0C; // Name pointer to offset 12
        resp[off++] = 0x00; resp[off++] = 0x01; // Type A
        resp[off++] = 0x00; resp[off++] = 0x01; // Class IN
        resp[off++] = 0x00; resp[off++] = 0x00; resp[off++] = 0x00; resp[off++] = 60; // TTL 60s
        resp[off++] = 0x00; resp[off++] = 0x04; // RDLENGTH 4
        resp[off++] = 192; resp[off++] = 168; resp[off++] = 4; resp[off++] = 1; // 192.168.4.1
        return off;
    }

    resp[6] = 0; resp[7] = 0;
    resp[8] = 0; resp[9] = 0;
    resp[10] = 0; resp[11] = 0;
    return q_end;
}

static void dns_task(void *arg)
{
    uint8_t req[512];
    uint8_t resp[540];

    while (s_running) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        int len = recvfrom(s_sock, req, sizeof(req), 0, (struct sockaddr *)&client_addr, &addr_len);
        if (len > 0) {
            int resp_len = build_dns_response(req, len, resp, sizeof(resp));
            if (resp_len > 0) {
                sendto(s_sock, resp, resp_len, 0, (struct sockaddr *)&client_addr, addr_len);
            }
        }
    }

    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
    s_task = NULL;
    vTaskDelete(NULL);
}

esp_err_t captive_dns_start(void)
{
    if (s_running) return ESP_OK;

    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "Failed to create UDP socket");
        return ESP_FAIL;
    }

    int opt = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct timeval tv = { .tv_sec = 0, .tv_usec = 400000 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = htonl(INADDR_ANY),
        .sin_port = htons(53),
    };
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "Failed to bind port 53");
        close(sock);
        return ESP_FAIL;
    }

    s_sock = sock;
    s_running = true;
    xTaskCreate(dns_task, "captive_dns", 3584, NULL, 4, &s_task);
    ESP_LOGI(TAG, "Captive portal DNS started on :53 -> 192.168.4.1");
    return ESP_OK;
}

void captive_dns_stop(void)
{
    if (!s_running) return;
    s_running = false;
    for (int i = 0; i < 20 && s_task != NULL; i++) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    ESP_LOGI(TAG, "Captive portal DNS stopped");
}
