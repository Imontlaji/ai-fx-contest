// 撮合引擎：纯函数，不读写文件。所有价格用真实价格；隐藏变换只发生在给 AI 的报告里（见 market.ts）。
// 单位：账户货币 = 日元；持仓 units = 美元数量（正 = 做多 USD，负 = 做空）。

/**
 * @typedef {{ i:number, date:string, open:number, high:number, low:number, close:number }} Bar
 * @typedef {{ action:"long"|"short"|"close"|"hold", leverage?:number, stop_loss?:number|null, take_profit?:number|null, say?:string }} Decision
 */

export function newAccount(rules) {
  return {
    cash: rules.initialEquity,   // 已实现资金（含已结算的盈亏和掉期）
    units: 0,                    // 持仓数量
    entry: 0,                    // 持仓均价
    stop: null,                  // 止损价（真实价格）
    take: null,                  // 止盈价（真实价格）
    out: false,                  // 已退场
    outReason: null,
    trades: 0,
    peak: rules.initialEquity,
    maxDrawdown: 0,
  };
}

export function equityAt(acc, price) {
  return acc.cash + acc.units * (price - acc.entry);
}

function closePosition(acc, price, rules, events, reason) {
  if (acc.units === 0) return;
  const fill = acc.units > 0 ? price - rules.halfSpread : price + rules.halfSpread;
  acc.cash += acc.units * (fill - acc.entry);
  events.push({ type: reason, side: acc.units > 0 ? "long" : "short", units: acc.units, price: fill });
  acc.units = 0; acc.entry = 0; acc.stop = null; acc.take = null;
  acc.trades += 1;
}

function openPosition(acc, sign, leverage, price, rules, events) {
  const fill = sign > 0 ? price + rules.halfSpread : price - rules.halfSpread;
  const eq = acc.cash;
  const units = Math.floor((eq * leverage) / fill) * sign;
  if (units === 0) return;
  acc.units = units; acc.entry = fill;
  acc.trades += 1;
  events.push({ type: "open", side: sign > 0 ? "long" : "short", units, price: fill, leverage });
}

/** 把 AI 的决策规范化；非法值记 note，按 hold 处理 */
export function normalizeDecision(raw, rules) {
  const notes = [];
  const d = { action: "hold", leverage: 0, stop_loss: null, take_profit: null, say: "" };
  if (!raw || typeof raw !== "object") { notes.push("决策不是对象，按 hold 处理"); return { d, notes }; }
  const a = String(raw.action ?? "").toLowerCase();
  if (["long", "short", "close", "hold"].includes(a)) d.action = a; else notes.push(`未知 action「${raw.action}」，按 hold 处理`);
  let lev = Number(raw.leverage ?? 0);
  if (!Number.isFinite(lev)) { lev = 0; notes.push("leverage 不是数字"); }
  if (lev > rules.maxLeverage) { notes.push(`leverage ${lev} 超过上限，截断为 ${rules.maxLeverage}`); lev = rules.maxLeverage; }
  if (lev < 0) lev = 0;
  d.leverage = lev;
  if ((d.action === "long" || d.action === "short") && lev === 0) { notes.push("开仓但 leverage=0，按 hold 处理"); d.action = "hold"; }
  for (const k of ["stop_loss", "take_profit"]) {
    const v = raw[k];
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) d[k] = n; else notes.push(`${k} 非法，忽略`);
  }
  d.say = typeof raw.say === "string" ? raw.say.slice(0, rules.maxSayChars) : "";
  return { d, notes };
}

/**
 * 推进一个交易日：昨天收盘后做的决策 d，在今天 bar 的开盘执行。
 * stop/take 价格已是真实价格（调用方负责把 AI 看到的价格换算回来）。
 * 返回当天的事件列表与收盘净值。
 */
