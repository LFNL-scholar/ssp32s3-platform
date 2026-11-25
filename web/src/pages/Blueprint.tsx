import { useEffect, useState } from 'preact/hooks';
import { api, SystemInfo, TelemetryMsg, wsClient } from '../api/client';

function fmtBytes(b: number) {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / 1024).toFixed(1)} KB`;
}

export function Blueprint() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [tel, setTel] = useState<TelemetryMsg | null>(null);

  useEffect(() => {
    api.systemInfo().then(setInfo).catch(() => {});
    api.systemStatus().then(setTel).catch(() => {});
    return wsClient.subscribe((m) => {
      if (m.type === 'telemetry') setTel(m);
    });
  }, []);

  const cpuMhz = info?.cpu_mhz ?? 240;
  const idfVer = info?.idf_version ?? 'v5.5.4';
  const sramFree = tel ? fmtBytes(tel.sram.free) : '--';
  const psramFree = tel ? fmtBytes(tel.psram.free) : '--';

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">HARDWARE BLUEPRINT · ESP32-S3-N16R8 + CC1101</div>
          <h1 class="view-title">硬件蓝图与系统架构</h1>
        </div>
        <div class="btn-row">
          <span class="tag dark">ESP32-S3-DevKitC-1</span>
          <span class="tag red">8 引脚已接入</span>
        </div>
      </div>

      <div class="grid g-topo">
        {/* Left 50%: 1:1 ESP32-S3-DevKitC-1 (N16R8) Pinout CAD */}
        <div class="card" style={{ minHeight: 0 }}>
          <div class="card-head">
            <span class="card-title">01 / ESP32-S3-DevKitC-1 (N16R8) · 1:1 引脚蓝图</span>
            <div class="btn-row">
              <span class="tag">44-PIN</span>
              <span class="tag red">实装接线高亮</span>
            </div>
          </div>

          <div class="topo-map-wrap">
            <svg class="topo-map-svg" viewBox="0 0 600 540" preserveAspectRatio="xMidYMid meet">
              <defs>
                <pattern id="bp-cad-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--line)" stroke-width="0.55" opacity="0.5" />
                </pattern>
                <pattern id="bp-shield-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-dim)" stroke-width="0.7" opacity="0.16" />
                </pattern>
              </defs>

              <rect width="600" height="540" fill="url(#bp-cad-grid)" />

              {/* PCB Outline */}
              <rect x="202" y="34" width="196" height="466" rx="6" fill="var(--surface)" stroke="var(--text)" stroke-width="2" />
              <circle cx="214" cy="46" r="4" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />
              <circle cx="386" cy="46" r="4" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />
              <circle cx="214" cy="488" r="4" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />
              <circle cx="386" cy="488" r="4" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />

              {/* 2.4GHz Meander Antenna */}
              <rect x="234" y="34" width="132" height="38" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1" />
              <path
                d="M 248,64 L 248,46 L 260,46 L 260,60 L 272,60 L 272,46 L 284,46 L 284,60 L 296,60 L 296,46 L 308,46 L 308,60 L 320,60 L 320,46 L 332,46 L 332,60 L 344,60 L 344,46 L 352,46"
                fill="none"
                stroke="var(--text-sec)"
                stroke-width="1.5"
                stroke-linecap="square"
              />
              <text x="300" y="24" fill="var(--text-dim)" font-size="9" font-family="var(--mono)" text-anchor="middle" letter-spacing="0.12em">
                2.4GHz WI-FI / BLE 5.0 ANTENNA
              </text>

              {/* RF Shield Can */}
              <rect x="228" y="72" width="144" height="156" rx="2" fill="url(#bp-shield-hatch)" stroke="var(--text)" stroke-width="1.6" />
              <rect x="234" y="78" width="132" height="144" rx="1" fill="none" stroke="var(--line-strong)" stroke-width="0.8" stroke-dasharray="3 2" />
              <text x="300" y="122" fill="var(--text)" font-size="11.5" font-weight="700" font-family="var(--mono)" text-anchor="middle">ESP32-S3</text>
              <text x="300" y="138" fill="var(--text-sec)" font-size="9.5" font-family="var(--mono)" text-anchor="middle">WROOM-1 · N16R8</text>
              <line x1="256" y1="150" x2="344" y2="150" stroke="var(--line-strong)" stroke-width="0.9" />
              <text x="300" y="166" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">{cpuMhz} MHz DUAL-CORE</text>
              <text x="300" y="180" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">16MB QIO FLASH</text>
              <text x="300" y="194" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">8MB OCTAL PSRAM</text>

              {/* Onboard WS2812B */}
              <g transform="translate(300, 272)">
                <rect x="-12" y="-12" width="24" height="24" rx="2" fill="var(--surface-sub)" stroke="var(--red)" stroke-width="1.3" />
                <circle class="topo-beacon-ring" cx="0" cy="0" r="8" fill="none" stroke="var(--red)" stroke-width="1.2" />
                <circle cx="0" cy="0" r="4" fill="var(--red)" />
                <text x="0" y="24" fill="var(--red)" font-size="8.5" font-weight="700" font-family="var(--mono)" text-anchor="middle">WS2812B · IO48</text>
              </g>

              {/* LDO & UART ICs */}
              <rect x="242" y="324" width="38" height="26" rx="1.5" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
              <text x="261" y="340" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">3.3V</text>
              <rect x="320" y="324" width="38" height="26" rx="1.5" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
              <text x="339" y="340" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">UART</text>

              {/* RST & BOOT Switches */}
              <g transform="translate(262, 412)">
                <rect x="-15" y="-10" width="30" height="20" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />
                <circle cx="0" cy="0" r="4.5" fill="var(--text-dim)" />
                <text x="0" y="21" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">RST</text>
              </g>
              <g transform="translate(338, 412)">
                <rect x="-15" y="-10" width="30" height="20" rx="2" fill="var(--surface-sub)" stroke="var(--red)" stroke-width="1.3" />
                <circle cx="0" cy="0" r="4.5" fill="var(--red)" />
                <text x="0" y="21" fill="var(--red)" font-size="8" font-weight="700" font-family="var(--mono)" text-anchor="middle">BOOT · IO0</text>
              </g>

              {/* Dual USB-C */}
              <g>
                <rect x="240" y="476" width="44" height="28" rx="3" fill="var(--surface-sub)" stroke="var(--text)" stroke-width="1.4" />
                <text x="262" y="493" fill="var(--text)" font-size="8" font-weight="700" font-family="var(--mono)" text-anchor="middle">USB/JTAG</text>
                <rect x="316" y="476" width="44" height="28" rx="3" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.2" />
                <text x="338" y="493" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">UART</text>
              </g>

              {/* LEFT 22-PIN HEADER (J1) */}
              <g font-family="var(--mono)" font-size="8.5">
                <circle cx="212" cy="76" r="3" fill="var(--text-sec)" /><text x="196" y="79" text-anchor="end" fill="var(--text-sec)">3V3</text>
                <circle cx="212" cy="94" r="3" fill="var(--text-sec)" /><text x="196" y="97" text-anchor="end" fill="var(--text-sec)">3V3</text>
                <circle cx="212" cy="112" r="3" fill="var(--line-strong)" /><text x="196" y="115" text-anchor="end" fill="var(--text-dim)">RST</text>

                <line x1="128" y1="130" x2="208" y2="130" stroke="var(--red)" stroke-width="1.2" />
                <circle cx="212" cy="130" r="3.6" fill="var(--red)" />
                <rect x="34" y="121" width="96" height="17" rx="2" fill="var(--red)" />
                <text x="82" y="132.5" text-anchor="middle" fill="#ffffff" font-weight="700">IO4 · RF_GDO0</text>

                <line x1="128" y1="148" x2="208" y2="148" stroke="var(--red)" stroke-width="1.2" />
                <circle cx="212" cy="148" r="3.6" fill="var(--red)" />
                <rect x="34" y="139" width="96" height="17" rx="2" fill="var(--red)" />
                <text x="82" y="150.5" text-anchor="middle" fill="#ffffff" font-weight="700">IO5 · RF_GDO2</text>

                {[
                  [166, 'IO6'], [184, 'IO7'], [202, 'IO15'], [220, 'IO16'], [238, 'IO17'],
                  [256, 'IO18'], [274, 'IO8'], [292, 'IO3'], [310, 'IO46'], [328, 'IO9'],
                ].map(([y, lbl]) => (
                  <g key={lbl as string}>
                    <circle cx="212" cy={y as number} r="2.8" fill="var(--line-strong)" />
                    <text x="196" y={(y as number) + 3} text-anchor="end" fill="var(--text-dim)">{lbl}</text>
                  </g>
                ))}

                {[
                  [346, 'IO10 · RF_CS'],
                  [364, 'IO11 · RF_MOSI'],
                  [382, 'IO12 · RF_SCK'],
                  [400, 'IO13 · RF_MISO'],
                ].map(([y, lbl]) => (
                  <g key={lbl as string}>
                    <line x1="128" y1={y as number} x2="208" y2={y as number} stroke="var(--red)" stroke-width="1.2" />
                    <circle cx="212" cy={y as number} r="3.6" fill="var(--red)" />
                    <rect x="34" y={(y as number) - 9} width="96" height="17" rx="2" fill="var(--red)" />
                    <text x="82" y={(y as number) + 2.5} text-anchor="middle" fill="#ffffff" font-weight="700">{lbl}</text>
                  </g>
                ))}

                <circle cx="212" cy="418" r="2.8" fill="var(--line-strong)" /><text x="196" y="421" text-anchor="end" fill="var(--text-dim)">IO14</text>
                <circle cx="212" cy="436" r="3" fill="var(--text-sec)" /><text x="196" y="439" text-anchor="end" fill="var(--text-sec)">5V</text>
                <circle cx="212" cy="454" r="3" fill="var(--text-sec)" /><text x="196" y="457" text-anchor="end" fill="var(--text-sec)">GND</text>
              </g>

              {/* RIGHT 22-PIN HEADER (J3) */}
              <g font-family="var(--mono)" font-size="8.5">
                <circle cx="388" cy="76" r="3" fill="var(--text-sec)" /><text x="404" y="79" fill="var(--text-sec)">GND</text>
                {[
                  [94, 'TX · IO43'], [112, 'RX · IO44'], [130, 'IO1'], [148, 'IO2'],
                  [166, 'IO42'], [184, 'IO41'], [202, 'IO40'], [220, 'IO39'], [238, 'IO38'],
                ].map(([y, lbl]) => (
                  <g key={lbl as string}>
                    <circle cx="388" cy={y as number} r="2.8" fill="var(--line-strong)" />
                    <text x="404" y={(y as number) + 3} fill="var(--text-dim)">{lbl}</text>
                  </g>
                ))}

                {/* OPI PSRAM Reserved */}
                <circle cx="388" cy="256" r="3" fill="var(--text-dim)" /><text x="404" y="259" fill="var(--text-dim)">IO37</text>
                <circle cx="388" cy="274" r="3" fill="var(--text-dim)" /><text x="404" y="277" fill="var(--text-dim)">IO36</text>
                <circle cx="388" cy="292" r="3" fill="var(--text-dim)" /><text x="404" y="295" fill="var(--text-dim)">IO35</text>
                <path d="M 434,252 L 442,252 L 442,296 L 434,296" fill="none" stroke="var(--text-dim)" stroke-width="1" />
                <rect x="448" y="264" width="114" height="20" rx="2" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="3 2" />
                <text x="505" y="277" text-anchor="middle" fill="var(--text-dim)" font-size="8.5">OPI PSRAM 禁用</text>

                {/* GPIO0 BOOT */}
                <line x1="392" y1="310" x2="466" y2="310" stroke="var(--red)" stroke-width="1.2" />
                <circle cx="388" cy="310" r="3.6" fill="var(--red)" />
                <rect x="466" y="301" width="96" height="17" rx="2" fill="var(--red)" />
                <text x="514" y="312.5" text-anchor="middle" fill="#ffffff" font-weight="700">IO0 · RESET</text>

                <circle cx="388" cy="328" r="2.8" fill="var(--line-strong)" /><text x="404" y="331" fill="var(--text-dim)">IO45</text>

                {/* GPIO48 RGB */}
                <line x1="392" y1="346" x2="466" y2="346" stroke="var(--red)" stroke-width="1.2" />
                <circle cx="388" cy="346" r="3.6" fill="var(--red)" />
                <rect x="466" y="337" width="96" height="17" rx="2" fill="var(--red)" />
                <text x="514" y="348.5" text-anchor="middle" fill="#ffffff" font-weight="700">IO48 · RGB LED</text>

                <circle cx="388" cy="364" r="2.8" fill="var(--line-strong)" /><text x="404" y="367" fill="var(--text-dim)">IO47</text>
                <circle cx="388" cy="382" r="2.8" fill="var(--line-strong)" /><text x="404" y="385" fill="var(--text-dim)">IO21</text>
                <circle cx="388" cy="400" r="3" fill="var(--text)" /><text x="404" y="403" fill="var(--text)">IO20 · USB D+</text>
                <circle cx="388" cy="418" r="3" fill="var(--text)" /><text x="404" y="421" fill="var(--text)">IO19 · USB D-</text>
                <circle cx="388" cy="436" r="3" fill="var(--text-sec)" /><text x="404" y="439" fill="var(--text-sec)">GND</text>
                <circle cx="388" cy="454" r="3" fill="var(--text-sec)" /><text x="404" y="457" fill="var(--text-sec)">GND</text>
              </g>
            </svg>

            <div class="topo-meta-bar">
              <span>模组：<strong style={{ color: 'var(--text)' }}>ESP32-S3-WROOM-1-N16R8</strong></span>
              <span class="num">实装引脚：<strong class="red">8 / 45 GPIO</strong></span>
              <span class="num">PSRAM 保留：35 / 36 / 37</span>
            </div>
          </div>
        </div>

        {/* Right 50%: CC1101 Wiring Schematic + System Dataflow */}
        <div class="topo-right">
          {/* 02 / CC1101 Schematic */}
          <div class="card" style={{ minHeight: 0 }}>
            <div class="card-head">
              <span class="card-title">02 / CC1101 Sub-GHz 射频接线原理图</span>
              <div class="btn-row">
                <span class="tag">SPI2 + RMT</span>
                <span class="tag red">433.92 MHz</span>
              </div>
            </div>

            <div class="topo-map-wrap">
              <svg class="topo-map-svg" viewBox="0 0 600 260" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <pattern id="bp-rf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--line)" stroke-width="0.55" opacity="0.5" />
                  </pattern>
                </defs>
                <rect width="600" height="260" fill="url(#bp-rf-grid)" />

                <rect x="28" y="30" width="150" height="200" rx="3" fill="var(--surface)" stroke="var(--text)" stroke-width="1.6" />
                <rect x="28" y="30" width="150" height="26" rx="2" fill="var(--black)" />
                <text x="103" y="47" fill="var(--inv-text)" font-size="10" font-weight="700" font-family="var(--mono)" text-anchor="middle">ESP32-S3 HOST</text>

                <rect x="332" y="30" width="156" height="200" rx="3" fill="var(--surface)" stroke="var(--text)" stroke-width="1.6" />
                <rect x="332" y="30" width="156" height="26" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1" />
                <text x="410" y="47" fill="var(--text)" font-size="10" font-weight="700" font-family="var(--mono)" text-anchor="middle">TI CC1101 RF</text>
                <rect x="418" y="92" width="52" height="52" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                <text x="444" y="116" fill="var(--text)" font-size="9" font-weight="700" font-family="var(--mono)" text-anchor="middle">CC1101</text>
                <text x="444" y="130" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">26 MHz</text>

                <g font-family="var(--mono)" font-size="9">
                  <line x1="178" y1="74" x2="332" y2="74" stroke="var(--text)" stroke-width="1.3" />
                  <line class="bp-bus-flow" x1="178" y1="74" x2="332" y2="74" stroke="var(--red)" stroke-width="1.4" />
                  <text x="168" y="77" text-anchor="end" fill="var(--text)">GPIO 12</text>
                  <text x="255" y="70" text-anchor="middle" fill="var(--text-sec)" font-size="8.5">SPI_SCK</text>
                  <text x="342" y="77" fill="var(--text)">SCLK</text>

                  <line x1="178" y1="98" x2="332" y2="98" stroke="var(--text)" stroke-width="1.3" />
                  <line class="bp-bus-flow" x1="178" y1="98" x2="332" y2="98" stroke="var(--red)" stroke-width="1.4" />
                  <text x="168" y="101" text-anchor="end" fill="var(--text)">GPIO 11</text>
                  <text x="255" y="94" text-anchor="middle" fill="var(--text-sec)" font-size="8.5">SPI_MOSI</text>
                  <text x="342" y="101" fill="var(--text)">SI</text>

                  <line x1="178" y1="122" x2="332" y2="122" stroke="var(--line-strong)" stroke-width="1.3" />
                  <text x="168" y="125" text-anchor="end" fill="var(--text)">GPIO 13</text>
                  <text x="255" y="118" text-anchor="middle" fill="var(--text-sec)" font-size="8.5">SPI_MISO</text>
                  <text x="342" y="125" fill="var(--text)">SO</text>

                  <line x1="178" y1="146" x2="332" y2="146" stroke="var(--line-strong)" stroke-width="1.3" />
                  <text x="168" y="149" text-anchor="end" fill="var(--text)">GPIO 10</text>
                  <text x="255" y="142" text-anchor="middle" fill="var(--text-sec)" font-size="8.5">SPI_CSN</text>
                  <text x="342" y="149" fill="var(--text)">CSN</text>

                  <line x1="178" y1="172" x2="332" y2="172" stroke="var(--red)" stroke-width="1.6" />
                  <line class="bp-bus-flow" x1="178" y1="172" x2="332" y2="172" stroke="#ffffff" stroke-width="1.2" opacity="0.65" />
                  <text x="168" y="175" text-anchor="end" fill="var(--red)" font-weight="700">GPIO 4</text>
                  <text x="255" y="168" text-anchor="middle" fill="var(--red)" font-weight="700" font-size="8.5">OOK / RMT TX</text>
                  <text x="342" y="175" fill="var(--red)" font-weight="700">GDO0</text>

                  <line x1="178" y1="196" x2="332" y2="196" stroke="var(--red)" stroke-width="1.3" stroke-dasharray="4 3" />
                  <text x="168" y="199" text-anchor="end" fill="var(--red)" font-weight="700">GPIO 5</text>
                  <text x="255" y="192" text-anchor="middle" fill="var(--red)" font-size="8.5">RMT RX CAPTURE</text>
                  <text x="342" y="199" fill="var(--red)" font-weight="700">GDO2</text>

                  <line x1="178" y1="218" x2="332" y2="218" stroke="var(--text-dim)" stroke-width="1.1" />
                  <text x="168" y="221" text-anchor="end" fill="var(--text-dim)">3V3 / GND</text>
                  <text x="255" y="214" text-anchor="middle" fill="var(--text-dim)" font-size="8">POWER RAIL</text>
                  <text x="342" y="221" fill="var(--text-dim)">VCC / GND</text>
                </g>

                <g transform="translate(488, 118)">
                  <line x1="0" y1="0" x2="26" y2="0" stroke="var(--text)" stroke-width="1.6" />
                  <path d="M 26,0 L 32,-10 L 38,10 L 44,-10 L 50,10 L 56,0" fill="none" stroke="var(--text)" stroke-width="1.6" stroke-linejoin="round" />
                  <path d="M 66,-14 A 18,18 0 0 1 66,14" fill="none" stroke="var(--red)" stroke-width="1.4" />
                  <path d="M 74,-22 A 28,28 0 0 1 74,22" fill="none" stroke="var(--red)" stroke-width="1.2" opacity="0.65" />
                  <path d="M 82,-30 A 38,38 0 0 1 82,30" fill="none" stroke="var(--red)" stroke-width="1" opacity="0.35" />
                  <text x="42" y="34" fill="var(--red)" font-size="9" font-weight="700" font-family="var(--mono)" text-anchor="middle">433.92 MHz</text>
                  <text x="42" y="46" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">OOK / ASK</text>
                </g>
              </svg>

              <div class="topo-meta-bar">
                <span>中心频率：<strong class="red">433.92 MHz</strong></span>
                <span class="num">带宽：325 kHz · 4.8 kBaud</span>
                <span class="num">波形缓冲：PSRAM + DMA</span>
              </div>
            </div>
          </div>

          {/* 03 / Dual-Core Architecture */}
          <div class="card" style={{ minHeight: 0 }}>
            <div class="card-head">
              <span class="card-title">03 / 双核 {cpuMhz}MHz 系统架构与数据流</span>
              <div class="btn-row">
                <span class="tag">ESP-IDF {idfVer}</span>
                <span class="tag dark">-Os · PSRAM</span>
              </div>
            </div>

            <div class="topo-map-wrap">
              <svg class="topo-map-svg" viewBox="0 0 600 260" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <pattern id="bp-arch-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--line)" stroke-width="0.55" opacity="0.5" />
                  </pattern>
                </defs>
                <rect width="600" height="260" fill="url(#bp-arch-grid)" />

                <g font-family="var(--font)">
                  <rect x="20" y="34" width="124" height="58" rx="3" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <text x="82" y="57" fill="var(--text)" font-size="10.5" font-weight="700" text-anchor="middle">BLE 5.0 终端</text>
                  <text x="82" y="75" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">IRK + RPA 解析</text>

                  <rect x="20" y="114" width="124" height="58" rx="3" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <text x="82" y="137" fill="var(--text)" font-size="10.5" font-weight="700" text-anchor="middle">Web / Siri 入口</text>
                  <text x="82" y="155" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">REST + WS 1.0Hz</text>
                </g>

                <line class="bp-bus-flow" x1="144" y1="63" x2="196" y2="63" stroke="var(--red)" stroke-width="1.4" />
                <line class="bp-bus-flow" x1="144" y1="143" x2="196" y2="143" stroke="var(--text)" stroke-width="1.3" />

                <g>
                  <rect x="196" y="20" width="212" height="220" rx="4" fill="var(--surface)" stroke="var(--text)" stroke-width="1.8" />
                  <rect x="196" y="20" width="212" height="24" rx="2" fill="var(--black)" />
                  <text x="302" y="36" fill="var(--inv-text)" font-size="9.5" font-weight="700" font-family="var(--mono)" text-anchor="middle">
                    ESP32-S3 · 2 × {cpuMhz} MHz
                  </text>

                  <rect x="208" y="54" width="188" height="46" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <text x="218" y="72" fill="var(--red)" font-size="9" font-weight="700" font-family="var(--mono)">CORE 0 · WIRELESS</text>
                  <text x="218" y="88" fill="var(--text-sec)" font-size="9">Wi-Fi STA · NimBLE · HTTPD</text>

                  <rect x="208" y="110" width="188" height="46" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <text x="218" y="128" fill="var(--text)" font-size="9" font-weight="700" font-family="var(--mono)">CORE 1 · ENGINE</text>
                  <text x="218" y="144" fill="var(--text-sec)" font-size="9">在家迟滞状态机 · RMT 射频</text>

                  <rect x="208" y="168" width="90" height="58" rx="2" fill="var(--surface-sub)" stroke="var(--red)" stroke-width="1.1" stroke-dasharray="3 2" />
                  <text x="253" y="191" fill="var(--text)" font-size="9" font-weight="700" font-family="var(--mono)" text-anchor="middle">8MB PSRAM</text>
                  <text x="253" y="207" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">OPI 80MHz</text>

                  <rect x="306" y="168" width="90" height="58" rx="2" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <text x="351" y="191" fill="var(--text)" font-size="9" font-weight="700" font-family="var(--mono)" text-anchor="middle">16MB FLASH</text>
                  <text x="351" y="207" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">OTA + LittleFS</text>
                </g>

                <line class="bp-bus-flow" x1="408" y1="63" x2="458" y2="63" stroke="var(--red)" stroke-width="1.4" />
                <line class="bp-bus-flow" x1="408" y1="133" x2="458" y2="133" stroke="var(--text)" stroke-width="1.3" />
                <line class="bp-bus-flow" x1="408" y1="197" x2="458" y2="197" stroke="var(--line-strong)" stroke-width="1.3" />

                <g font-family="var(--font)">
                  <rect x="458" y="36" width="122" height="54" rx="3" fill="var(--surface)" stroke="var(--red)" stroke-width="1.4" />
                  <text x="519" y="58" fill="var(--red)" font-size="10.5" font-weight="700" text-anchor="middle">吸顶主灯控制</text>
                  <text x="519" y="75" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">CC1101 · 433MHz</text>

                  <rect x="458" y="106" width="122" height="54" rx="3" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <text x="519" y="128" fill="var(--text)" font-size="10.5" font-weight="700" text-anchor="middle">RGB 状态灯效</text>
                  <text x="519" y="145" fill="var(--text-dim)" font-size="8.5" font-family="var(--mono)" text-anchor="middle">WS2812B · IO48</text>

                  <rect x="458" y="176" width="122" height="50" rx="3" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <text x="519" y="198" fill="var(--text)" font-size="10" font-weight="600" text-anchor="middle">实时遥测大屏</text>
                  <text x="519" y="213" fill="var(--text-dim)" font-size="8" font-family="var(--mono)" text-anchor="middle">Preact · OTA</text>
                </g>
              </svg>

              <div class="topo-meta-bar">
                <span>固件：<strong style={{ color: 'var(--text)' }}>ESP-IDF {idfVer} + FreeRTOS</strong></span>
                <span class="num">SRAM 空闲：{sramFree}</span>
                <span class="num">PSRAM 空闲：{psramFree}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
