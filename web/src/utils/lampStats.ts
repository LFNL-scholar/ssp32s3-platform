// Explicit UTC+8 (Beijing Time) calendar & lamp usage statistics (ported from light-control/main/stats.js)
export const DAY = 86400;
export const OFFSET = 8 * 3600;

export type PeriodMode = 'day' | 'week' | 'month';

export interface TimelineSegment {
  start: number;
  end: number;
  power: 0 | 1 | null | 'future';
}

export interface LampEventMarker {
  at: number;
  power: number;
  cause: number;
}

export interface DaySummary {
  start: number;
  end: number;
  on: number;
  known: number;
  unknown: number;
  future: boolean;
  expired: boolean;
  segments: TimelineSegment[];
  events: LampEventMarker[];
}

export interface PeriodSummary {
  days: DaySummary[];
  total: number;
  effectiveDays: number;
  average: number | null;
  unknown: number;
}

export const dayStart = (seconds: number) => Math.floor((seconds + OFFSET) / DAY) * DAY - OFFSET;
export const dateKey = (seconds: number) => new Date((seconds + OFFSET) * 1000).toISOString().slice(0, 10);

export const parseDate = (key: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const seconds = Date.parse(`${key}T00:00:00+08:00`) / 1000;
  return Number.isFinite(seconds) && dateKey(seconds) === key ? seconds : NaN;
};

export function periodRange(key: string, mode: PeriodMode): { from: number; to: number } | null {
  const selected = parseDate(key);
  if (!Number.isFinite(selected)) return null;
  if (mode === 'week') {
    const weekday = new Date((selected + OFFSET) * 1000).getUTCDay();
    const from = selected - ((weekday + 6) % 7) * DAY;
    return { from, to: from + 7 * DAY };
  }
  if (mode === 'month') {
    const d = new Date((selected + OFFSET) * 1000);
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - OFFSET;
    const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 - OFFSET;
    return { from, to };
  }
  return { from: selected, to: selected + DAY };
}

export function shiftPeriod(key: string, mode: PeriodMode, delta: number): string {
  const range = periodRange(key, mode);
  if (!range) return key;
  return dateKey(delta < 0 ? range.from - DAY : range.to);
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}小时 ${m}分`;
  if (m > 0) return `${m}分钟`;
  return `${s}秒`;
}

export function fmtTimeHM(epochSec: number): string {
  const d = new Date((epochSec + OFFSET) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

export function summarize(
  records: [number, number, number, number][],
  from: number,
  to: number,
  now: number,
  oldest = 0
): PeriodSummary {
  const unique = new Map<string, [number, number, number, number]>();
  for (const r of records || []) {
    if (
      !Array.isArray(r) ||
      r.length !== 4 ||
      !r.every(Number.isFinite) ||
      r[1] < r[0] ||
      ![0, 1].includes(r[2]) ||
      ![0, 1, 2, 3, 4].includes(r[3])
    ) continue;
    unique.set(r.join(','), r);
  }
  const valid = [...unique.values()];
  const days: DaySummary[] = [];

  for (let start = from; start < to; start += DAY) {
    const end = start + DAY;
    const observedEnd = Math.max(start, Math.min(end, now));
    const edges = new Map<number, [number, number]>();
    const edge = (t: number, on: number, delta: number) => {
      if (!edges.has(t)) edges.set(t, [0, 0]);
      edges.get(t)![on] += delta;
    };
    edge(start, 0, 0);
    edge(observedEnd, 0, 0);
    for (const r of valid) {
      const a = Math.max(start, r[0], oldest);
      const b = Math.min(observedEnd, r[1]);
      if (b > a) {
        edge(a, r[2], 1);
        edge(b, r[2], -1);
      }
    }
    const points = [...edges.keys()].sort((a, b) => a - b);
    const counts: [number, number] = [0, 0];
    const segments: TimelineSegment[] = [];
    let on = 0;
    let known = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      counts[0] += edges.get(a)![0];
      counts[1] += edges.get(a)![1];
      const power: 0 | 1 | null = counts[0] > 0 && counts[1] === 0 ? 0 : counts[1] > 0 && counts[0] === 0 ? 1 : null;
      if (power !== null) known += b - a;
      if (power === 1) on += b - a;
      const previous = segments[segments.length - 1];
      if (previous && previous.power === power && previous.end === a) previous.end = b;
      else segments.push({ start: a, end: b, power });
    }
    if (observedEnd < end) segments.push({ start: observedEnd, end, power: 'future' });

    const markers = new Map<string, LampEventMarker>();
    for (const [a, , power, cause] of valid) {
      if (a >= start && a < end && a <= observedEnd && a <= now && a >= oldest && cause !== 0) {
        markers.set(`${a}:${power}:${cause}`, { at: a, power, cause });
      }
    }
    days.push({
      start,
      end,
      on,
      known,
      unknown: observedEnd - start - known,
      future: observedEnd === start,
      expired: end <= oldest,
      segments,
      events: [...markers.values()].sort((a, b) => a.at - b.at),
    });
  }

  const effective = days.filter((d) => d.known > 0);
  const total = days.reduce((sum, d) => sum + d.on, 0);
  return {
    days,
    total,
    effectiveDays: effective.length,
    average: effective.length ? total / effective.length : null,
    unknown: days.reduce((sum, d) => sum + d.unknown, 0),
  };
}