export function stepDay(acc, bar, d, rules) {
  const events = [];
  if (acc.out) return { events, equity: acc.cash, closeEquity: acc.cash };

  // 1. 开盘执行决策
  const side = Math.sign(acc.units);
  if (d.action === "close") {
    closePosition(acc, bar.open, rules, events, "close");
  } else if (d.action === "long" || d.action === "short") {
    const want = d.action === "long" ? 1 : -1;
    // 已有同方向仓位：按新杠杆重新调整（先平再开，简化处理，计 1 次手续）
    if (side !== 0) closePosition(acc, bar.open, rules, events, side === want ? "resize" : "reverse");
    openPosition(acc, want, d.leverage, bar.open, rules, events);
  }
  if (acc.units !== 0 && d.action !== "hold" && d.action !== "close") {
    acc.stop = d.stop_loss; acc.take = d.take_profit;
  } else if (acc.units !== 0 && d.action === "hold") {
    // hold 时允许更新止损止盈（给了就更新，没给沿用）
    if (d.stop_loss !== null) acc.stop = d.stop_loss;
    if (d.take_profit !== null) acc.take = d.take_profit;
  }
  // 不合逻辑的止损（做多止损在开仓价上方等）照样执行：下面的盘中检查会在开盘价立刻触发

  // 2. 盘中：开盘先判跳空，再按“先走不利方向”的保守顺序检查止损 / 强平 / 止盈
  if (acc.units !== 0) {
    const long = acc.units > 0;
    const adverse = long ? bar.low : bar.high;
    const favorable = long ? bar.high : bar.low;
    // 强平价：净值 = 维持率 × 所需保证金
    const liq = liquidationPrice(acc, rules);
    const hit = (p, lvl) => (long ? p <= lvl : p >= lvl);
    const gapFill = (lvl) => (hit(bar.open, lvl) ? bar.open : lvl);
    const candidates = [];
    if (acc.stop !== null && hit(adverse, acc.stop)) candidates.push({ lvl: acc.stop, type: "stop" });
    if (liq !== null && hit(adverse, liq)) candidates.push({ lvl: liq, type: "liquidation" });
    // 不利方向上先碰到的那个先触发
    candidates.sort((a, b) => (long ? b.lvl - a.lvl : a.lvl - b.lvl));
    if (candidates.length) {
      const c = candidates[0];
      closePosition(acc, gapFill(c.lvl), rules, events, c.type);
    } else if (acc.take !== null && (long ? favorable >= acc.take : favorable <= acc.take)) {
      closePosition(acc, long ? Math.max(acc.take, bar.open) : Math.min(acc.take, bar.open), rules, events, "take");
    }
  }

  // 3. 收盘：掉期（按名义本金年化，隔夜计入）
  if (acc.units !== 0) {
    const notional = Math.abs(acc.units) * bar.close;
    const rate = acc.units > 0 ? rules.swapLongAnnual : rules.swapShortAnnual;
    const swap = (notional * rate) / 365 * (bar.swapDays ?? 1);
    acc.cash += swap;
    if (Math.abs(swap) >= 1) events.push({ type: "swap", amount: Math.round(swap) });
  }

  const closeEquity = equityAt(acc, bar.close);
  acc.peak = Math.max(acc.peak, closeEquity);
  acc.maxDrawdown = Math.max(acc.maxDrawdown, acc.peak > 0 ? 1 - closeEquity / acc.peak : 0);

  // 4. 退场：空仓且资金不足以开最小仓
  if (acc.units === 0 && acc.cash < rules.minEquityToTrade) {
    acc.out = true; acc.outReason = events.some((e) => e.type === "liquidation") ? "liquidation" : "broke";
    events.push({ type: "out", reason: acc.outReason });
  }
  return { events, closeEquity };
}

/** 净值跌到 维持率 × 保证金 时的价格；保证金 = |units| × price / maxLeverage */
export function liquidationPrice(acc, rules) {
  if (acc.units === 0) return null;
  const u = acc.units, m = rules.maintenanceRatio / rules.maxLeverage, base = acc.cash - u * acc.entry;
  // cash + u(p - entry) = m |u| p  →  p = base / (m|u| - u)
  const denom = m * Math.abs(u) - u;
  if (denom === 0) return null;
  const p = base / denom;
  return p > 0 ? p : null;
}

export function effectiveLeverage(acc, price) {
  const eq = equityAt(acc, price);
  return eq > 0 ? (Math.abs(acc.units) * price) / eq : 0;
}
