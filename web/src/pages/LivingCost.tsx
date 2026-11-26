import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  api,
  LivingCostData,
  LivingCostHouse,
  LivingCostPart,
  LivingCostRecord,
  LivingCostUtilMode,
} from '../api/client';
import { periodRange, summarize } from '../utils/lampStats';
import { chartPalette } from '../utils/theme';

type ChartMode = 'all' | 'util' | 'rent';
type FocusKey = null | 'rent' | 'elec' | 'water' | 'gas' | 'bundle';
type SyncState = 'loading' | 'synced' | 'saving' | 'offline';

const CACHE_KEY = 's3_living_cost_cache_v1';

const DEFAULT_COST_DATA: LivingCostData = {
  budgetTotal: 1800,
  budgetUtil: 200,
  records: [
    { month: '2026-01', house: '旧房', rent: 1350, utilMode: 'split', elec: 174.5, water: 0, gas: 0, bundleAmount: 0, bundleParts: [], note: '2月实缴 · 冬季1月电费' },
    { month: '2026-02', house: '旧房', rent: 1350, utilMode: 'split', elec: 13.0, water: 15.26, gas: 0, bundleAmount: 0, bundleParts: [], note: '3月实缴 · 2月电+双月水' },
    { month: '2026-03', house: '旧房', rent: 1350, utilMode: 'split', elec: 44.0, water: 0, gas: 0, bundleAmount: 0, bundleParts: [], note: '4月实缴 · 3月电费' },
    { month: '2026-04', house: '旧房', rent: 1350, utilMode: 'split', elec: 27.0, water: 129.66, gas: 0, bundleAmount: 0, bundleParts: [], note: '5月实缴 · 4月电+双月水偏贵' },
    { month: '2026-05', house: '旧房', rent: 1350, utilMode: 'split', elec: 28.0, water: 0, gas: 0, bundleAmount: 0, bundleParts: [], note: '6月实缴 · 5月电费' },
    { month: '2026-06', house: '旧房', rent: 1350, utilMode: 'split', elec: 36.0, water: 0, gas: 0, bundleAmount: 0, bundleParts: [], note: '7月实缴 · 旧房末月电费（6月底换新房）' },
    { month: '2026-07', house: '新房', rent: 1600, utilMode: 'bundle', elec: 0, water: 0, gas: 0, bundleAmount: 190, bundleParts: ['elec', 'water', 'gas'], note: '8月实缴 · 新房首月水电气' },
    { month: '2026-08', house: '新房', rent: 1600, utilMode: 'bundle', elec: 0, water: 0, gas: 0, bundleAmount: 200, bundleParts: ['elec', 'gas'], note: '9月实缴 · 8月电+燃气' },
    { month: '2026-09', house: '新房', rent: 1600, utilMode: 'bundle', elec: 0, water: 0, gas: 0, bundleAmount: 240, bundleParts: ['elec', 'water', 'gas'], note: '10月实缴 · 9月水电气（含双月水）' },
    { month: '2026-10', house: '新房', rent: 1600, utilMode: 'bundle', elec: 0, water: 0, gas: 0, bundleAmount: 77, bundleParts: ['elec', 'gas'], note: '11月实缴 · 10月电+燃气' },
    { month: '2026-11', house: '新房', rent: 1600, utilMode: 'bundle', elec: 0, water: 0, gas: 0, bundleAmount: 0, bundleParts: ['elec', 'water', 'gas'], utilPending: true, note: '待12月初实缴（预计含双月水）' },
  ],
};

