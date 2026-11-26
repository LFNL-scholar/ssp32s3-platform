import { useEffect, useRef, useState } from 'preact/hooks';
import { chartPalette } from '../utils/theme';

export interface TelemetrySeries {
  label: string;
  color: string;
  data: (number | null)[];
  rawVal?: (number | null)[];
  w?: number;
  dashed?: boolean;
  isRed?: boolean;
  fmt?: (v: number) => string;
}

export interface RefLine {
  val: number;
  color: string;
  bg?: string;
}

interface TelemetryChartProps {
  id: string;
  series: TelemetrySeries[];
  min: number;
  max: number;
  yTicks: number[];
  unit?: string;
  refLines?: RefLine[];
  rawSeries?: (number | null)[];
  awayBelow?: number | null;
  themeTick?: string;
}

function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export function TelemetryChart({
  id,
  series,
  min,
  max,
  yTicks,
  unit = '',
  refLines = [],
  rawSeries,
  awayBelow = null,
}: TelemetryChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 205 });
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setSize({
        w: Math.max(320, Math.round(el.clientWidth || 600)),
        h: Math.max(185, Math.round(el.clientHeight || 205)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const P = chartPalette();
  const W = size.w;
  const H = size.h;
  const padL = 44;
  const padR = 54;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const span = max - min || 1;

  const baseLen = Math.max(2, series[0]?.data.length || 0);
  const xOf = (i: number, len: number) => padL + (i / Math.max(1, len - 1)) * plotW;
  const yOf = (v: number) => padT + (1 - (Math.max(min, Math.min(max, v)) - min) / span) * plotH;

  const xMarks = [
    { frac: 0, lbl: '-60s' },
    { frac: 0.25, lbl: '-45s' },
    { frac: 0.5, lbl: '-30s' },
    { frac: 0.75, lbl: '-15s' },
    { frac: 1, lbl: 'NOW' },
  ];

  const hoverIdx =
    hoverFrac !== null
      ? Math.round(((Math.max(padL, Math.min(padL + plotW, hoverFrac * W)) - padL) / plotW) * (baseLen - 1))
      : null;

  return (
    <div
      class="chart-wrap"
      ref={wrapRef}
      onMouseMove={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) setHoverFrac((e.clientX - rect.left) / rect.width);
      }}
      onMouseLeave={() => setHoverFrac(null)}
    >
      <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <pattern id={`${id}-hatch-blk`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={P.ink} stroke-opacity="0.09" stroke-width="1" />
          </pattern>
          <pattern id={`${id}-hatch-red`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke={P.red} stroke-opacity="0.14" stroke-width="1" />
          </pattern>
        </defs>

        <rect x={padL} y={padT} width={plotW} height={plotH} fill={P.bg} stroke={P.frame} stroke-width="1" />

        {awayBelow !== null && (
          <g>
            <rect
              x={padL}
              y={yOf(awayBelow)}
              width={plotW}
              height={Math.max(0, padT + plotH - yOf(awayBelow))}
              fill={`url(#${id}-hatch-red)`}
            />
            <text x={padL + 8} y={padT + plotH - 6} font-size="10" fill={P.red} opacity="0.8" font-weight="600">
              离家判定区
            </text>
          </g>
        )}

        {yTicks.map((tv) => {
          const y = yOf(tv);
          return (
            <g key={tv}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke={P.gridH} stroke-dasharray="2 3" stroke-width="1" />
              <line x1={padL - 4} y1={y} x2={padL} y2={y} stroke={P.tick} stroke-width="1" />
              <text x={padL - 7} y={y + 3.5} text-anchor="end" font-size="10.5" fill={P.lbl}>
                {tv}
              </text>
            </g>
          );
        })}

        {xMarks.map((xm) => {
          const x = padL + xm.frac * plotW;
          return (
            <g key={xm.lbl}>
              <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke={P.gridV} stroke-width="1" />
              <line x1={x} y1={padT + plotH} x2={x} y2={padT + plotH + 4} stroke={P.tick} stroke-width="1" />
              <text
                x={x}
                y={H - 6}
                text-anchor="middle"
                font-size="10.5"
                fill={xm.lbl === 'NOW' ? P.ink : P.lbl}
                font-weight={xm.lbl === 'NOW' ? '600' : '400'}
              >
                {xm.lbl}
              </text>
            </g>
          );
        })}

        {rawSeries &&
          rawSeries.length > 1 &&
          rawSeries.map((v, i) => {
            if (v === null) return null;
            const x = xOf(i, rawSeries.length);
            const y = yOf(v);
            const emaV = series[0]?.data[i];
            const emaY = emaV !== null && emaV !== undefined ? yOf(emaV) : y;
            return (
              <g key={i}>
                <line x1={x} y1={emaY} x2={x} y2={y} stroke={P.stem} stroke-width="1" />
                <circle cx={x} cy={y} r="1.8" fill={P.lbl} />
              </g>
            );
          })}

        {refLines.map((r, idx) => {
          const y = yOf(r.val);
          return (
            <g key={idx}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke={r.color} stroke-dasharray="5 3" stroke-width="1.2" />
              <rect x={padL + plotW + 4} y={y - 8} width="46" height="16" rx="3" fill={r.bg || P.tagBg} stroke={r.color} stroke-width="1" />
              <text x={padL + plotW + 27} y={y + 3.5} text-anchor="middle" font-size="10" font-weight="600" fill={r.color}>
                {r.val}
              </text>
            </g>
          );
        })}

        {series.map((s, idx) => {
          const pts: [number, number][] = [];
          s.data.forEach((v, i) => {
            if (v !== null) pts.push([xOf(i, s.data.length), yOf(v)]);
          });
          if (pts.length < 2) return null;
          const d = smoothPath(pts);
          const last = pts[pts.length - 1];
          const lastVal = (s.rawVal ? s.rawVal[s.rawVal.length - 1] : s.data[s.data.length - 1]) ?? 0;
          const label = s.fmt ? s.fmt(lastVal) : `${lastVal.toFixed(1)}${unit}`;

          return (
            <g key={s.label}>
              {idx === 0 && (
                <path
                  d={`${d} L${last[0].toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`}
                  fill={`url(#${id}-${s.isRed ? 'hatch-red' : 'hatch-blk'})`}
                />
              )}
              <path
                d={d}
                fill="none"
                stroke={s.color}
                stroke-width={s.w || 2}
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-dasharray={s.dashed ? '4 3' : undefined}
              />
              <circle cx={last[0]} cy={last[1]} r="5.5" fill={P.dotBg} fill-opacity="0.18" />
              <circle cx={last[0]} cy={last[1]} r="2.8" fill={P.dotBg} stroke={s.color} stroke-width="2" />
              {idx === 0 && !refLines.length && (
                <g>
                  <rect x={padL + plotW + 4} y={last[1] - 9} width="46" height="18" rx="3" fill={s.color} />
                  <text x={padL + plotW + 27} y={last[1] + 3.5} text-anchor="middle" font-size="10" font-weight="600" fill={s.isRed ? '#ffffff' : P.dotBg}>
                    {label}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {hoverIdx !== null && (
          <line
            x1={xOf(hoverIdx, baseLen)}
            y1={padT}
            x2={xOf(hoverIdx, baseLen)}
            y2={padT + plotH}
            stroke={P.ink}
            stroke-dasharray="3 2"
            stroke-width="1"
          />
        )}
        {hoverIdx !== null &&
          series.map((s) => {
            const v = s.data[hoverIdx];
            if (v === null || v === undefined) return null;
            return <circle key={s.label} cx={xOf(hoverIdx, baseLen)} cy={yOf(v)} r="4" fill={P.dotBg} stroke={s.color} stroke-width="2" />;
          })}
      </svg>

      {hoverIdx !== null && (
        <div
          class="chart-tip show"
          style={{ left: `${Math.max(70, Math.min(W - 70, xOf(hoverIdx, baseLen)))}px` }}
        >
          <div class="chart-tip-time">
            {hoverIdx === baseLen - 1 ? '实时 NOW' : `-${Math.round((1 - hoverIdx / Math.max(1, baseLen - 1)) * 60)} 秒前`}
          </div>
          {series.map((s) => {
            const v = s.rawVal ? s.rawVal[hoverIdx] : s.data[hoverIdx];
            return (
              <div class="chart-tip-row" key={s.label}>
                <span style={{ opacity: 0.75 }}>{s.label}</span>
                <strong class="num">{v !== null && v !== undefined ? (s.fmt ? s.fmt(v) : `${v.toFixed(1)}${unit}`) : '--'}</strong>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface BarItem {
  lbl: string;
  hours: number;
  events: number;
  isPeak?: boolean;
  isToday?: boolean;
}

export function LightingBarChart({ id, items }: { id: string; items: BarItem[]; themeTick?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 500, h: 185 });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setSize({
        w: Math.max(280, Math.round(el.clientWidth || 500)),
        h: Math.max(165, Math.round(el.clientHeight || 185)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const P = chartPalette();
  const W = size.w;
  const H = size.h;
  const padL = 36;
  const padR = 62;
  const padT = 24;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const list = items.length ? items : [{ lbl: '--', hours: 0, events: 0 }];
  const maxRaw = Math.max(...list.map((d) => d.hours), 1);
  const maxY = Math.ceil(maxRaw / 2) * 2 + (maxRaw > 10 ? 4 : 1);
  const avg = list.reduce((a, b) => a + b.hours, 0) / list.length;
  const yOf = (v: number) => padT + (1 - Math.min(maxY, Math.max(0, v)) / maxY) * plotH;

  const step = plotW / list.length;
  const barW = Math.min(34, Math.max(8, step * 0.44));
  const pts: [number, number][] = list.map((it, i) => [padL + step * i + step / 2, yOf(it.hours)]);
  const trendD = smoothPath(pts);

  return (
    <div class="bar-chart-wrap" ref={wrapRef}>
      <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <pattern id={`${id}-bar-hatch`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="5" stroke={P.ink} stroke-opacity="0.18" stroke-width="1" />
          </pattern>
        </defs>

        {[0, 1, 2, 3].map((i) => {
          const val = (maxY / 3) * i;
          const y = yOf(val);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke={P.gridH} stroke-dasharray="2 3" stroke-width="1" />
              <text x={padL - 6} y={y + 3.5} text-anchor="end" font-size="10" fill={P.lbl}>
                {val.toFixed(0)}h
              </text>
            </g>
          );
        })}

        <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} stroke={P.frame} stroke-width="1" />

        <line x1={padL} y1={yOf(avg)} x2={padL + plotW} y2={yOf(avg)} stroke={P.sec} stroke-dasharray="4 3" stroke-width="1.1" />
        <rect x={padL + plotW + 5} y={yOf(avg) - 8} width="52" height="16" rx="3" fill={P.tagBg} stroke={P.tick} stroke-width="1" />
        <text x={padL + plotW + 31} y={yOf(avg) + 3.5} text-anchor="middle" font-size="10" fill={P.sec} font-weight="600">
          均 {avg.toFixed(1)}h
        </text>

        {list.map((it, i) => {
          const cx = padL + step * i + step / 2;
          const x = cx - barW / 2;
          const y = yOf(it.hours);
          const bh = Math.max(2, padT + plotH - y);
          const fill = it.isPeak ? P.red : it.isToday ? P.ink : `url(#${id}-bar-hatch)`;
          const stroke = it.isPeak ? P.red : P.ink;
          const showLbl = list.length <= 12 || i % 3 === 0 || it.isToday || it.isPeak;

          return (
            <g
              key={i}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
            >
              <rect x={x} y={y} width={barW} height={bh} rx="2" fill={fill} stroke={stroke} stroke-width="1.2" />
              {(list.length <= 10 || it.isPeak || it.isToday) && (
                <text
                  x={cx}
                  y={y - 8}
                  text-anchor="middle"
                  font-size="10.5"
                  font-weight={it.isPeak || it.isToday ? '700' : '500'}
                  fill={it.isPeak ? P.red : P.ink}
                >
                  {it.hours.toFixed(1)}h
                </text>
              )}
              {showLbl && (
                <text
                  x={cx}
                  y={H - 7}
                  text-anchor="middle"
                  font-size="11"
                  font-weight={it.isToday ? '700' : '400'}
                  fill={it.isToday ? P.ink : P.lbl}
                >
                  {it.lbl}
                </text>
              )}
            </g>
          );
        })}

        {pts.length > 1 && (
          <g style={{ pointerEvents: 'none' }}>
            <path d={trendD} fill="none" stroke={P.red} stroke-width="1.4" stroke-dasharray="3 2" />
            {pts.map(([px, py], i) => (
              <circle key={i} cx={px} cy={py} r="2.5" fill={P.dotBg} stroke={P.red} stroke-width="1.4" />
            ))}
          </g>
        )}
      </svg>

      {hoverIdx !== null && list[hoverIdx] && (
        <div
          class="chart-tip show"
          style={{ left: `${Math.max(64, Math.min(W - 64, padL + step * hoverIdx + step / 2))}px` }}
        >
          <div class="chart-tip-time">
            {list[hoverIdx].lbl}
            {list[hoverIdx].isToday ? ' · 今日' : ''}
            {list[hoverIdx].isPeak ? ' · 峰值' : ''}
          </div>
          <div class="chart-tip-row">
            <span style={{ opacity: 0.75 }}>亮灯时长</span>
            <strong class="num">{list[hoverIdx].hours.toFixed(1)} 小时</strong>
          </div>
          <div class="chart-tip-row">
            <span style={{ opacity: 0.75 }}>状态变更</span>
            <strong class="num">{list[hoverIdx].events} 次</strong>
          </div>
        </div>
      )}
    </div>
  );
}

export interface EnvChartPoint {
  epoch: number;
  val: number;
}

interface EnvTrendChartProps {
  id: string;
  label: string;
  unit: string;
  points: EnvChartPoint[];
  range: '24h' | '7d' | '30d';
  refLines?: RefLine[];
  isRed?: boolean;
  minFloor?: number;
  maxCeil?: number;
  themeTick?: string;
}

function fmtEnvAxisTime(epoch: number, range: '24h' | '7d' | '30d'): string {
  const d = new Date((epoch + 8 * 3600) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return range === '24h' ? `${hh}:${mi}` : `${mm}-${dd}`;
}

function fmtEnvFullTime(epoch: number): string {
  const d = new Date((epoch + 8 * 3600) * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function EnvTrendChart({
  id,
  label,
  unit,
  points,
  range,
  refLines = [],
  isRed = false,
  minFloor,
  maxCeil,
}: EnvTrendChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 540, h: 210 });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setSize({
        w: Math.max(300, Math.round(el.clientWidth || 540)),
        h: Math.max(185, Math.round(el.clientHeight || 210)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) {
    return (
      <div class="chart-wrap" ref={wrapRef} style={{ display: 'grid', placeItems: 'center', border: '1px dashed var(--line)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-sub)' }}>
        <div class="dim" style={{ fontSize: '12px', textAlign: 'center', padding: '16px' }}>
          {points.length === 1 ? '已记录 1 个采样点，等待下一个 5 分钟周期形成趋势曲线' : '暂无足够历史采样点（SNTP 对时且收到传感器读数后每 5 分钟自动记录）'}
        </div>
      </div>
    );
  }

  const P = chartPalette();
  const W = size.w;
  const H = size.h;
  const padL = 42;
  const padR = 52;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const vals = points.map((p) => p.val);
  const refs = refLines.map((r) => r.val);
  const rawMin = Math.min(...vals, ...(refs.length ? refs : vals));
  const rawMax = Math.max(...vals, ...(refs.length ? refs : vals));
  const padSpan = Math.max(2, (rawMax - rawMin) * 0.16);
  let yMin = Math.floor(rawMin - padSpan);
  let yMax = Math.ceil(rawMax + padSpan);
  if (minFloor !== undefined) yMin = Math.max(minFloor, yMin);
  if (maxCeil !== undefined) yMax = Math.min(maxCeil, yMax);
  if (yMax <= yMin) yMax = yMin + 4;
  const span = yMax - yMin;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Number((yMin + span * f).toFixed(1)));
  const xOf = (i: number) => padL + (i / Math.max(1, points.length - 1)) * plotW;
  const yOf = (v: number) => padT + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / span) * plotH;

  const stroke = isRed ? P.red : P.ink;
  const pts: [number, number][] = points.map((p, i) => [xOf(i), yOf(p.val)]);
  const pathD = smoothPath(pts);
  const last = pts[pts.length - 1];
  const lastVal = points[points.length - 1].val;

  const xMarkIdx = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (points.length - 1)));

  return (
    <div
      class="chart-wrap"
      ref={wrapRef}
      onMouseMove={(e) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        const fracX = (e.clientX - rect.left) / rect.width;
        const idx = Math.round(((Math.max(padL, Math.min(padL + plotW, fracX * W)) - padL) / plotW) * (points.length - 1));
        setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
      }}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <pattern id={`${id}-hatch-blk`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={P.ink} stroke-opacity="0.09" stroke-width="1" />
          </pattern>
          <pattern id={`${id}-hatch-red`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke={P.red} stroke-opacity="0.14" stroke-width="1" />
          </pattern>
        </defs>

        <rect x={padL} y={padT} width={plotW} height={plotH} fill={P.bg} stroke={P.frame} stroke-width="1" />

        {yTicks.map((tv) => {
          const y = yOf(tv);
          return (
            <g key={tv}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke={P.gridH} stroke-dasharray="2 3" stroke-width="1" />
              <line x1={padL - 4} y1={y} x2={padL} y2={y} stroke={P.tick} stroke-width="1" />
              <text x={padL - 7} y={y + 3.5} text-anchor="end" font-size="10" fill={P.lbl}>
                {tv.toFixed(0)}
              </text>
            </g>
          );
        })}

        {xMarkIdx.map((idx, pos) => {
          const x = xOf(idx);
          const lbl = pos === xMarkIdx.length - 1 ? fmtEnvAxisTime(points[idx].epoch, '24h') : fmtEnvAxisTime(points[idx].epoch, range);
          return (
            <g key={pos}>
              <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke={P.gridV} stroke-width="1" />
              <line x1={x} y1={padT + plotH} x2={x} y2={padT + plotH + 4} stroke={P.tick} stroke-width="1" />
              <text x={x} y={H - 6} text-anchor="middle" font-size="10" fill={pos === xMarkIdx.length - 1 ? P.ink : P.lbl} font-weight={pos === xMarkIdx.length - 1 ? '600' : '400'}>
                {lbl}
              </text>
            </g>
          );
        })}

        {refLines.map((r, idx) => {
          const y = yOf(r.val);
          return (
            <g key={idx}>
              <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke={r.color} stroke-dasharray="4 3" stroke-width="1.1" />
              <rect x={padL + plotW + 4} y={y - 8} width="44" height="16" rx="3" fill={r.bg || P.tagBg} stroke={r.color} stroke-width="1" />
              <text x={padL + plotW + 26} y={y + 3.5} text-anchor="middle" font-size="9.5" font-weight="600" fill={r.color}>
                {r.val}{unit}
              </text>
            </g>
          );
        })}

        <path
          d={`${pathD} L${last[0].toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`}
          fill={`url(#${id}-${isRed ? 'hatch-red' : 'hatch-blk'})`}
        />
        <path d={pathD} fill="none" stroke={stroke} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx={last[0]} cy={last[1]} r="5" fill={P.dotBg} fill-opacity="0.18" />
        <circle cx={last[0]} cy={last[1]} r="2.8" fill={P.dotBg} stroke={stroke} stroke-width="2" />

        <g>
          <rect x={padL + plotW + 4} y={last[1] - 9} width="44" height="18" rx="3" fill={stroke} />
          <text x={padL + plotW + 26} y={last[1] + 3.5} text-anchor="middle" font-size="10" font-weight="600" fill={isRed ? '#ffffff' : P.dotBg}>
            {lastVal.toFixed(1)}
          </text>
        </g>

        {hoverIdx !== null && (
          <g>
            <line x1={xOf(hoverIdx)} y1={padT} x2={xOf(hoverIdx)} y2={padT + plotH} stroke={P.ink} stroke-dasharray="3 2" stroke-width="1" />
            <circle cx={xOf(hoverIdx)} cy={yOf(points[hoverIdx].val)} r="4" fill={P.dotBg} stroke={stroke} stroke-width="2" />
          </g>
        )}
      </svg>

      {hoverIdx !== null && points[hoverIdx] && (
        <div
          class="chart-tip show"
          style={{ left: `${Math.max(70, Math.min(W - 70, xOf(hoverIdx)))}px` }}
        >
          <div class="chart-tip-time">{fmtEnvFullTime(points[hoverIdx].epoch)}</div>
          <div class="chart-tip-row">
            <span style={{ opacity: 0.75 }}>{label}</span>
            <strong class="num">{points[hoverIdx].val.toFixed(1)}{unit}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
