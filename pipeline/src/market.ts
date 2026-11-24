// 行情：读 CSV、切出热身段和比赛段、生成给 AI 看的“隐藏版”行情。
// 隐藏方式：日期 → “第 N 天”；价格 × k（k 使比赛首日开盘价 = basePrice），涨跌幅、形态完全不变。

/** CSV: date,open,high,low,close（真实价格，升序） */
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(",").map((s) => s.trim().toLowerCase());
  const idx = (k) => head.indexOf(k);
  const bars = lines.map((l) => {
    const c = l.split(",");
    return { date: c[idx("date")].trim(), open: +c[idx("open")], high: +c[idx("high")], low: +c[idx("low")], close: +c[idx("close")] };
  }).filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * cfg: { seasonStart, seasonEnd, warmupBars, basePrice, digits }
 * 返回 { bars: 全部（热身 + 比赛），seasonFrom: 比赛第一根的下标，k }
 * 每根 bar 带 i（全局下标）、day（比赛日序号，热身为负数或 0 以下）、swapDays（距上一根的自然日数，用于掉期）
 */
export function buildMarket(all, cfg) {
  const s = all.findIndex((b) => b.date >= cfg.seasonStart);
  if (s < 0) throw new Error("找不到比赛开始日期");
  if (s < cfg.warmupBars) throw new Error(`热身数据不足：需要 ${cfg.warmupBars} 根，只有 ${s} 根`);
  let e = all.length - 1;
  while (e >= 0 && all[e].date > cfg.seasonEnd) e--;
  const from = s - cfg.warmupBars;
  const bars = all.slice(from, e + 1).map((b, j) => ({ ...b, i: j }));
  const seasonFrom = cfg.warmupBars;
  for (const b of bars) {
    b.day = b.i - seasonFrom + 1;
    b.swapDays = b.i === 0 ? 1 : Math.max(1, dayDiff(bars[b.i - 1].date, b.date));
  }
  const k = cfg.basePrice / bars[seasonFrom].open;
  return { bars, seasonFrom, k };
}

export const hidePrice = (p, k, digits) => +(p * k).toFixed(digits);
export const revealPrice = (p, k) => p / k;

/** 给 AI 的 K 线表：只到 uptoIndex（含），最多 n 根 */
export function hiddenTable(market, uptoIndex, n, digits) {
  const { bars, k } = market;
  const rows = bars.slice(Math.max(0, uptoIndex - n + 1), uptoIndex + 1);
  return ["day,open,high,low,close", ...rows.map((b) =>
    [b.day, hidePrice(b.open, k, digits), hidePrice(b.high, k, digits), hidePrice(b.low, k, digits), hidePrice(b.close, k, digits)].join(","))].join("\n");
}