function cloneData(data: LivingCostData): LivingCostData {
  return {
    budgetTotal: Number(data.budgetTotal ?? 1800),
    budgetUtil: Number(data.budgetUtil ?? 200),
    records: [...(data.records || [])]
      .map((r) => ({
        month: String(r.month || ''),
        house: (r.house === '旧房' ? '旧房' : '新房') as LivingCostHouse,
        rent: Math.max(0, Number(r.rent || 0)),
        utilMode: (r.utilMode === 'split' ? 'split' : 'bundle') as LivingCostUtilMode,
        elec: Math.max(0, Number(r.elec || 0)),
        water: Math.max(0, Number(r.water || 0)),
        gas: Math.max(0, Number(r.gas || 0)),
        bundleAmount: Math.max(0, Number(r.bundleAmount || 0)),
        bundleParts: Array.isArray(r.bundleParts) ? r.bundleParts.filter((p): p is LivingCostPart => p === 'elec' || p === 'water' || p === 'gas') : [],
        utilPending: Boolean(r.utilPending),
        lampHours: typeof r.lampHours === 'number' ? r.lampHours : undefined,
        note: r.note ? String(r.note) : '',
      }))
      .filter((r) => /^\d{4}-\d{2}$/.test(r.month))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

function defaultSelectedMonth(records: LivingCostRecord[]): string {
  const settled = [...records].reverse().find((r) => !calcTotals(r).utilPending);
  return settled?.month || records[records.length - 1]?.month || '2026-10';
}

function calcTotals(r: LivingCostRecord | null | undefined) {
  const rent = Number(r?.rent || 0);
  const isBundle = r?.utilMode === 'bundle';
  const elec = isBundle ? 0 : Number(r?.elec || 0);
  const water = isBundle ? 0 : Number(r?.water || 0);
  const gas = isBundle ? 0 : Number(r?.gas || 0);
  const util = isBundle ? Number(r?.bundleAmount || 0) : elec + water + gas;
  const bundleParts = Array.isArray(r?.bundleParts) ? r.bundleParts : [];
  const utilPending = Boolean(r?.utilPending && util === 0);
  return { rent, elec, water, gas, util, total: rent + util, isBundle, bundleParts, utilPending };
}

function fmtMoney(v: number): string {
  return '¥ ' + Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatBundlePartsText(parts: LivingCostPart[]): string {
  const map: Record<LivingCostPart, string> = { elec: '电', water: '水', gas: '燃气' };
  const order: LivingCostPart[] = (['elec', 'water', 'gas'] as LivingCostPart[]).filter((k) => parts.includes(k));
  return order.length ? order.map((k) => map[k]).join('+') : '未选科目';
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

function buildDraftFromRecord(month: string, rec: LivingCostRecord | null, prev: LivingCostRecord | null): LivingCostRecord {
  const fallbackHouse: LivingCostHouse = prev?.house || '新房';
  const fallbackMode: LivingCostUtilMode = prev?.utilMode || 'bundle';
  if (rec) {
    return {
      ...rec,
      bundleParts: [...(rec.bundleParts || [])],
      note: rec.note || '',
    };
  }
  const prevHadWater =
    prev?.utilMode === 'bundle' ? (prev.bundleParts || []).includes('water') : Number(prev?.water || 0) > 0;
  return {
    month,
    house: fallbackHouse,
    rent: prev ? prev.rent : 1600,
    utilMode: fallbackMode,
    elec: 0,
    water: 0,
    gas: 0,
    bundleAmount: 0,
    bundleParts: prevHadWater ? ['elec', 'gas'] : ['elec', 'water', 'gas'],
    utilPending: false,
    note: '',
  };
}

export function LivingCost({ themeTick: _themeTick }: { themeTick: string }) {
  const [costData, setCostData] = useState<LivingCostData>(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && Array.isArray(cached.records) && cached.records.length) {
        return cloneData(cached);
      }
    } catch {
      /* ignore cache error */
    }
    return cloneData(DEFAULT_COST_DATA);
  });

  const [selectedMonth, setSelectedMonth] = useState<string>(() => defaultSelectedMonth(costData.records));
  const [draft, setDraft] = useState<LivingCostRecord>(() => {
    const m = defaultSelectedMonth(costData.records);
    const rec = costData.records.find((r) => r.month === m) || null;
    const idx = costData.records.findIndex((r) => r.month === m);
    const prev = idx > 0 ? costData.records[idx - 1] : null;
    return buildDraftFromRecord(m, rec, prev);
  });

  const [chartMode, setChartMode] = useState<ChartMode>('all');
  const [focusKey, setFocusKey] = useState<FocusKey>(null);
  const [syncState, setSyncState] = useState<SyncState>('loading');
  const [notice, setNotice] = useState<{ text: string; err?: boolean } | null>(null);
  const [realLampHours, setRealLampHours] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const budgetTimerRef = useRef<number | null>(null);
  const [chartSize, setChartSize] = useState({ w: 580, h: 225 });

  const flash = (text: string, err = false) => {
    setNotice({ text, err });
    window.setTimeout(() => {
      setNotice((cur) => (cur?.text === text ? null : cur));
    }, 3200);
  };

  const persistRemote = async (next: LivingCostData, silent = false) => {
    const clean = cloneData(next);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(clean));
    } catch {
      /* ignore */
    }
    setSyncState('saving');
    try {
      await api.livingCostSave(clean);
      setSyncState('synced');
    } catch (e) {
      setSyncState('offline');
      if (!silent) {
        flash(`本地已更新，同步到 S3 失败：${e instanceof Error ? e.message : '网络错误'}`, true);
      }
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.livingCostGet();
        if (!alive) return;
        if (res.initialized === false || !Array.isArray(res.records) || res.records.length === 0) {
          const seed = cloneData(DEFAULT_COST_DATA);
          setCostData(seed);
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(seed));
          } catch {
            /* ignore */
          }
          const m = defaultSelectedMonth(seed.records);
          const idx = seed.records.findIndex((r) => r.month === m);
          setSelectedMonth(m);
          setDraft(buildDraftFromRecord(m, seed.records[idx] || null, idx > 0 ? seed.records[idx - 1] : null));
          await persistRemote(seed, true);
          if (alive) flash('已将 2026 真实账单基线初始化写入 ESP32-S3 Flash');
        } else {
          const loaded = cloneData(res);
          setCostData(loaded);
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(loaded));
          } catch {
            /* ignore */
          }
          const m = defaultSelectedMonth(loaded.records);
          const idx = loaded.records.findIndex((r) => r.month === m);
          setSelectedMonth(m);
          setDraft(buildDraftFromRecord(m, loaded.records[idx] || null, idx > 0 ? loaded.records[idx - 1] : null));
          setSyncState('synced');
        }
      } catch {
        if (alive) setSyncState('offline');
      }
    })();
    return () => {
      alive = false;
      if (budgetTimerRef.current !== null) window.clearTimeout(budgetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const update = () => {
      setChartSize({
        w: Math.max(340, Math.round(el.clientWidth || 580)),
        h: Math.max(210, Math.round(el.clientHeight || 225)),
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch real CC1101 lamp history hours for selectedMonth
  useEffect(() => {
    let alive = true;
    const range = periodRange(`${selectedMonth}-01`, 'month');
    if (!range) {
      setRealLampHours(null);
      return;
    }
    api
      .lampHistory(range.from, range.to)
      .then((res) => {
        if (!alive) return;
        if (!res.ready || !res.time_synced || !Array.isArray(res.records) || res.records.length === 0) {
          setRealLampHours(null);
          return;
        }
        const sum = summarize(res.records, range.from, range.to, res.now, res.oldest);
        if (sum.effectiveDays > 0) {
          setRealLampHours(sum.total / 3600);
        } else {
          setRealLampHours(null);
        }
      })
      .catch(() => {
        if (alive) setRealLampHours(null);
      });
    return () => {
      alive = false;
    };
  }, [selectedMonth]);

  const savedRec = useMemo(() => costData.records.find((r) => r.month === selectedMonth) || null, [costData.records, selectedMonth]);

  const prevRec = useMemo(() => {
    const idx = costData.records.findIndex((r) => r.month === selectedMonth);
    if (idx > 0) return costData.records[idx - 1];
    if (idx < 0 && costData.records.length > 0) {
      const earlier = costData.records.filter((r) => r.month < selectedMonth);
      return earlier.length ? earlier[earlier.length - 1] : null;
    }
    return null;
  }, [costData.records, selectedMonth]);

  const selectMonth = (month: string) => {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return;
    setSelectedMonth(month);
    const rec = costData.records.find((r) => r.month === month) || null;
    const idx = costData.records.findIndex((r) => r.month === month);
    const earlier = costData.records.filter((r) => r.month < month);
    const prev = idx > 0 ? costData.records[idx - 1] : earlier[earlier.length - 1] || costData.records[costData.records.length - 1] || null;
    setDraft(buildDraftFromRecord(month, rec, prev));
  };

  const stepMonth = (delta: number) => {
    if (!costData.records.length) return;
    const idx = costData.records.findIndex((r) => r.month === selectedMonth);
    if (idx < 0) {
      selectMonth(costData.records[costData.records.length - 1].month);
      return;
    }
    const nextIdx = Math.max(0, Math.min(costData.records.length - 1, idx + delta));
    selectMonth(costData.records[nextIdx].month);
  };

  const createNextMonth = () => {
    const last = costData.records[costData.records.length - 1];
    let y = 2026;
    let m = 12;
    if (last) {
      const [ly, lm] = last.month.split('-').map(Number);
      y = lm === 12 ? ly + 1 : ly;
      m = lm === 12 ? 1 : lm + 1;
    }
    const nextMonth = `${y}-${String(m).padStart(2, '0')}`;
    const nextDraft = buildDraftFromRecord(nextMonth, null, last || null);
    setSelectedMonth(nextMonth);
    setDraft(nextDraft);
    const waterHint = nextDraft.bundleParts.includes('water') ? '预计含双月水费' : '双月未交水';
    flash(`已新建 ${nextMonth} · 回填房租 ¥${last ? last.rent : 1600}（${waterHint}）`);
  };

  const updateDraft = (patch: Partial<LivingCostRecord>) => {
    setDraft((cur) => {
      const merged: LivingCostRecord = { ...cur, ...patch };
      const utilVal = merged.utilMode === 'bundle' ? merged.bundleAmount : merged.elec + merged.water + merged.gas;
      merged.utilPending = Boolean(savedRec?.utilPending && utilVal === 0);
      return merged;
    });
  };

  const setHouse = (house: LivingCostHouse) => {
    let nextRent = draft.rent;
    if (house === '旧房' && draft.rent === 1600) nextRent = 1350;
    if (house === '新房' && draft.rent === 1350) nextRent = 1600;
    updateDraft({ house, rent: nextRent });
  };

  const setUtilMode = (mode: LivingCostUtilMode) => {
    const parts = mode === 'bundle' && draft.bundleParts.length === 0 ? (['elec', 'gas'] as LivingCostPart[]) : draft.bundleParts;
    updateDraft({ utilMode: mode, bundleParts: parts });
  };

  const toggleBundlePart = (part: LivingCostPart) => {
    const parts = draft.bundleParts.includes(part) ? draft.bundleParts.filter((p) => p !== part) : [...draft.bundleParts, part];
    updateDraft({ bundleParts: parts });
  };

  const autofillLastRent = () => {
    const prev = prevRec || costData.records[costData.records.length - 1];
    if (!prev) return;
    updateDraft({ rent: prev.rent, house: prev.house });
    flash(`已回填上月房租 ¥${prev.rent}`);
  };

  const saveMonth = async () => {
    const cleanRec: LivingCostRecord = {
      ...draft,
      month: selectedMonth,
      rent: Math.max(0, Number(draft.rent) || 0),
      elec: Math.max(0, Number(draft.elec) || 0),
      water: Math.max(0, Number(draft.water) || 0),
      gas: Math.max(0, Number(draft.gas) || 0),
      bundleAmount: Math.max(0, Number(draft.bundleAmount) || 0),
      note: (draft.note || '').trim(),
    };
    const nextRecords = [...costData.records];
    const idx = nextRecords.findIndex((r) => r.month === selectedMonth);
    if (idx >= 0) nextRecords[idx] = cleanRec;
    else nextRecords.push(cleanRec);
    const nextData = cloneData({ ...costData, records: nextRecords });
    setCostData(nextData);
    setDraft(cleanRec);
    await persistRemote(nextData);
    flash(`已保存并同步 ${selectedMonth} 账单（总计 ${fmtMoney(calcTotals(cleanRec).total)}）`);
  };

  const deleteMonth = async () => {
    const idx = costData.records.findIndex((r) => r.month === selectedMonth);
    if (idx < 0) {
      flash('当前月份尚未保存', true);
      return;
    }
    const nextRecords = costData.records.filter((r) => r.month !== selectedMonth);
    const nextData = cloneData({ ...costData, records: nextRecords });
    const nextMonth = defaultSelectedMonth(nextData.records);
    setCostData(nextData);
    setSelectedMonth(nextMonth);
    const nextRec = nextData.records.find((r) => r.month === nextMonth) || null;
    const nextIdx = nextData.records.findIndex((r) => r.month === nextMonth);
    setDraft(buildDraftFromRecord(nextMonth, nextRec, nextIdx > 0 ? nextData.records[nextIdx - 1] : null));
    await persistRemote(nextData);
    flash(`已删除 ${selectedMonth} 账单记录`);
  };

  const updateBudgetField = (field: 'budgetTotal' | 'budgetUtil', val: number) => {
    const cleanVal = Math.max(0, Number(val) || 0);
    const nextData: LivingCostData = { ...costData, [field]: cleanVal };
    setCostData(nextData);
    if (budgetTimerRef.current !== null) window.clearTimeout(budgetTimerRef.current);
    budgetTimerRef.current = window.setTimeout(() => {
      persistRemote(nextData, true);
    }, 450);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(costData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lfnl-living-cost-${selectedMonth}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash('已导出生活成本 JSON 备份文件');
  };

  const importJson = async (ev: Event) => {
    const input = ev.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<LivingCostData>;
      if (!Array.isArray(parsed.records)) throw new Error('无效备份结构');
      const next = cloneData({
        budgetTotal: Number(parsed.budgetTotal ?? 1800),
        budgetUtil: Number(parsed.budgetUtil ?? 200),
        records: parsed.records as LivingCostRecord[],
      });
      setCostData(next);
      const m = defaultSelectedMonth(next.records);
      const idx = next.records.findIndex((r) => r.month === m);
      setSelectedMonth(m);
      setDraft(buildDraftFromRecord(m, next.records[idx] || null, idx > 0 ? next.records[idx - 1] : null));
      await persistRemote(next);
      flash(`已导入 ${next.records.length} 个月账单并同步至 S3`);
    } catch {
      flash('导入失败：无效的 JSON 备份文件', true);
    } finally {
      input.value = '';
    }
  };

  const handleSetChartMode = (mode: ChartMode) => {
    setChartMode(mode);
    setFocusKey(mode === 'rent' ? 'rent' : mode === 'util' ? 'bundle' : null);
  };

  const toggleFocus = (key: FocusKey) => {
    if (key === null) {
      setFocusKey(null);
      setChartMode('all');
      return;
    }
    const next = focusKey === key ? null : key;
    setFocusKey(next);
    if (!next) setChartMode('all');
    else if (next === 'rent') setChartMode('rent');
    else setChartMode('util');
  };

  // Calculations for active draft & annual summaries
  const cur = calcTotals(draft);
  const prv = prevRec ? calcTotals(prevRec) : null;

  const yearPrefix = draft.month.slice(0, 4);
  const yearRecs = costData.records.filter((r) => r.month.startsWith(yearPrefix));
  const yearTotal = yearRecs.reduce((a, r) => a + calcTotals(r).total, 0);
  const settledYearRecs = yearRecs.filter((r) => !calcTotals(r).utilPending);
  const yearOldRecs = settledYearRecs.filter((r) => r.house === '旧房');
  const yearNewRecs = settledYearRecs.filter((r) => r.house === '新房');
  const yearOldAvg = yearOldRecs.length ? yearOldRecs.reduce((a, r) => a + calcTotals(r).total, 0) / yearOldRecs.length : 0;
  const yearNewAvg = yearNewRecs.length ? yearNewRecs.reduce((a, r) => a + calcTotals(r).total, 0) / yearNewRecs.length : 0;
  const diffHousePct =
    yearOldAvg > 0 && yearNewAvg > 0 ? ` (+${(((yearNewAvg - yearOldAvg) / yearOldAvg) * 100).toFixed(1)}%)` : '';

  const totalPct = costData.budgetTotal > 0 ? Math.min(100, (cur.total / costData.budgetTotal) * 100) : 0;
  const totalOver = costData.budgetTotal > 0 && cur.total > costData.budgetTotal;
  const utilPct = costData.budgetUtil > 0 ? Math.min(100, (cur.util / costData.budgetUtil) * 100) : 0;
  const utilOver = costData.budgetUtil > 0 && cur.util > costData.budgetUtil;

  const diffStr = prv
    ? `较上月 ${cur.total - prv.total >= 0 ? '+' : ''}¥${(cur.total - prv.total).toFixed(1)} (${(
        ((cur.total - prv.total) / Math.max(1, prv.total)) *
        100
      ).toFixed(1)}%)`
    : '暂无上月对比';

  const lampHoursDisplay = realLampHours !== null ? realLampHours : draft.lampHours ?? null;
  const lampYuanStr = lampHoursDisplay !== null ? (lampHoursDisplay * 0.012 * 0.6).toFixed(2) : null;

  // Palette for inline SVG charts
  const P = chartPalette();

  // Trend chart data
  const trendItems = useMemo(() => {
    const list = costData.records.map((r) => (r.month === draft.month ? draft : r));
    if (!list.some((r) => r.month === draft.month)) {
      list.push(draft);
      list.sort((a, b) => a.month.localeCompare(b.month));
    }
    return list.slice(-12);
  }, [costData.records, draft]);

  const getChartVal = (r: LivingCostRecord) => {
    const t = calcTotals(r);
    if (chartMode === 'util') return t.util;
    if (chartMode === 'rent') return t.rent;
    return t.total;
  };

  const trendVals = trendItems.map(getChartVal);
  const trendSettled = trendItems.filter((r) => chartMode === 'rent' || !calcTotals(r).utilPending);
  const trendAvgBase = (trendSettled.length ? trendSettled : trendItems).map(getChartVal);
  const trendSum = trendVals.reduce((a, b) => a + b, 0);
  const trendAvg = trendAvgBase.length ? trendAvgBase.reduce((a, b) => a + b, 0) / trendAvgBase.length : 0;
  let peakIdx = 0;
  trendVals.forEach((v, i) => {
    if (v > trendVals[peakIdx]) peakIdx = i;
  });
  const chartOldArr = (trendSettled.length ? trendSettled : trendItems).filter((r) => r.house === '旧房').map(getChartVal);
  const chartNewArr = (trendSettled.length ? trendSettled : trendItems).filter((r) => r.house === '新房').map(getChartVal);
  const chartOldAvg = chartOldArr.length ? chartOldArr.reduce((a, b) => a + b, 0) / chartOldArr.length : null;
  const chartNewAvg = chartNewArr.length ? chartNewArr.reduce((a, b) => a + b, 0) / chartNewArr.length : null;

  const W = chartSize.w;
  const H = chartSize.h;
  const padL = 48;
  const padR = 68;
  const padT = 26;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const budgetRef = chartMode === 'all' ? costData.budgetTotal : chartMode === 'util' ? costData.budgetUtil : 0;
  const maxRaw = Math.max(...trendVals, budgetRef || 0, 50);
  const maxY = Math.ceil((maxRaw * 1.18) / 50) * 50;
  const yOf = (v: number) => padT + (1 - v / maxY) * plotH;
  const step = plotW / Math.max(1, trendItems.length);
  const barW = Math.min(34, Math.max(14, step * 0.48));
  const linePts: [number, number][] = trendItems.map((_, i) => [padL + step * i + step / 2, yOf(trendVals[i])]);

  let moveDividerIdx = -1;
  for (let i = 1; i < trendItems.length; i++) {
    if (trendItems[i - 1].house === '旧房' && trendItems[i].house === '新房') {
      moveDividerIdx = i;
      break;
    }
  }

  // Cutaway SVG helpers
  const houseLabel = draft.house || '新房';
  const rentFocused = focusKey === 'rent';
  const rentDimmed = focusKey !== null && !rentFocused;
  const rentAccent = rentFocused ? P.red : P.ink;
  const rentPct = cur.total > 0 ? (cur.rent / cur.total) * 100 : 0;
  const bundleFocused = focusKey === 'bundle' || focusKey === 'elec' || focusKey === 'water' || focusKey === 'gas';
  const bundleDimmed = focusKey !== null && !bundleFocused;
  const bundleAccent = utilOver || bundleFocused ? P.red : P.ink;
  const utilRatio = costData.budgetUtil > 0 ? Math.min(100, (cur.util / costData.budgetUtil) * 100) : 50;

  const deltaStr = (a: number, b: number | null | undefined) => {
    if (b === null || b === undefined || b <= 0) return '对比缺失';
    const pct = ((a - b) / b) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  };
  const bundleDeltaLbl = cur.utilPending ? '待出账' : `环比 ${deltaStr(cur.util, prv ? prv.util : null)}`;

  const focusLabels: Record<Exclude<FocusKey, null>, string> = {
    rent: '已聚焦：房租',
    elec: '已聚焦：电费',
    water: '已聚焦：水费',
    gas: '已聚焦：燃气',
    bundle: '已聚焦：水电气',
  };

  const syncTagText =
    syncState === 'synced'
      ? 'S3 Flash 已同步'
      : syncState === 'saving'
        ? '同步中...'
        : syncState === 'offline'
          ? '离线缓存模式'
          : '读取中...';

  const modeTitleMap: Record<ChartMode, string> = {
    all: '03 / 年度 12 个月费用趋势（全部总计：房租 + 水电气）',
    util: '03 / 年度 12 个月水电气趋势（斜纹=分项 · 实黑=打包）',
    rent: '03 / 年度房租变化趋势（6月底换新房 1350 → 1600）',
  };

  return (
    <>
      <header class="view-header">
        <div>
          <div class="eyebrow">LIVING COST · 居所能耗与生活成本</div>
          <h1 class="view-title">生活成本与居所能耗</h1>
        </div>
        <div class="btn-row">
          <span class={`tag ${syncState === 'offline' ? 'red' : syncState === 'synced' ? 'dark' : ''}`}>{syncTagText}</span>
          <button class="btn" style={{ padding: '5px 10px' }} onClick={() => stepMonth(-1)}>
            ◀
          </button>
          <span class="tag dark num">{selectedMonth}</span>
          <button class="btn" style={{ padding: '5px 10px' }} onClick={() => stepMonth(1)}>
            ▶
          </button>
          <button class="btn btn-primary" onClick={createNextMonth}>
            + 新增下月
          </button>
          <button class="btn" onClick={exportJson}>
            导出 JSON
          </button>
          <button class="btn" onClick={() => fileInputRef.current?.click()}>
            导入 JSON
          </button>
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importJson} />
        </div>
      </header>

      {notice && <div class={`alert ${notice.err ? 'alert-err' : 'alert-ok'}`}>{notice.text}</div>}

      {/* Top 4 KPI Cards */}
      <div class="grid g-4">
        <div class="card">
          <div class="card-head">
            <span class="card-title">当月总成本</span>
            <span class={`tag num ${totalOver ? 'red' : 'dark'}`}>
              {totalOver ? `超预算 +¥${(cur.total - costData.budgetTotal).toFixed(0)}` : `预算内 ${Math.round(totalPct)}%`}
            </span>
          </div>
          <div class="kpi-val num">{fmtMoney(cur.total)}</div>
          <div class="kpi-sub num">
            {diffStr} · 日均 ¥{(cur.total / 30).toFixed(1)}
          </div>
          <div class="meter">
            <div class={`meter-fill ${totalOver ? 'red' : ''}`} style={{ width: `${totalPct.toFixed(1)}%` }} />
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">水电气小计（可变）</span>
            <span class={`tag num ${utilOver ? 'red' : ''}`}>
              {cur.utilPending
                ? '次月结算'
                : utilOver
                  ? `超水电气线 +¥${(cur.util - costData.budgetUtil).toFixed(0)}`
                  : `占 ${(cur.total > 0 ? (cur.util / cur.total) * 100 : 0).toFixed(1)}%`}
            </span>
          </div>
          <div class="kpi-val num">{cur.utilPending ? '待出账' : fmtMoney(cur.util)}</div>
          <div class="kpi-sub num">
            {cur.utilPending
              ? `预计含：${formatBundlePartsText(cur.bundleParts)}（下月初缴费后录入）`
              : cur.isBundle
                ? `打包：${formatBundlePartsText(cur.bundleParts)}${cur.bundleParts.includes('water') ? '' : ' · 双月未交水'}`
                : `电 ¥${cur.elec.toFixed(1)} · 水 ¥${cur.water.toFixed(1)} · 气 ¥${cur.gas.toFixed(1)}`}
          </div>
          <div class="meter">
            <div class={`meter-fill ${utilOver ? 'red' : 'gray'}`} style={{ width: `${utilPct.toFixed(1)}%` }} />
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">年度累计 · 新旧房对比</span>
            <span class="tag num">
              {yearPrefix} · {yearRecs.length} 个月
            </span>
          </div>
          <div class="kpi-val num">¥ {Math.round(yearTotal).toLocaleString('zh-CN')}</div>
          <div class="kpi-sub num">
            {yearOldAvg > 0 && yearNewAvg > 0
              ? `旧房均 ¥${yearOldAvg.toFixed(0)} → 新房均 ¥${yearNewAvg.toFixed(0)}${diffHousePct}`
              : `月均 ¥${(yearTotal / Math.max(1, yearRecs.length)).toFixed(1)}`}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">照明电费对照彩蛋</span>
            <span class="tag red">CC1101 实测</span>
          </div>
          <div class="kpi-val num">
            {lampHoursDisplay !== null ? (
              <>
                {lampHoursDisplay.toFixed(1)}
                <span class="kpi-unit">小时</span>
              </>
            ) : (
              '--'
            )}
          </div>
          <div class="kpi-sub num">
            {lampYuanStr !== null
              ? `当月台灯亮灯 · 约合电费 ¥${lampYuanStr}（按 12W）`
              : '该历史月暂无 CC1101 亮灯记录'}
          </div>
        </div>
      </div>

      {/* Main Row: Architectural Utility Cutaway SVG + Manual Entry & Budget Guard */}
      <div class="grid g-cost-top">
        <div class="card" style={{ minHeight: 0 }}>
          <div class="card-head">
            <span class="card-title">
              01 / 居所管线剖面图 · {draft.month} ({houseLabel})
            </span>
            <div class="btn-row" style={{ alignItems: 'center' }}>
              <span class="tag">
                {focusKey ? focusLabels[focusKey] : cur.isBundle ? '水电气打包汇流' : '分项 4 条管线'}
              </span>
              <button class="btn" style={{ padding: '3px 9px', fontSize: '11.5px' }} onClick={() => toggleFocus(null)}>
                重置筛选
              </button>
            </div>
          </div>

          <div class="topo-map-wrap">
            <svg class="topo-map-svg" viewBox="0 0 660 336" preserveAspectRatio="xMidYMid meet">
              <defs>
                <pattern id="cost-cad-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <path d="M 20 0 L 0 0 0 20" fill="none" stroke={P.frame} stroke-width="0.55" opacity="0.55" />
                </pattern>
                <pattern id="cost-roof-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="6" stroke={P.lbl} stroke-width="0.9" opacity="0.32" />
                </pattern>
                <pattern id="cost-glass-hatch" width="8" height="8" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="8" stroke={P.lbl} stroke-width="0.7" opacity="0.2" />
                </pattern>
              </defs>

              <rect width="660" height="336" fill="url(#cost-cad-grid)" />

              {/* Left Architectural Cutaway */}
              <g>
                <line x1="16" y1="92" x2="256" y2="92" stroke={P.frame} stroke-width="0.8" stroke-dasharray="3 3" />
                <text x="16" y="88" font-size="8.5" fill={P.lbl} font-weight="600">
                  3F
                </text>
                <line x1="16" y1="168" x2="256" y2="168" stroke={P.red} stroke-width="0.9" stroke-dasharray="3 3" opacity="0.55" />
                <text x="16" y="164" font-size="8.5" fill={P.red} font-weight="700">
                  2F
                </text>
                <line x1="16" y1="238" x2="256" y2="238" stroke={P.frame} stroke-width="0.8" stroke-dasharray="3 3" />
                <text x="16" y="234" font-size="8.5" fill={P.lbl} font-weight="600">
                  1F
                </text>
                <line x1="16" y1="296" x2="262" y2="296" stroke={P.ink} stroke-width="1.6" />
                <text x="16" y="310" font-size="8.5" fill={P.ink} font-weight="700">
                  G ±0.0m · {houseLabel}剖面
                </text>

                <polygon points="40,80 68,42 222,42 246,80" fill="url(#cost-roof-hatch)" stroke={P.ink} stroke-width="1.5" />
                <rect x="46" y="80" width="194" height="216" fill={P.bg} stroke={P.ink} stroke-width="1.7" />

                <line x1="46" y1="116" x2="240" y2="116" stroke={P.ink} stroke-width="1.2" />
                <rect
                  x="64"
                  y="88"
                  width="158"
                  height="20"
                  fill={houseLabel === '新房' ? P.tagRedBg : 'url(#cost-glass-hatch)'}
                  stroke={houseLabel === '新房' ? P.red : P.tick}
                  stroke-width="1"
                />
                <text x="143" y="101" text-anchor="middle" font-size="8.5" fill={houseLabel === '新房' ? P.red : P.sec} font-weight="700">
                  {houseLabel} · {draft.month}
                </text>

                <line x1="46" y1="186" x2="240" y2="186" stroke={P.ink} stroke-width="1.4" />
                <rect x="58" y="128" width="76" height="46" fill="url(#cost-glass-hatch)" stroke={P.tick} stroke-width="1" />
                <line x1="146" y1="170" x2="224" y2="170" stroke={P.ink} stroke-width="1.6" />
                <line x1="154" y1="170" x2="154" y2="186" stroke={P.ink} stroke-width="1.3" />
                <line x1="216" y1="170" x2="216" y2="186" stroke={P.ink} stroke-width="1.3" />
                <path d="M 176,170 L 176,154 L 188,144 L 198,150" fill="none" stroke={P.ink} stroke-width="1.4" stroke-linecap="round" />
                <circle class="topo-beacon-ring" cx="198" cy="152" r="7" fill="none" stroke={P.red} stroke-width="1.2" />
                <circle cx="198" cy="152" r="3" fill={P.red} />
                <text x="64" y="141" font-size="8.5" font-weight="700" fill={P.ink}>
                  2F 主卧 · S3
                </text>
                <text x="64" y="153" font-size="8" fill={P.sec}>
                  {lampHoursDisplay !== null ? `台灯 ${lampHoursDisplay.toFixed(0)}h` : 'CC1101 在线'}
                </text>

                <rect x="58" y="198" width="74" height="44" fill={P.tagBg} stroke={P.tick} stroke-width="1" />
                <text x="95" y="216" text-anchor="middle" font-size="8.5" font-weight="600" fill={P.ink}>
                  给水(双月)
                </text>
                <path d="M 86,227 C 90,223 94,231 98,227 C 102,223 106,231 110,227" fill="none" stroke={P.sec} stroke-width="1.2" />

                <rect x="148" y="198" width="78" height="44" fill={P.tagBg} stroke={P.tick} stroke-width="1" />
                <text x="187" y="216" text-anchor="middle" font-size="8.5" font-weight="600" fill={P.ink}>
                  {houseLabel === '旧房' ? '无燃气管线' : '燃气热源'}
                </text>
                {houseLabel === '旧房' ? (
                  <line x1="172" y1="227" x2="202" y2="227" stroke={P.lbl} stroke-width="1" stroke-dasharray="2 2" />
                ) : (
                  <path d="M 187,223 C 191,227 191,232 187,234 C 183,232 183,227 187,223 Z" fill="none" stroke={P.red} stroke-width="1.2" />
                )}

                <rect x="58" y="254" width="168" height="32" rx="3" fill={totalOver ? P.red : P.ink} />
                <text x="68" y="268" font-size="8.5" fill={totalOver ? '#ffffff' : P.dotBg} opacity="0.78">
                  本月总计 · TOTAL
                </text>
                <text x="68" y="280" font-size="11.5" font-weight="700" fill={totalOver ? '#ffffff' : P.dotBg} font-variant-numeric="tabular-nums">
                  {fmtMoney(cur.total)}
                </text>
                <text x="216" y="274" text-anchor="end" font-size="9" font-weight="700" fill={totalOver ? '#ffffff' : P.dotBg}>
                  {totalOver ? '超预算!' : '正常'}
                </text>
              </g>

              {/* Top 01 / RENT conduit */}
              <g class={`cost-pipe-group ${rentDimmed ? 'dimmed' : ''}`} onClick={() => toggleFocus('rent')}>
                <path d="M 240,74 L 286,74 L 286,54 L 392,54" fill="none" stroke={P.frame} stroke-width="4.4" stroke-linejoin="round" />
                <path d="M 240,74 L 286,74 L 286,54 L 392,54" fill="none" stroke={rentAccent} stroke-width="2.4" stroke-linejoin="round" />
                <circle cx="240" cy="74" r="3.4" fill={P.dotBg} stroke={rentAccent} stroke-width="1.6" />
                <circle cx="392" cy="54" r="3.4" fill={rentAccent} />
                <rect x="396" y="24" width="244" height="60" rx="4" fill={P.bg} stroke={rentFocused ? P.red : P.frame} stroke-width={rentFocused ? '1.6' : '1.1'} />
                <path d="M 396,32 L 396,24 L 404,24" fill="none" stroke={rentAccent} stroke-width="1.6" />
                <text x="408" y="41" font-size="9.5" font-weight="700" fill={rentFocused ? P.red : P.sec} letter-spacing="0.06em">
                  01 / RENT · 房租均摊 ({houseLabel})
                </text>
                <text x="628" y="41" text-anchor="end" font-size="9.5" font-weight="600" fill={P.lbl} font-variant-numeric="tabular-nums">
                  {rentPct.toFixed(1)}%
                </text>
                <text x="408" y="64" font-size="16" font-weight="700" fill={P.ink} font-variant-numeric="tabular-nums">
                  {fmtMoney(cur.rent)}
                </text>
                <text x="628" y="62" text-anchor="end" font-size="9" fill={P.lbl}>
                  {houseLabel === '旧房' ? '季付均摊 1350/月' : '押一付三均摊 1600/月'}
                </text>
                <rect x="408" y="72" width="220" height="3.5" rx="1" fill={P.frame} />
                <rect x="408" y="72" width={(2.2 * Math.min(100, rentPct)).toFixed(1)} height="3.5" rx="1" fill={rentAccent} />
              </g>

              {cur.isBundle ? (
                <g class={`cost-pipe-group ${bundleDimmed ? 'dimmed' : ''}`} onClick={() => toggleFocus('bundle')}>
                  {[
                    { k: 'elec' as LivingCostPart, lbl: '2F 电', y: 136 },
                    { k: 'water' as LivingCostPart, lbl: '1F 水', y: 196 },
                    { k: 'gas' as LivingCostPart, lbl: '1F 气', y: 254 },
                  ].map((br) => {
                    const active = cur.bundleParts.includes(br.k);
                    const brStroke = active ? bundleAccent : P.tick;
                    return (
                      <g key={br.k}>
                        <line
                          x1="240"
                          y1={br.y}
                          x2="342"
                          y2={br.y}
                          stroke={brStroke}
                          stroke-width={active ? '2.1' : '1.1'}
                          stroke-dasharray={active ? '5 3' : '2 4'}
                          opacity={active ? undefined : '0.5'}
                          class={active ? 'bp-bus-flow' : undefined}
                        />
                        <circle cx="240" cy={br.y} r="3.2" fill={P.dotBg} stroke={brStroke} stroke-width="1.5" />
                        <circle cx="342" cy={br.y} r={active ? '3.4' : '2.4'} fill={active ? brStroke : P.bg} stroke={brStroke} stroke-width="1.2" />
                        <text x="290" y={br.y - 6} text-anchor="middle" font-size="8.5" font-weight={active ? '600' : '400'} fill={active ? P.sec : P.lbl}>
                          {br.lbl}
                          {active ? '' : ' (未计)'}
                        </text>
                      </g>
                    );
                  })}

                  <line x1="342" y1="136" x2="342" y2="254" stroke={bundleAccent} stroke-width="3" stroke-linecap="round" />
                  <rect x="336" y="186" width="12" height="18" rx="2" fill={bundleAccent} />
                  <line x1="348" y1="195" x2="392" y2="195" stroke={bundleAccent} stroke-width="3" stroke-dasharray="5 3" class="bp-bus-flow" />
                  <circle cx="392" cy="195" r="4" fill={bundleAccent} />

                  <rect
                    x="396"
                    y="114"
                    width="244"
                    height="186"
                    rx="4"
                    fill={P.bg}
                    stroke={utilOver || bundleFocused ? P.red : P.frame}
                    stroke-width={utilOver || bundleFocused ? '1.6' : '1.2'}
                  />
                  <path d="M 396,124 L 396,114 L 406,114" fill="none" stroke={bundleAccent} stroke-width="1.8" />
                  <text x="410" y="135" font-size="10" font-weight="700" fill={utilOver || bundleFocused ? P.red : P.sec} letter-spacing="0.04em">
                    02 / BUNDLE · 水电气打包
                  </text>
                  <text x="626" y="135" text-anchor="end" font-size="9.5" font-weight="600" fill={utilOver ? P.red : P.lbl} font-variant-numeric="tabular-nums">
                    {bundleDeltaLbl}
                  </text>

                  {cur.utilPending ? (
                    <>
                      <text x="410" y="168" font-size="18" font-weight="700" fill={P.lbl}>
                        待次月出账
                      </text>
                      <text x="410" y="186" font-size="10.5" fill={P.sec}>
                        本月水电气将于次月缴费后录入
                      </text>
                    </>
                  ) : (
                    <>
                      <text x="410" y="168" font-size="24" font-weight="700" fill={utilOver ? P.red : P.ink} font-variant-numeric="tabular-nums">
                        {fmtMoney(cur.util)}
                      </text>
                      <text x="410" y="186" font-size="10.5" fill={P.sec}>
                        本笔合并：{formatBundlePartsText(cur.bundleParts)}
                      </text>
                    </>
                  )}

                  {[
                    { k: 'elec' as LivingCostPart, txt: '电费', x: 410 },
                    { k: 'water' as LivingCostPart, txt: '水·双月', x: 485 },
                    { k: 'gas' as LivingCostPart, txt: '燃气', x: 560 },
                  ].map((cd) => {
                    const on = cur.bundleParts.includes(cd.k);
                    return (
                      <g key={cd.k}>
                        <rect x={cd.x} y="200" width="66" height="22" rx="3" fill={on ? P.ink : P.tagBg} stroke={on ? P.ink : P.tick} stroke-width="1" />
                        <text x={cd.x + 33} y="214.5" text-anchor="middle" font-size="9.5" font-weight={on ? '700' : '400'} fill={on ? P.dotBg : P.lbl}>
                          {on ? '✓ ' : '— '}
                          {cd.txt}
                        </text>
                      </g>
                    );
                  })}

                  <text x="410" y="244" font-size="9.5" fill={P.lbl}>
                    预算警戒对比：{fmtMoney(cur.util)} / ¥{costData.budgetUtil}
                  </text>
                  <rect x="410" y="252" width="216" height="5" rx="1.5" fill={P.frame} />
                  <rect x="410" y="252" width={(2.16 * utilRatio).toFixed(1)} height="5" rx="1.5" fill={utilOver ? P.red : P.ink} />
                  <text x="410" y="280" font-size="9.5" fill={P.sec}>
                    {lampHoursDisplay !== null ? `台灯实测 ${lampHoursDisplay.toFixed(1)}h · ` : ''}占当月总支{' '}
                    {(cur.total > 0 ? (cur.util / cur.total) * 100 : 0).toFixed(1)}%
                  </text>
                </g>
              ) : (
                <>
                  {[
                    {
                      key: 'elec' as const,
                      code: '02 / ELEC',
                      label: '电费 (月付)',
                      val: cur.elec,
                      yPipe: 132,
                      yHouse: 136,
                      sub: lampHoursDisplay !== null ? `台灯实测 ${lampHoursDisplay.toFixed(1)}h` : '月度用电抄表',
                      dash: '5 3',
                      active: cur.elec > 0,
                    },
                    {
                      key: 'water' as const,
                      code: '03 / WATER',
                      label: '水费 (双月)',
                      val: cur.water,
                      yPipe: 210,
                      yHouse: 196,
                      sub: cur.water > 0 ? '双月抄表缴费' : '本月双月轮空未交',
                      dash: '3 4',
                      active: cur.water > 0,
                    },
                    {
                      key: 'gas' as const,
                      code: '04 / GAS',
                      label: '燃气费',
                      val: cur.gas,
                      yPipe: 288,
                      yHouse: 254,
                      sub: houseLabel === '旧房' ? '旧房无燃气' : cur.gas > 0 ? '热水与灶具' : '本月 ¥0',
                      dash: '7 3',
                      active: cur.gas > 0,
                    },
                  ].map((it, idx) => {
                    const isFocused = focusKey === it.key;
                    const isDimmed = focusKey !== null && !isFocused;
                    const alert = utilOver && it.active;
                    const accent = alert || isFocused ? P.red : it.active ? P.ink : P.tick;
                    const strokeW = it.active ? Math.max(1.6, Math.min(3.4, 1.4 + (it.val / Math.max(cur.util, 50)) * 2.2)) : 1.1;
                    const midX = 310 + idx * 24;
                    const pathD = `M 240,${it.yHouse} L ${midX},${it.yHouse} L ${midX},${it.yPipe} L 392,${it.yPipe}`;
                    const barPct = cur.util > 0 ? (it.val / cur.util) * 100 : 0;

                    return (
                      <g key={it.key} class={`cost-pipe-group ${isDimmed ? 'dimmed' : ''}`} onClick={() => toggleFocus(it.key)}>
                        <path d={pathD} fill="none" stroke={P.frame} stroke-width={(strokeW + 1.8).toFixed(1)} stroke-linejoin="round" opacity={it.active ? undefined : '0.45'} />
                        <path
                          d={pathD}
                          fill="none"
                          stroke={accent}
                          stroke-width={strokeW.toFixed(1)}
                          stroke-linejoin="round"
                          stroke-dasharray={it.dash}
                          class={it.active ? 'bp-bus-flow' : undefined}
                          opacity={it.active ? undefined : '0.55'}
                        />
                        <circle cx="240" cy={it.yHouse} r="3.2" fill={P.dotBg} stroke={accent} stroke-width="1.5" />
                        <circle cx="392" cy={it.yPipe} r="3.2" fill={accent} />
                        <rect
                          x="396"
                          y={it.yPipe - 30}
                          width="244"
                          height="60"
                          rx="4"
                          fill={P.bg}
                          stroke={isFocused || alert ? P.red : P.frame}
                          stroke-width={isFocused || alert ? '1.6' : '1.1'}
                          opacity={it.active ? undefined : '0.72'}
                        />
                        <path d={`M 396,${it.yPipe - 22} L 396,${it.yPipe - 30} L 404,${it.yPipe - 30}`} fill="none" stroke={accent} stroke-width="1.6" />
                        <text x="408" y={it.yPipe - 13} font-size="9.5" font-weight="700" fill={isFocused || alert ? P.red : P.sec} letter-spacing="0.06em">
                          {it.code} · {it.label}
                        </text>
                        <text x="628" y={it.yPipe - 13} text-anchor="end" font-size="9.5" font-weight="600" fill={P.lbl} font-variant-numeric="tabular-nums">
                          {it.active ? (cur.total > 0 ? `${((it.val / cur.total) * 100).toFixed(1)}%` : '0%') : '未产生'}
                        </text>
                        <text x="408" y={it.yPipe + 10} font-size="16" font-weight="700" fill={it.active ? P.ink : P.lbl} font-variant-numeric="tabular-nums">
                          {fmtMoney(it.val)}
                        </text>
                        <text x="628" y={it.yPipe + 8} text-anchor="end" font-size="9" fill={P.lbl}>
                          {it.sub}
                        </text>
                        <rect x="408" y={it.yPipe + 18} width="220" height="3.5" rx="1" fill={P.frame} />
                        <rect x="408" y={it.yPipe + 18} width={(2.2 * Math.min(100, barPct)).toFixed(1)} height="3.5" rx="1" fill={accent} />
                      </g>
                    );
                  })}
                </>
              )}
            </svg>
            <div class="topo-meta-bar">
              <span>
                交互提示：<strong style={{ color: 'var(--text)' }}>点击管线或仪表块可联动高亮；水电气按消费月归属（次月实缴），水费双月计费</strong>
              </span>
              <span class="num">
                预算警戒：总 ¥{costData.budgetTotal.toLocaleString('zh-CN')} / 水电气 ¥{costData.budgetUtil}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Manual Entry + Budget Settings */}
        <div class="card" style={{ justifyContent: 'space-between' }}>
          <div>
            <div class="card-head">
              <span class="card-title">02 / 月度账单录入（分项 / 打包双模式）</span>
              <span class="tag num">{savedRec ? `编辑 ${selectedMonth}` : `新建 ${selectedMonth}`}</span>
            </div>

            <div class="grid g-2" style={{ gap: '10px', marginBottom: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>消费归属月 (YYYY-MM)</label>
                <input
                  class="input num"
                  type="month"
                  value={selectedMonth}
                  onInput={(e) => selectMonth((e.currentTarget as HTMLInputElement).value)}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>居所阶段</label>
                <div class="cost-seg">
                  <button type="button" class={`cost-seg-btn ${draft.house === '旧房' ? 'active' : ''}`} onClick={() => setHouse('旧房')}>
                    旧房 (1350)
                  </button>
                  <button type="button" class={`cost-seg-btn ${draft.house === '新房' ? 'active' : ''}`} onClick={() => setHouse('新房')}>
                    新房 (1600)
                  </button>
                </div>
              </div>
            </div>

            <div class="grid g-2" style={{ gap: '10px', marginBottom: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>房租均摊 (¥)</label>
                <input
                  class="input num"
                  type="number"
                  step="10"
                  min="0"
                  value={draft.rent}
                  onInput={(e) => updateDraft({ rent: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>月度备注（可选）</label>
                <input
                  class="input"
                  value={draft.note || ''}
                  placeholder="如：次月实缴 / 双月水费"
                  onInput={(e) => updateDraft({ note: (e.currentTarget as HTMLInputElement).value })}
                />
              </div>
            </div>

            <div class="field" style={{ marginBottom: '10px' }}>
              <label>水电气录入模式</label>
              <div class="cost-seg">
                <button
                  type="button"
                  class={`cost-seg-btn ${draft.utilMode === 'split' ? 'active' : ''}`}
                  onClick={() => setUtilMode('split')}
                >
                  分项填写（电 / 水 / 气）
                </button>
                <button
                  type="button"
                  class={`cost-seg-btn ${draft.utilMode === 'bundle' ? 'active' : ''}`}
                  onClick={() => setUtilMode('bundle')}
                >
                  打包合并（一笔总账）
                </button>
              </div>
            </div>

            {draft.utilMode === 'split' ? (
              <div class="grid g-3" style={{ gap: '10px' }}>
                <div class="field" style={{ marginBottom: 0 }}>
                  <label>电费 (¥)</label>
                  <input
                    class="input num"
                    type="number"
                    step="0.01"
                    min="0"
                    value={draft.elec}
                    onInput={(e) => updateDraft({ elec: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
                  />
                </div>
                <div class="field" style={{ marginBottom: 0 }}>
                  <label>水费·双月 (¥)</label>
                  <input
                    class="input num"
                    type="number"
                    step="0.01"
                    min="0"
                    value={draft.water}
                    onInput={(e) => updateDraft({ water: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
                  />
                </div>
                <div class="field" style={{ marginBottom: 0 }}>
                  <label>燃气费 (¥)</label>
                  <input
                    class="input num"
                    type="number"
                    step="0.01"
                    min="0"
                    value={draft.gas}
                    onInput={(e) => updateDraft({ gas: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
                  />
                </div>
              </div>
            ) : (
              <div>
                <div class="field" style={{ marginBottom: '4px' }}>
                  <label>水电气打包金额 (¥)</label>
                  <input
                    class="input num"
                    type="number"
                    step="0.01"
                    min="0"
                    value={draft.bundleAmount}
                    onInput={(e) => updateDraft({ bundleAmount: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
                  />
                </div>
                <div class="cost-chip-row">
                  <button
                    type="button"
                    class={`cost-chip ${draft.bundleParts.includes('elec') ? 'on' : ''}`}
                    onClick={() => toggleBundlePart('elec')}
                  >
                    {draft.bundleParts.includes('elec') ? '✓ 含电费' : '电费'}
                  </button>
                  <button
                    type="button"
                    class={`cost-chip ${draft.bundleParts.includes('water') ? 'on' : ''}`}
                    onClick={() => toggleBundlePart('water')}
                  >
                    {draft.bundleParts.includes('water') ? '✓ 含水费（双月）' : '水费（双月）'}
                  </button>
                  <button
                    type="button"
                    class={`cost-chip ${draft.bundleParts.includes('gas') ? 'on' : ''}`}
                    onClick={() => toggleBundlePart('gas')}
                  >
                    {draft.bundleParts.includes('gas') ? '✓ 含燃气' : '燃气'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px dashed var(--line)', paddingTop: '12px', marginTop: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)' }}>月度预算警戒线（超标亮信号红）</span>
              <span class={`tag num ${totalOver || utilOver ? 'red' : 'dark'}`}>{totalOver || utilOver ? '触发超支告警' : '预算内正常'}</span>
            </div>
            <div class="grid g-2" style={{ gap: '10px' }}>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>总支出警戒线 (¥)</label>
                <input
                  class="input num"
                  type="number"
                  step="50"
                  min="0"
                  value={costData.budgetTotal}
                  onInput={(e) => updateBudgetField('budgetTotal', Number((e.currentTarget as HTMLInputElement).value))}
                />
              </div>
              <div class="field" style={{ marginBottom: 0 }}>
                <label>水电气警戒线 (¥)</label>
                <input
                  class="input num"
                  type="number"
                  step="10"
                  min="0"
                  value={costData.budgetUtil}
                  onInput={(e) => updateBudgetField('budgetUtil', Number((e.currentTarget as HTMLInputElement).value))}
                />
              </div>
            </div>

            <div
              class="btn-row"
              style={{ justifyContent: 'space-between', marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed var(--line)' }}
            >
              <button class="btn btn-danger" onClick={deleteMonth}>
                删除本月
              </button>
              <div class="btn-row">
                <button class="btn" onClick={autofillLastRent}>
                  回填上月房租
                </button>
                <button class="btn btn-primary" onClick={saveMonth}>
                  保存本月账单
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Row: 12-Month Trend Chart + Monthly Ledger Table */}
      <div class="grid g-cost-bot">
        <div class="card">
          <div class="card-head">
            <span class="card-title">{modeTitleMap[chartMode]}</span>
            <div class="btn-row">
              <button
                class={`btn ${chartMode === 'all' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 10px', fontSize: '11.5px' }}
                onClick={() => handleSetChartMode('all')}
              >
                全部总计
              </button>
              <button
                class={`btn ${chartMode === 'util' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 10px', fontSize: '11.5px' }}
                onClick={() => handleSetChartMode('util')}
              >
                仅水电气
              </button>
              <button
                class={`btn ${chartMode === 'rent' ? 'btn-primary' : ''}`}
                style={{ padding: '4px 10px', fontSize: '11.5px' }}
                onClick={() => handleSetChartMode('rent')}
              >
                仅房租
              </button>
            </div>
          </div>

          <div class="chart-stats">
            <span class="chart-stat-item">
              区间累计 <strong class="num">{fmtMoney(trendSum)}</strong>
            </span>
            <span class="chart-stat-item">
              月均 <strong class="num">{fmtMoney(trendAvg)}</strong>
            </span>
            {chartOldAvg !== null && (
              <span class="chart-stat-item">
                旧房均 <strong class="num">{fmtMoney(chartOldAvg)}</strong>
              </span>
            )}
            {chartNewAvg !== null && (
              <span class="chart-stat-item">
                新房均 <strong class="num">{fmtMoney(chartNewAvg)}</strong>
              </span>
            )}
            {trendItems[peakIdx] && (
              <span class="chart-stat-item">
                峰值{' '}
                <strong class="num red">
                  {trendItems[peakIdx].month} · {fmtMoney(trendVals[peakIdx])}
                </strong>
              </span>
            )}
          </div>

          <div class="bar-chart-wrap" ref={chartWrapRef} style={{ minHeight: '220px' }}>
            <svg class="chart-svg" viewBox={`0 0 ${W} ${H}`}>
              <defs>
                <pattern id="cost-bar-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="5" stroke={P.ink} stroke-opacity="0.22" stroke-width="1" />
                </pattern>
              </defs>

              {[0, 1, 2, 3].map((i) => {
                const val = (maxY / 3) * i;
                const y = yOf(val);
                return (
                  <g key={i}>
                    <line x1={padL} y1={y.toFixed(1)} x2={padL + plotW} y2={y.toFixed(1)} stroke={P.gridH} stroke-dasharray="2 3" stroke-width="1" />
                    <text x={padL - 6} y={(y + 3.5).toFixed(1)} text-anchor="end" font-size="10" fill={P.lbl} font-variant-numeric="tabular-nums">
                      ¥{Math.round(val)}
                    </text>
                  </g>
                );
              })}

              <line x1={padL} y1={(padT + plotH).toFixed(1)} x2={padL + plotW} y2={(padT + plotH).toFixed(1)} stroke={P.frame} stroke-width="1" />

              {budgetRef > 0 && budgetRef <= maxY && (
                <g>
                  <line
                    x1={padL}
                    y1={yOf(budgetRef).toFixed(1)}
                    x2={padL + plotW}
                    y2={yOf(budgetRef).toFixed(1)}
                    stroke={P.red}
                    stroke-dasharray="5 3"
                    stroke-width="1.2"
                    opacity="0.8"
                  />
                  <rect x={padL + plotW + 5} y={(yOf(budgetRef) - 8).toFixed(1)} width="58" height="16" rx="3" fill={P.tagRedBg} stroke={P.red} stroke-width="1" />
                  <text x={padL + plotW + 34} y={(yOf(budgetRef) + 3.5).toFixed(1)} text-anchor="middle" font-size="9.5" fill={P.red} font-weight="700">
                    线 ¥{budgetRef}
                  </text>
                </g>
              )}

              <line x1={padL} y1={yOf(trendAvg).toFixed(1)} x2={padL + plotW} y2={yOf(trendAvg).toFixed(1)} stroke={P.sec} stroke-dasharray="3 3" stroke-width="1" />
              {(!budgetRef || Math.abs(yOf(trendAvg) - yOf(budgetRef)) > 18) && (
                <g>
                  <rect x={padL + plotW + 5} y={(yOf(trendAvg) - 8).toFixed(1)} width="58" height="16" rx="3" fill={P.tagBg} stroke={P.tick} stroke-width="1" />
                  <text x={padL + plotW + 34} y={(yOf(trendAvg) + 3.5).toFixed(1)} text-anchor="middle" font-size="9.5" fill={P.sec} font-weight="600">
                    均 ¥{Math.round(trendAvg)}
                  </text>
                </g>
              )}

              {moveDividerIdx > 0 && (
                <g>
                  <line
                    x1={(padL + step * moveDividerIdx).toFixed(1)}
                    y1={padT}
                    x2={(padL + step * moveDividerIdx).toFixed(1)}
                    y2={(padT + plotH).toFixed(1)}
                    stroke={P.red}
                    stroke-dasharray="4 3"
                    stroke-width="1.2"
                    opacity="0.75"
                  />
                  <rect
                    x={(padL + step * moveDividerIdx - 46).toFixed(1)}
                    y={(padT - 17).toFixed(1)}
                    width="92"
                    height="15"
                    rx="2.5"
                    fill={P.tagRedBg}
                    stroke={P.red}
                    stroke-width="0.9"
                  />
                  <text x={(padL + step * moveDividerIdx).toFixed(1)} y={(padT - 6.5).toFixed(1)} text-anchor="middle" font-size="9" font-weight="700" fill={P.red}>
                    换新房 1350→1600
                  </text>
                </g>
              )}

              {trendItems.map((r, i) => {
                const t = calcTotals(r);
                const val = trendVals[i];
                const cx = padL + step * i + step / 2;
                const x = cx - barW / 2;
                const yTop = yOf(val);
                const baseH = padT + plotH;
                const isSelected = r.month === selectedMonth;
                const isOver = budgetRef > 0 && val > budgetRef;
                const isPeak = i === peakIdx && val > 0;
                const shortLbl = `${r.month.slice(5)}月`;
                const valLbl =
                  t.utilPending && chartMode === 'util'
                    ? '待出账'
                    : t.utilPending && chartMode === 'all'
                      ? `${Math.round(val)}*`
                      : `${Math.round(val)}`;
                const lblY = t.utilPending && chartMode === 'util' ? baseH - 22 : yTop - 7;

                return (
                  <g
                    key={r.month}
                    style={{ cursor: 'pointer' }}
                    onClick={() => selectMonth(r.month)}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
                  >
                    {chartMode === 'all' ? (
                      <>
                        <rect
                          x={x.toFixed(1)}
                          y={yOf(t.rent).toFixed(1)}
                          width={barW.toFixed(1)}
                          height={Math.max(0, baseH - yOf(t.rent)).toFixed(1)}
                          fill="url(#cost-bar-hatch)"
                          stroke={isSelected ? P.ink : P.tick}
                          stroke-width="1.1"
                        />
                        {Math.max(t.util > 0 ? 2 : 0, yOf(t.rent) - yTop) > 0 && (
                          <rect
                            x={x.toFixed(1)}
                            y={yTop.toFixed(1)}
                            width={barW.toFixed(1)}
                            height={Math.max(t.util > 0 ? 2 : 0, yOf(t.rent) - yTop).toFixed(1)}
                            rx="2"
                            fill={isOver || isPeak ? P.red : P.ink}
                            stroke={isOver || isPeak ? P.red : P.ink}
                            stroke-width="1.1"
                          />
                        )}
                      </>
                    ) : chartMode === 'util' ? (
                      t.utilPending ? (
                        <rect x={x.toFixed(1)} y={(baseH - 16).toFixed(1)} width={barW.toFixed(1)} height="16" rx="2" fill="none" stroke={P.tick} stroke-dasharray="3 2" stroke-width="1.1" />
                      ) : (
                        <rect
                          x={x.toFixed(1)}
                          y={yTop.toFixed(1)}
                          width={barW.toFixed(1)}
                          height={Math.max(2, baseH - yTop).toFixed(1)}
                          rx="2"
                          fill={isOver || isPeak ? P.red : t.isBundle ? P.ink : 'url(#cost-bar-hatch)'}
                          stroke={isOver || isPeak ? P.red : P.ink}
                          stroke-width="1.2"
                        />
                      )
                    ) : (
                      <rect
                        x={x.toFixed(1)}
                        y={yTop.toFixed(1)}
                        width={barW.toFixed(1)}
                        height={Math.max(2, baseH - yTop).toFixed(1)}
                        rx="2"
                        fill={r.house === '新房' ? P.ink : 'url(#cost-bar-hatch)'}
                        stroke={P.ink}
                        stroke-width="1.2"
                      />
                    )}

                    {isSelected && <rect x={(x - 3).toFixed(1)} y={(baseH + 3).toFixed(1)} width={(barW + 6).toFixed(1)} height="2.5" rx="1" fill={P.red} />}

                    <text
                      x={cx.toFixed(1)}
                      y={lblY.toFixed(1)}
                      text-anchor="middle"
                      font-size={t.utilPending && chartMode === 'util' ? '8.5' : '9.5'}
                      font-weight={isSelected || isPeak ? '700' : '500'}
                      fill={t.utilPending && chartMode === 'util' ? P.lbl : isOver || isPeak ? P.red : P.ink}
                      font-variant-numeric="tabular-nums"
                    >
                      {valLbl}
                    </text>
                    <text
                      x={cx.toFixed(1)}
                      y={H - 7}
                      text-anchor="middle"
                      font-size="10.5"
                      font-weight={isSelected ? '700' : '400'}
                      fill={isSelected ? P.ink : P.lbl}
                    >
                      {shortLbl}
                    </text>
                  </g>
                );
              })}

              {linePts.length > 1 && (
                <g style={{ pointerEvents: 'none' }}>
                  <path d={smoothPath(linePts)} fill="none" stroke={P.red} stroke-width="1.4" stroke-dasharray="3 2" />
                  {linePts.map(([px, py], idx) => (
                    <circle key={idx} cx={px.toFixed(1)} cy={py.toFixed(1)} r="2.5" fill={P.dotBg} stroke={P.red} stroke-width="1.4" />
                  ))}
                </g>
              )}
            </svg>

            {hoverIdx !== null && trendItems[hoverIdx] && (
              <div
                class="chart-tip show"
                style={{ left: `${Math.max(92, Math.min(W - 92, padL + step * hoverIdx + step / 2))}px` }}
              >
                {(() => {
                  const r = trendItems[hoverIdx];
                  const t = calcTotals(r);
                  return (
                    <>
                      <div class="chart-tip-time">
                        {r.month} · {r.house || '新房'}
                        {r.note ? ` · ${r.note}` : ''}
                      </div>
                      <div class="chart-tip-row">
                        <span style={{ opacity: 0.75 }}>房租均摊</span>
                        <strong class="num">{fmtMoney(t.rent)}</strong>
                      </div>
                      <div class="chart-tip-row">
                        <span style={{ opacity: 0.75 }}>
                          {t.utilPending
                            ? '水电气 (次月缴)'
                            : t.isBundle
                              ? `打包 (${formatBundlePartsText(t.bundleParts)})`
                              : '电 / 水 / 气'}
                        </span>
                        <strong class="num">
                          {t.utilPending ? '待下月出账' : t.isBundle ? fmtMoney(t.util) : `${t.elec} / ${t.water} / ${t.gas}`}
                        </strong>
                      </div>
                      <div class="chart-tip-row">
                        <span style={{ opacity: 0.75 }}>当月合计</span>
                        <strong class="num">{fmtMoney(t.total)}</strong>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Right Ledger Table */}
        <div class="card">
          <div class="card-head">
            <span class="card-title">04 / 月度生活账单台账（按消费月归属 · 次月实缴水电气）</span>
            <span class="tag num">{costData.records.length} 条记录</span>
          </div>
          <div class="cost-ledger-wrap">
            <table class="kv-table">
              <thead>
                <tr>
                  <th>月份</th>
                  <th>居所</th>
                  <th>房租</th>
                  <th>水电气明细 (次月缴)</th>
                  <th>总计</th>
                </tr>
              </thead>
              <tbody>
                {[...costData.records].reverse().map((r) => {
                  const t = calcTotals(r);
                  const isOver =
                    (costData.budgetTotal > 0 && t.total > costData.budgetTotal) ||
                    (costData.budgetUtil > 0 && t.util > costData.budgetUtil);
                  const parts: string[] = [];
                  if (t.elec > 0) parts.push(`电${t.elec}`);
                  if (t.water > 0) parts.push(`水${t.water}`);
                  if (t.gas > 0) parts.push(`气${t.gas}`);

                  return (
                    <tr
                      key={r.month}
                      class={`cost-row-btn ${r.month === selectedMonth ? 'active' : ''}`}
                      onClick={() => selectMonth(r.month)}
                    >
                      <td class="num" style={{ fontWeight: 600 }}>
                        {r.month}
                      </td>
                      <td>
                        <span class={`tag ${r.house === '新房' ? 'dark' : ''}`} style={{ padding: '1px 6px', fontSize: '10.5px' }}>
                          {r.house || '新房'}
                        </span>
                      </td>
                      <td class="num">{r.rent.toFixed(0)}</td>
                      <td>
                        {t.utilPending ? (
                          <span class="tag" style={{ padding: '1px 6px', fontSize: '10.5px', color: 'var(--text-dim)' }}>
                            待次月出账 · 预计含{formatBundlePartsText(t.bundleParts)}
                          </span>
                        ) : t.isBundle ? (
                          <>
                            <span class="tag" style={{ padding: '1px 6px', fontSize: '10.5px' }}>
                              打包 · {formatBundlePartsText(t.bundleParts)}
                            </span>{' '}
                            <strong class="num">¥{t.util.toFixed(0)}</strong>
                          </>
                        ) : parts.length ? (
                          <span class="num">{parts.join(' · ')}</span>
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>¥0</span>
                        )}
                      </td>
                      <td class="num" style={{ fontWeight: 700, color: isOver ? 'var(--red)' : 'var(--text)' }}>
                        {t.total.toFixed(1)}
                        {t.utilPending && <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>*</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
