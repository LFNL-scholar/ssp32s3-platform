export interface ChartSeries {
  label: string;
  color: string;
  data: (number | null)[];
}

export interface ThresholdLine {
  value: number;
  label: string;
  color: string;
}

interface Props {
  series: ChartSeries[];
  min?: number;
  max?: number;
  unit?: string;
  height?: number;
  thresholds?: ThresholdLine[];
}

export function LineChart({ series, min, max, unit = '', height = 140, thresholds = [] }: Props) {
  const width = 480;
  const padL = 40;
  const padR = 10;
  const padT = 10;
  const padB = 18;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allVals: number[] = [];
  series.forEach((s) => s.data.forEach((v) => { if (v !== null && Number.isFinite(v)) allVals.push(v); }));
  thresholds.forEach((t) => allVals.push(t.value));

  let yMin = min ?? (allVals.length ? Math.min(...allVals) : 0);
  let yMax = max ?? (allVals.length ? Math.max(...allVals) : 100);
  if (yMax <= yMin) { yMax = yMin + 10; }
  const span = yMax - yMin;

  const yPos = (v: number) => padT + plotH - ((v - yMin) / span) * plotH;
  const maxLen = Math.max(2, ...series.map((s) => s.data.length));

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {[0, 0.5, 1].map((t) => {
          const val = yMin + span * (1 - t);
          const y = padT + plotH * t;
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke="#334155" stroke-dasharray="3,3" stroke-width="1" />
              <text x={padL - 5} y={y + 4} fill="#94a3b8" font-size="10" text-anchor="end">
                {Math.round(val)}{unit}
              </text>
            </g>
          );
        })}

        {thresholds.map((th) => {
          const y = yPos(th.value);
          return (
            <g key={th.label}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke={th.color} stroke-dasharray="5,4" stroke-width="1.2" />
              <text x={width - padR - 2} y={y - 3} fill={th.color} font-size="10" text-anchor="end">
                {th.label} ({th.value}{unit})
              </text>
            </g>
          );
        })}

        {series.map((s) => {
          const pts: string[] = [];
          s.data.forEach((v, idx) => {
            if (v === null || !Number.isFinite(v)) return;
            const x = padL + (idx / (maxLen - 1)) * plotW;
            const y = Math.max(padT, Math.min(padT + plotH, yPos(v)));
            pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          });
          if (pts.length < 2) return null;
          return (
            <polyline
              key={s.label}
              fill="none"
              stroke={s.color}
              stroke-width="2"
              stroke-linejoin="round"
              points={pts.join(' ')}
            />
          );
        })}
      </svg>
      <div class="row" style={{ fontSize: '12px', marginTop: '4px', gap: '12px' }}>
        {series.map((s) => {
          const latest = [...s.data].reverse().find((v) => v !== null);
          return (
            <span key={s.label} class="row" style={{ gap: '5px' }}>
              <span class="dot" style={{ background: s.color }} />
              <span class="dim">{s.label}:</span>
              <b>{latest !== undefined && latest !== null ? `${latest}${unit}` : '--'}</b>
            </span>
          );
        })}
      </div>
    </div>
  );
}
