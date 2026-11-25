import { useEffect, useState } from 'preact/hooks';
import { api, LampState, PersonState, wsClient } from '../api/client';

const PRIVACY_KEY = 'lfnl_topo_privacy';

export function Topology() {
  const [privacy, setPrivacy] = useState<boolean>(() => {
    try { return localStorage.getItem(PRIVACY_KEY) === '1'; } catch { return false; }
  });
  const [lamp, setLamp] = useState<LampState | null>(null);
  const [persons, setPersons] = useState<PersonState[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.lampState().then(setLamp).catch(() => {});
    api.presenceState().then((r) => setPersons(r.persons || [])).catch(() => {});
    return wsClient.subscribe((m) => {
      if (m.type === 'lamp_state') setLamp(m);
      if (m.type === 'presence_tick') setPersons(m.persons || []);
    });
  }, []);

  const togglePrivacy = () => {
    const next = !privacy;
    setPrivacy(next);
    try { localStorage.setItem(PRIVACY_KEY, next ? '1' : '0'); } catch {}
  };

  const toggleLamp = async () => {
    if (busy || !lamp || !lamp.sample_loaded) return;
    setBusy(true);
    try {
      const res = await api.lampAction(lamp.power_on ? 'off' : 'on');
      setLamp(res);
    } catch {}
    setBusy(false);
  };

  const anyHome = persons.some((p) => p.is_home);
  const allDevs = persons.flatMap((p) => p.devices);
  const activeRssi = allDevs
    .filter((d) => d.seen_ago_s >= 0 && d.rssi > -120)
    .reduce<number | null>((best, d) => (best === null || d.rssi > best ? d.rssi : best), null);
  const lampOn = !!lamp?.power_on;

  return (
    <>
      <div class="view-header">
        <div>
          <div class="eyebrow">
            {privacy ? 'SPATIAL TOPOLOGY · SECTOR [REDACTED]' : 'SPATIAL TOPOLOGY · QINHUAI OASIS NORTH'}
          </div>
          <h1 class="view-title">空间拓扑与平面图</h1>
        </div>
        <div class="btn-row">
          <button
            class={`btn btn-sm ${privacy ? 'btn-primary' : ''}`}
            onClick={togglePrivacy}
          >
            {privacy ? '隐私打码：开' : '隐私打码：关'}
          </button>
          <span class="tag dark">{privacy ? '隐私保护 · 已脱敏' : '秦淮绿洲北区 · 小家'}</span>
          <span class={`tag ${anyHome ? 'red' : ''}`}>{anyHome ? '在家 · 节点在线' : '离家 · 节点在线'}</span>
        </div>
      </div>

      <div class="grid g-topo">
        {/* Left 50%: Community Location Map */}
        <div class="card" style={{ minHeight: 0 }}>
          <div class="card-head">
            <span class="card-title">
              {privacy ? '01 / 小区区位与坐标 · [已脱敏]' : '01 / 小区区位与坐标 · 秦淮绿洲北区'}
            </span>
            <div class="btn-row">
              <span class="tag">2D 正北视图</span>
              <span class="tag red">小家信标</span>
            </div>
          </div>

          <div class={`topo-map-wrap ${privacy ? 'privacy-on' : ''}`}>
            <div class="topo-privacy-overlay">
              <div class="topo-privacy-pill">
                <span class="live-dot" />
                <span>GEO PRIVACY · 地理坐标已打码脱敏</span>
              </div>
            </div>
            <svg class="topo-map-svg" viewBox="0 0 600 540" preserveAspectRatio="xMidYMid meet">
              <defs>
                <pattern id="topo-cad-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--line)" stroke-width="0.6" opacity="0.55" />
                </pattern>
                <pattern id="topo-river-hatch" width="8" height="8" patternTransform="rotate(35)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="8" stroke="var(--text-dim)" stroke-width="1" opacity="0.22" />
                </pattern>
              </defs>

              <rect width="600" height="540" fill="url(#topo-cad-grid)" />

              <g class="topo-geo-blur">
                {/* Northern River */}
                <path d="M -10,92 Q 95,108 165,86 T 275,28 L 365,-10 L -10,-10 Z" fill="url(#topo-river-hatch)" stroke="var(--line-strong)" stroke-width="1.4" />
                <path d="M -10,92 Q 95,108 165,86 T 275,28 L 365,-10" fill="none" stroke="var(--text-dim)" stroke-width="1.2" stroke-dasharray="4 3" />
                <text x="148" y="42" fill="var(--text-dim)" font-size="10.5" font-weight="600" letter-spacing="0.14em">
                  {privacy ? 'WATERWAY // ████' : 'NORTHERN RIVER / 河道'}
                </text>

                {/* Northeast River Inlet */}
                <path d="M 505,-10 Q 520,55 610,68 L 610,-10 Z" fill="url(#topo-river-hatch)" stroke="var(--line-strong)" stroke-width="1" />

                {/* External Arterial Roads */}
                <path d="M 385,-10 L 368,125 L 392,185 L 478,242 L 485,550" fill="none" stroke="var(--surface)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M 385,-10 L 368,125 L 392,185 L 478,242 L 485,550" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="6 4" />
                <path d="M -10,335 Q 155,345 198,378 T 236,550" fill="none" stroke="var(--surface)" stroke-width="14" stroke-linecap="round" />
                <path d="M -10,335 Q 155,345 198,378 T 236,550" fill="none" stroke="var(--line-strong)" stroke-width="1.8" />
                <path d="M -10,335 Q 155,345 198,378 T 236,550" fill="none" stroke="var(--text-dim)" stroke-width="0.8" stroke-dasharray="5 5" />

                {/* Internal Community Roads */}
                <g fill="none" stroke="var(--line-strong)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.75">
                  <path d="M 75,198 Q 195,126 368,142 Q 455,152 478,242" />
                  <path d="M 332,144 Q 312,245 302,368" />
                  <path d="M 92,228 L 468,218" />
                  <path d="M 85,274 L 472,265" />
                  <path d="M 82,318 L 475,310" />
                  <path d="M 155,365 L 482,362" />
                </g>
                <g fill="none" stroke="var(--surface)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M 75,198 Q 195,126 368,142 Q 455,152 478,242" />
                  <path d="M 332,144 Q 312,245 302,368" />
                  <path d="M 92,228 L 468,218" />
                  <path d="M 85,274 L 472,265" />
                  <path d="M 82,318 L 475,310" />
                </g>

                {/* East Roundabout */}
                <circle cx="480" cy="310" r="9" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="2" />
                <circle cx="480" cy="310" r="3" fill="var(--text-dim)" />

                {/* Zone Boundary */}
                <path
                  d="M 66,195 Q 192,118 370,134 Q 465,146 484,242 L 486,368 L 210,368 Q 160,336 62,326 Z"
                  fill="none"
                  stroke="var(--text-dim)"
                  stroke-width="1"
                  stroke-dasharray="3 4"
                  opacity="0.55"
                />

                {/* Surrounding Context Blocks */}
                <g fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1" opacity="0.65">
                  <rect x="42" y="388" width="54" height="16" rx="1.5" transform="rotate(-4 69 396)" />
                  <rect x="112" y="394" width="56" height="16" rx="1.5" transform="rotate(-4 140 402)" />
                  <rect x="50" y="428" width="54" height="16" rx="1.5" transform="rotate(-4 77 436)" />
                  <rect x="122" y="434" width="56" height="16" rx="1.5" transform="rotate(-4 150 442)" />
                  <rect x="65" y="468" width="60" height="16" rx="1.5" transform="rotate(-4 95 476)" />
                  <rect x="278" y="395" width="54" height="16" rx="1.5" transform="rotate(-3 305 403)" />
                  <rect x="348" y="392" width="54" height="16" rx="1.5" transform="rotate(-3 375 400)" />
                  <rect x="418" y="388" width="52" height="16" rx="1.5" transform="rotate(-3 444 396)" />
                  <rect x="284" y="435" width="58" height="16" rx="1.5" transform="rotate(-3 313 443)" />
                  <rect x="358" y="432" width="54" height="16" rx="1.5" transform="rotate(-3 385 440)" />
                </g>

                {/* Residential Buildings */}
                <g fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.2">
                  <rect x="118" y="182" width="48" height="15" rx="1.5" transform="rotate(-7 142 189)" />
                  <rect x="180" y="168" width="52" height="15" rx="1.5" transform="rotate(-7 206 175)" />
                  <rect x="246" y="162" width="54" height="15" rx="1.5" transform="rotate(-6 273 169)" />
                  <rect x="348" y="162" width="52" height="15" rx="1.5" transform="rotate(-5 374 169)" />

                  <rect x="108" y="218" width="50" height="16" rx="1.5" transform="rotate(-6 133 226)" />
                  <rect x="172" y="210" width="54" height="16" rx="1.5" transform="rotate(-6 199 218)" />
                  <rect x="240" y="204" width="56" height="16" rx="1.5" transform="rotate(-5 268 212)" />
                  <rect x="344" y="202" width="54" height="16" rx="1.5" transform="rotate(-4 371 210)" />
                  <rect x="410" y="200" width="50" height="16" rx="1.5" transform="rotate(-4 435 208)" />

                  <rect x="102" y="256" width="50" height="17" rx="1.5" transform="rotate(-5 127 264)" />
                  <rect x="166" y="250" width="54" height="17" rx="1.5" transform="rotate(-5 193 258)" />
                  <rect x="234" y="244" width="58" height="19" rx="2" transform="rotate(-4 263 253)" fill="var(--black)" stroke="var(--red)" stroke-width="1.8" />
                  <rect x="338" y="244" width="56" height="17" rx="1.5" transform="rotate(-4 366 252)" />
                  <rect x="408" y="242" width="52" height="17" rx="1.5" transform="rotate(-4 434 250)" />

                  <rect x="98" y="294" width="52" height="16" rx="1.5" transform="rotate(-4 124 302)" />
                  <rect x="164" y="290" width="54" height="16" rx="1.5" transform="rotate(-4 191 298)" />
                  <rect x="232" y="286" width="56" height="16" rx="1.5" transform="rotate(-4 260 294)" />
                  <rect x="334" y="286" width="56" height="16" rx="1.5" transform="rotate(-3 362 294)" />
                  <rect x="406" y="284" width="52" height="16" rx="1.5" transform="rotate(-3 432 292)" />

                  <rect x="172" y="330" width="52" height="15" rx="1.5" transform="rotate(-3 198 337)" />
                  <rect x="236" y="328" width="56" height="15" rx="1.5" transform="rotate(-3 264 335)" />
                  <rect x="330" y="328" width="56" height="15" rx="1.5" transform="rotate(-3 358 335)" />
                  <rect x="404" y="326" width="52" height="15" rx="1.5" transform="rotate(-3 430 333)" />
                </g>

                {/* Map Labels */}
                <g font-family="var(--font)" font-size="11" font-weight="600">
                  <text x="415" y="114" fill="var(--text-sec)">
                    {privacy ? 'SECTOR-NE // ██████' : '东山社区 · 土山方向'}
                  </text>
                  <rect x="304" y="266" width="84" height="20" rx="2" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1" />
                  <circle cx="314" cy="276" r="3" fill="var(--text)" />
                  <text x="322" y="280" fill="var(--text)" font-size="10.5">
                    {privacy ? 'ZONE · ████' : '秦淮绿洲北区'}
                  </text>
                  <text x="116" y="421" fill="var(--text-dim)" font-size="10">
                    {privacy ? 'ZONE-S · ████' : '秦淮绿洲（南区）'}
                  </text>
                </g>
              </g>

              {/* Signal Red Beacon on 小家 */}
              <g>
                <line x1="263" y1="196" x2="263" y2="296" stroke="var(--red)" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.55" />
                <line x1="208" y1="252" x2="318" y2="252" stroke="var(--red)" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.55" />
                <circle class="topo-beacon-ring" cx="263" cy="252" r="14" fill="none" stroke="var(--red)" stroke-width="1.6" />
                <circle cx="263" cy="252" r="6" fill="var(--red)" stroke="var(--surface)" stroke-width="2" />
                <line x1="263" y1="246" x2="245" y2="220" stroke="var(--red)" stroke-width="1.2" />
                <rect x="172" y="198" width="84" height="22" rx="2" fill="var(--red)" />
                <text x="214" y="213" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="700" letter-spacing="0.04em">小家 · HOME</text>
              </g>

              {/* Top-Left Compass Rose */}
              <g transform="translate(26, 26)">
                <rect x="-12" y="-12" width="106" height="32" rx="2" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1" opacity="0.92" />
                <circle cx="4" cy="4" r="9" fill="none" stroke="var(--line-strong)" stroke-width="1" />
                <polygon points="4,-3 7,5 4,3 1,5" fill="var(--red)" />
                <text x="20" y="3" fill="var(--text)" font-size="10" font-weight="700" letter-spacing="0.08em">N 000°</text>
                <text x="20" y="14" fill="var(--text-dim)" font-size="9" font-family="var(--mono)">ZONE · N-BLK</text>
              </g>

              {/* Bottom-Right Scale Bar */}
              <g transform="translate(494, 504)">
                <rect x="-8" y="-12" width="96" height="24" rx="2" fill="var(--surface)" stroke="var(--line)" stroke-width="1" opacity="0.9" />
                <path d="M 4,4 L 4,8 L 44,8 L 44,4" fill="none" stroke="var(--text)" stroke-width="1.4" />
                <text x="50" y="8" fill="var(--text-sec)" font-size="9.5" font-family="var(--mono)">100m</text>
              </g>
            </svg>

            <div class="topo-meta-bar">
              <span>区位：<strong style={{ color: 'var(--text)' }}>{privacy ? '██ · ██████' : '南京 · 秦淮绿洲北区'}</strong></span>
              <span class="num">{privacy ? '位置：██████（小家）' : '位置：北区中排中栋（小家）'}</span>
              <span class="num">感知状态：<strong class={anyHome ? 'red' : ''}>{anyHome ? '在家 · 节点在线' : '离家 · 节点在线'}</strong></span>
            </div>
          </div>
        </div>

        {/* Right 50%: Stacked Bedroom Plan + Duplex Villa Elevation */}
        <div class="topo-right">
          {/* 02 / Bedroom Floorplan */}
          <div class="card" style={{ minHeight: 0 }}>
            <div class="card-head">
              <span class="card-title">02 / 卧室平面布局</span>
              <div class="btn-row">
                <span class="tag">CAD 平面图</span>
                <span class={`tag ${lampOn ? 'red' : ''}`}>{lampOn ? '主灯 · ON' : '主灯 · OFF'}</span>
              </div>
            </div>

            <div class="topo-map-wrap">
              <svg class="topo-map-svg" viewBox="0 0 600 260" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <pattern id="room-cad-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--line)" stroke-width="0.55" opacity="0.5" />
                  </pattern>
                  <pattern id="room-balcony-hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="0" y2="8" stroke="var(--text-dim)" stroke-width="0.8" opacity="0.16" />
                  </pattern>
                </defs>

                <rect width="600" height="260" fill="url(#room-cad-grid)" />
                <rect x="44" y="24" width="96" height="208" fill="url(#room-balcony-hatch)" />
                <rect x="140" y="24" width="416" height="208" fill="var(--surface)" opacity="0.45" />

                {/* Structural Outer Walls */}
                <path
                  d="M 44,24 L 556,24 L 556,232 L 548,232 M 500,232 L 44,232 L 44,24"
                  fill="none"
                  stroke="var(--text)"
                  stroke-width="3.2"
                  stroke-linecap="square"
                  stroke-linejoin="miter"
                />

                {/* Balcony Partition Wall */}
                <line x1="140" y1="24" x2="140" y2="178" stroke="var(--text)" stroke-width="2.6" />
                <line x1="140" y1="216" x2="140" y2="232" stroke="var(--text)" stroke-width="2.6" />

                {/* Exterior Balcony Window */}
                <g>
                  <rect x="40" y="54" width="8" height="146" fill="var(--surface)" stroke="var(--text)" stroke-width="1.2" />
                  <line x1="44" y1="54" x2="44" y2="200" stroke="var(--text-dim)" stroke-width="1" />
                  <text x="26" y="130" fill="var(--text-dim)" font-size="9.5" font-weight="600" text-anchor="middle" transform="rotate(-90 26 130)">外窗</text>
                </g>

                {/* Balcony Built-in Cabinet */}
                <g>
                  <rect x="48" y="28" width="88" height="22" rx="1" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <line x1="92" y1="28" x2="92" y2="50" stroke="var(--line-strong)" stroke-width="0.9" />
                  <text x="92" y="42" fill="var(--text-dim)" font-size="9" text-anchor="middle">阳台柜</text>
                </g>

                {/* Balcony Drying Rack */}
                <g>
                  <rect x="114" y="62" width="14" height="104" rx="1.5" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.1" stroke-dasharray="3 2" />
                  <line x1="121" y1="68" x2="121" y2="160" stroke="var(--text-dim)" stroke-width="1" />
                  <text x="121" y="116" fill="var(--text-dim)" font-size="8.5" text-anchor="middle" transform="rotate(-90 121 116)">晾衣架</text>
                </g>
                <text x="80" y="128" fill="var(--text-sec)" font-size="11.5" font-weight="600" letter-spacing="0.18em" text-anchor="middle">阳 台</text>

                {/* Interior Window */}
                <g>
                  <rect x="137" y="48" width="6" height="114" fill="var(--surface)" stroke="var(--text)" stroke-width="1.1" />
                  <line x1="140" y1="48" x2="140" y2="162" stroke="var(--text-dim)" stroke-width="0.8" />
                </g>

                {/* Balcony Door Swing */}
                <g>
                  <line x1="140" y1="178" x2="104" y2="178" stroke="var(--text)" stroke-width="1.5" />
                  <path d="M 104,178 A 36,36 0 0 0 140,214" fill="none" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3 2.5" />
                  <text x="122" y="203" fill="var(--text-dim)" font-size="8.5" text-anchor="middle">阳台门</text>
                </g>

                {/* Entry Door Swing (Flush near right wall) */}
                <g>
                  <line x1="548" y1="232" x2="548" y2="184" stroke="var(--text)" stroke-width="1.6" />
                  <path d="M 500,232 A 48,48 0 0 1 548,184" fill="none" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="3 2.5" />
                  <text x="524" y="246" fill="var(--text-sec)" font-size="9.5" font-weight="600" text-anchor="middle">卧室门</text>
                </g>

                {/* Low Cabinet under Window */}
                <g>
                  <rect x="147" y="78" width="24" height="82" rx="1.5" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <text x="159" y="122" fill="var(--text-dim)" font-size="9" text-anchor="middle" transform="rotate(-90 159 122)">窗边矮柜</text>
                </g>

                {/* Work Desk + PC + Chair + ESP32-S3 Node */}
                <g>
                  <rect x="184" y="34" width="102" height="44" rx="2" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <rect x="200" y="39" width="26" height="5" rx="1" fill="var(--text-sec)" />
                  <rect x="230" y="39" width="22" height="5" rx="1" fill="var(--text-dim)" />
                  <rect x="264" y="39" width="16" height="26" rx="1" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1" />
                  <circle cx="224" cy="98" r="10" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <path d="M 215,103 Q 224,111 233,103" fill="none" stroke="var(--text-sec)" stroke-width="1.6" stroke-linecap="round" />
                  <text x="224" y="64" fill="var(--text)" font-size="10.5" font-weight="600" text-anchor="middle">书桌</text>
                  <circle class="topo-beacon-ring" cx="255" cy="52" r="6" fill="none" stroke="var(--red)" stroke-width="1.2" />
                  <circle cx="255" cy="52" r="3.2" fill="var(--red)" />
                </g>

                {/* Left Nightstand */}
                <rect x="296" y="32" width="22" height="24" rx="1.5" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.1" />

                {/* King Bed */}
                <g>
                  <rect x="322" y="30" width="128" height="142" rx="2.5" fill="var(--surface)" stroke="var(--text)" stroke-width="1.5" />
                  <rect x="322" y="30" width="128" height="10" rx="1" fill="var(--text)" opacity="0.85" />
                  <rect x="334" y="46" width="46" height="22" rx="3" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1" />
                  <rect x="392" y="46" width="46" height="22" rx="3" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="322" y1="86" x2="450" y2="86" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="4 3" />
                  <text x="386" y="132" fill="var(--text)" font-size="13" font-weight="700" letter-spacing="0.16em" text-anchor="middle">床</text>
                </g>

                {/* Right Nightstand */}
                <rect x="454" y="32" width="22" height="24" rx="1.5" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.1" />

                {/* Wardrobe */}
                <g>
                  <rect x="510" y="32" width="38" height="114" rx="1.5" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <line x1="510" y1="89" x2="548" y2="89" stroke="var(--line-strong)" stroke-width="1" stroke-dasharray="3 2" />
                  <line x1="515" y1="36" x2="515" y2="142" stroke="var(--text-dim)" stroke-width="0.9" />
                  <text x="531" y="92" fill="var(--text)" font-size="10.5" font-weight="600" text-anchor="middle" transform="rotate(-90 531 92)">衣柜</text>
                </g>

                {/* Shoe Rack */}
                <g>
                  <rect x="520" y="152" width="28" height="26" rx="1.5" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <text x="534" y="168" fill="var(--text-sec)" font-size="9" font-weight="600" text-anchor="middle">鞋架</text>
                </g>

                {/* Grid Bookshelf */}
                <g>
                  <rect x="218" y="202" width="152" height="24" rx="1.5" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <line x1="248" y1="202" x2="248" y2="226" stroke="var(--line-strong)" stroke-width="0.8" />
                  <line x1="278" y1="202" x2="278" y2="226" stroke="var(--line-strong)" stroke-width="0.8" />
                  <line x1="308" y1="202" x2="308" y2="226" stroke="var(--line-strong)" stroke-width="0.8" />
                  <line x1="338" y1="202" x2="338" y2="226" stroke="var(--line-strong)" stroke-width="0.8" />
                  <text x="294" y="218" fill="var(--text)" font-size="10" font-weight="600" text-anchor="middle">格子置物柜</text>
                </g>

                {/* Interactive Center Ceiling Lamp */}
                <g
                  transform="translate(306, 134)"
                  style={{ cursor: lamp?.sample_loaded ? 'pointer' : 'default' }}
                  onClick={toggleLamp}
                >
                  <rect
                    x="-13"
                    y="-13"
                    width="26"
                    height="26"
                    rx="2"
                    fill="var(--surface)"
                    stroke={lampOn ? 'var(--red)' : 'var(--line-strong)'}
                    stroke-width="1.4"
                    stroke-dasharray="3 2"
                  />
                  <rect
                    x="-7"
                    y="-7"
                    width="14"
                    height="14"
                    rx="1"
                    fill={lampOn ? 'var(--red)' : 'var(--text-dim)'}
                    opacity={lampOn ? 0.22 : 0.1}
                    stroke={lampOn ? 'var(--red)' : 'var(--text-dim)'}
                    stroke-width="1"
                  />
                  <circle cx="0" cy="0" r="2.5" fill={lampOn ? 'var(--red)' : 'var(--text-dim)'} />
                  <text x="0" y="23" fill={lampOn ? 'var(--red)' : 'var(--text-dim)'} font-size="9" font-weight="700" text-anchor="middle">
                    {lampOn ? '吸顶主灯 · ON' : '吸顶主灯 · OFF'}
                  </text>
                </g>

                {/* 6x Signal Red Ceiling Spotlights */}
                <g class="room-spotlights">
                  {[
                    [322, 34],
                    [450, 34],
                    [184, 134],
                    [200, 134],
                    [234, 214],
                    [354, 214],
                  ].map(([cx, cy], i) => (
                    <g key={i} transform={`translate(${cx}, ${cy})`}>
                      <circle r="6" fill="var(--red)" opacity="0.22" />
                      <circle r="3.4" fill="var(--surface)" stroke="var(--red)" stroke-width="1.2" />
                      <circle r="1.5" fill="var(--red)" />
                    </g>
                  ))}
                </g>
              </svg>

              <div class="topo-meta-bar">
                <span>主灯：<strong class={lampOn ? 'red' : ''}>{lampOn ? '已开启 (点击切换)' : '已关闭 (点击切换)'}</strong></span>
                <span class="num">天花板射灯：6 盏</span>
                <span class="num">S3 节点：书桌区 · {activeRssi !== null ? `${activeRssi} dBm` : '--'}</span>
              </div>
            </div>
          </div>

          {/* 03 / Duplex Villa Elevation */}
          <div class="card" style={{ minHeight: 0 }}>
            <div class="card-head">
              <span class="card-title">03 / 住宅立面与楼层结构</span>
              <div class="btn-row">
                <span class="tag">双拼别墅立面</span>
                <span class="tag dark">B1 + 3F</span>
              </div>
            </div>

            <div class="topo-map-wrap">
              <svg class="topo-map-svg" viewBox="0 0 600 260" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <pattern id="elev-cad-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--line)" stroke-width="0.55" opacity="0.5" />
                  </pattern>
                  <pattern id="elev-roof-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-dim)" stroke-width="0.9" opacity="0.28" />
                  </pattern>
                  <pattern id="elev-glass-hatch" width="10" height="10" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="0" y2="10" stroke="var(--text-dim)" stroke-width="0.7" opacity="0.16" />
                  </pattern>
                </defs>

                <rect width="600" height="260" fill="url(#elev-cad-grid)" />

                {/* Elevation Level Datum Lines */}
                <g font-family="var(--mono)" font-size="9" fill="var(--text-dim)">
                  <line x1="78" y1="68" x2="556" y2="68" stroke="var(--line-strong)" stroke-width="0.8" stroke-dasharray="3 4" />
                  <text x="20" y="71" fill="var(--text-sec)" font-weight="600">3F +9.2m</text>
                  <line x1="78" y1="116" x2="556" y2="116" stroke="var(--red)" stroke-width="0.9" stroke-dasharray="3 3" opacity="0.65" />
                  <text x="20" y="119" fill="var(--red)" font-weight="700">2F +6.0m</text>
                  <line x1="78" y1="168" x2="556" y2="168" stroke="var(--line-strong)" stroke-width="0.8" stroke-dasharray="3 4" />
                  <text x="20" y="171" fill="var(--text-sec)" font-weight="600">1F +2.8m</text>
                  <line x1="78" y1="224" x2="564" y2="224" stroke="var(--text)" stroke-width="1.6" />
                  <text x="20" y="227" fill="var(--text)" font-weight="700">G  ±0.0m</text>
                </g>

                {/* Pitched Roofs */}
                <polygon points="116,58 140,42 268,42 268,58" fill="url(#elev-roof-hatch)" stroke="var(--text)" stroke-width="1.4" />
                <polygon points="348,58 348,40 480,40 504,58" fill="url(#elev-roof-hatch)" stroke="var(--line-strong)" stroke-width="1.3" />

                {/* Central Tower Parapet */}
                <g>
                  <rect x="268" y="34" width="80" height="190" fill="var(--surface)" stroke="var(--text)" stroke-width="1.5" />
                  <rect x="264" y="32" width="88" height="7" rx="1" fill="var(--surface)" stroke="var(--text)" stroke-width="1.3" />
                  <line x1="268" y1="45" x2="348" y2="45" stroke="var(--line-strong)" stroke-width="1" />
                  <rect x="292" y="20" width="32" height="8" rx="2" fill="var(--surface-sub)" stroke="var(--text-sec)" stroke-width="1.1" />
                  <line x1="298" y1="28" x2="296" y2="32" stroke="var(--text-sec)" stroke-width="1" />
                  <line x1="318" y1="28" x2="320" y2="32" stroke="var(--text-sec)" stroke-width="1" />
                  <rect x="288" y="64" width="40" height="32" fill="url(#elev-glass-hatch)" stroke="var(--text)" stroke-width="1.2" />
                  <line x1="308" y1="64" x2="308" y2="96" stroke="var(--line-strong)" stroke-width="1" />
                  <rect x="280" y="114" width="56" height="38" fill="url(#elev-glass-hatch)" stroke="var(--text)" stroke-width="1.2" />
                  <line x1="299" y1="114" x2="299" y2="152" stroke="var(--line-strong)" stroke-width="0.9" />
                  <line x1="317" y1="114" x2="317" y2="152" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="292" y="168" width="32" height="36" fill="var(--surface-sub)" stroke="var(--text)" stroke-width="1.4" />
                  <line x1="308" y1="168" x2="308" y2="204" stroke="var(--line-strong)" stroke-width="1" />
                  <g stroke="var(--line-strong)" stroke-width="1">
                    <rect x="282" y="204" width="52" height="20" fill="var(--surface-sub)" />
                    <line x1="282" y1="208" x2="334" y2="208" />
                    <line x1="282" y1="212" x2="334" y2="212" />
                    <line x1="282" y1="216" x2="334" y2="216" />
                    <line x1="282" y1="220" x2="334" y2="220" />
                  </g>
                </g>

                {/* Left Unit (Highlighted) */}
                <g>
                  <rect x="122" y="58" width="146" height="166" fill="var(--surface)" stroke="var(--text)" stroke-width="1.6" />
                  <rect x="126" y="60" width="138" height="42" fill="url(#elev-glass-hatch)" stroke="var(--text)" stroke-width="1.3" />
                  <line x1="154" y1="60" x2="154" y2="102" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="184" y1="60" x2="184" y2="102" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="214" y1="60" x2="214" y2="102" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="240" y1="60" x2="240" y2="102" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="126" y1="88" x2="264" y2="88" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="118" y="102" width="152" height="6" fill="var(--surface-sub)" stroke="var(--text)" stroke-width="1.2" />
                  <rect x="134" y="114" width="72" height="40" fill="url(#elev-glass-hatch)" stroke="var(--text)" stroke-width="1.3" />
                  <line x1="170" y1="114" x2="170" y2="154" stroke="var(--line-strong)" stroke-width="1" />
                  <line x1="134" y1="142" x2="206" y2="142" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="220" y="114" width="34" height="28" fill="url(#elev-glass-hatch)" stroke="var(--text)" stroke-width="1.2" />
                  <line x1="237" y1="114" x2="237" y2="142" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="114" y="160" width="156" height="5" fill="var(--text)" opacity="0.85" />
                  <rect x="134" y="170" width="66" height="28" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <rect x="224" y="170" width="32" height="34" fill="var(--surface-sub)" stroke="var(--text)" stroke-width="1.2" />
                  <g>
                    <rect x="132" y="202" width="68" height="22" fill="var(--surface-sub)" stroke="var(--text)" stroke-width="1.2" />
                    <line x1="132" y1="208" x2="200" y2="208" stroke="var(--line-strong)" stroke-width="0.7" />
                    <line x1="132" y1="214" x2="200" y2="214" stroke="var(--line-strong)" stroke-width="0.7" />
                    <line x1="132" y1="220" x2="200" y2="220" stroke="var(--line-strong)" stroke-width="0.7" />
                  </g>
                  <g stroke="var(--line-strong)" stroke-width="1">
                    <rect x="218" y="204" width="46" height="20" fill="var(--surface-sub)" />
                    <line x1="218" y1="208" x2="264" y2="208" />
                    <line x1="218" y1="212" x2="264" y2="212" />
                    <line x1="218" y1="216" x2="264" y2="216" />
                    <line x1="218" y1="220" x2="264" y2="220" />
                  </g>
                  <circle class="topo-beacon-ring" cx="170" cy="134" r="7" fill="none" stroke="var(--red)" stroke-width="1.4" />
                  <circle cx="170" cy="134" r="3.5" fill="var(--red)" />
                </g>

                {/* Right Twin Unit */}
                <g opacity="0.78">
                  <rect x="348" y="58" width="150" height="166" fill="var(--surface)" stroke="var(--line-strong)" stroke-width="1.4" />
                  <rect x="354" y="60" width="138" height="42" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <line x1="388" y1="60" x2="388" y2="102" stroke="var(--line-strong)" stroke-width="0.9" />
                  <line x1="422" y1="60" x2="422" y2="102" stroke="var(--line-strong)" stroke-width="0.9" />
                  <line x1="456" y1="60" x2="456" y2="102" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="348" y="102" width="154" height="6" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <rect x="356" y="114" width="66" height="40" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <line x1="389" y1="114" x2="389" y2="154" stroke="var(--line-strong)" stroke-width="0.9" />
                  <rect x="434" y="114" width="54" height="40" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.2" />
                  <rect x="356" y="168" width="66" height="30" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <rect x="434" y="168" width="54" height="30" fill="url(#elev-glass-hatch)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <rect x="424" y="202" width="64" height="22" fill="var(--surface-sub)" stroke="var(--line-strong)" stroke-width="1.1" />
                  <line x1="424" y1="208" x2="488" y2="208" stroke="var(--line-strong)" stroke-width="0.7" />
                  <line x1="424" y1="214" x2="488" y2="214" stroke="var(--line-strong)" stroke-width="0.7" />
                  <line x1="424" y1="220" x2="488" y2="220" stroke="var(--line-strong)" stroke-width="0.7" />
                </g>

                {/* Front Yard Trees */}
                <g fill="none" stroke="var(--text-dim)" stroke-width="1.1" opacity="0.55">
                  <line x1="100" y1="224" x2="100" y2="196" />
                  <circle cx="100" cy="186" r="12" stroke-dasharray="2 2" />
                  <line x1="528" y1="224" x2="528" y2="192" />
                  <circle cx="528" cy="180" r="14" stroke-dasharray="2 2" />
                </g>

                {/* Callout Badge */}
                <g transform="translate(508, 108)">
                  <rect x="0" y="0" width="76" height="18" rx="2" fill="var(--red)" />
                  <text x="38" y="12.5" text-anchor="middle" fill="#ffffff" font-size="9.5" font-weight="700">2F · 主卧节点</text>
                </g>
              </svg>

              <div class="topo-meta-bar">
                <span>建筑形态：<strong style={{ color: 'var(--text)' }}>双拼别墅正立面</strong></span>
                <span class="num">楼层：B1 车库 + 3F 地上</span>
                <span class="num">当前监控：<strong class="red">2F 卧室</strong></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
