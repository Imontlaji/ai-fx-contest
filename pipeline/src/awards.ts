// 统计与颁奖：读 runs/<选手>/state.json（AI）+ 重新模拟基线机器人 → out/stats.json、out/awards.json
// 用法：node pipeline/src/awards.ts   （在 ep02-fx/ 下运行）
// 盲测：只打印“已生成”，不打印名次；UP 主决定看结果时再打开 out/ 或加 --show。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { newAccount, normalizeDecision, stepDay, equityAt } from "./engine.ts";
import { makeBaselines } from "./baselines.ts";
import { loadMarket } from "./run-season.ts";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const rules = readJson("config/rules.json");
const { awards } = readJson("config/awards.json");
const { contestants } = readJson("config/contestants.json");
const show = process.argv.includes("--show");

const { market } = loadMarket();
const { bars, seasonFrom } = market;
const season = bars.slice(seasonFrom);
const totalDays = season.length;
const TRADE_TYPES = new Set(["open", "close", "resize", "reverse", "stop", "take", "liquidation"]);

function simulateBot(bot) {
  const acc = newAccount(rules);
  let pend = { action: "hold" };
  const curve = [], log = [];
  for (let i = seasonFrom; i < bars.length; i++) {
    const { d } = normalizeDecision(pend, rules);
    const r = stepDay(acc, bars[i], d, rules);
    curve.push({ day: bars[i].day, date: bars[i].date, equity: Math.round(equityAt(acc, bars[i].close)), units: acc.units, entry: acc.entry, close: bars[i].close });
    log.push({ day: bars[i].day, date: bars[i].date, events: r.events, say: "", notes: [] });
    pend = acc.out ? { action: "hold" } : bot.decide(bars.slice(0, i + 1), acc);
  }
  return { id: bot.id, name: bot.name, kind: "bot", curve, log, acc };
}

function metrics(p) {
  const c = p.curve;
  const finished = c.length && c.at(-1).day >= totalDays;
  const last = c.at(-1) ?? { equity: rules.initialEquity };
  let peak = rules.initialEquity, maxDD = 0, levSum = 0, levDays = 0, maxLev = 0;
  for (const x of c) {
    peak = Math.max(peak, x.equity);
    maxDD = Math.max(maxDD, peak > 0 ? 1 - x.equity / peak : 0);
    if (x.units && x.equity > 0) {
      const lev = (Math.abs(x.units) * (x.close ?? 0)) / x.equity;
      if (Number.isFinite(lev) && lev > 0) { levSum += lev; levDays += 1; maxLev = Math.max(maxLev, lev); }
    }
  }
  // 扛单：开仓那天的净值作为基准，之后连续收盘低于基准的天数；平仓 / 反手 / 调仓重置
  let base = null, run = 0, longest = 0, worstOpenLoss = 0;
  const byDay = new Map(p.log.map((l) => [l.day, l]));
  for (const x of c) {
    const evs = byDay.get(x.day)?.events ?? [];
    if (evs.some((e) => ["open", "resize", "reverse"].includes(e.type))) { base = x.equity; run = 0; }
    if (!x.units) { base = null; run = 0; continue; }
    if (base === null) base = x.equity;
    if (x.equity < base) { run += 1; longest = Math.max(longest, run); worstOpenLoss = Math.max(worstOpenLoss, 1 - x.equity / base); }
    else run = 0;
  }
  const allEv = p.log.flatMap((l) => l.events.map((e) => ({ ...e, day: l.day })));
  const liqs = allEv.filter((e) => e.type === "liquidation");
  const outEv = allEv.find((e) => e.type === "out");
  const formatNotes = p.log.reduce((s, l) => s + (l.notes?.length ? 1 : 0), 0);
  return {
    id: p.id, name: p.name, kind: p.kind, finished, daysPlayed: c.length,
    finalEquity: last.equity, returnPct: last.equity / rules.initialEquity - 1,
    peakEquity: peak, maxDrawdown: maxDD, peakToFinalDrop: peak > 0 ? 1 - last.equity / peak : 0,
    trades: allEv.filter((e) => TRADE_TYPES.has(e.type)).length,
    avgLeverage: levDays ? levSum / levDays : 0, maxLeverage: maxLev, daysInMarket: levDays,
    longestUnderwaterHold: longest, worstOpenLossPct: worstOpenLoss,
    liquidations: liqs.length, firstLiquidationDay: liqs.length ? liqs[0].day : (outEv ? outEv.day : null),
    out: !!outEv, outDay: outEv?.day ?? null, hitTarget: c.some((x) => x.equity >= rules.targetEquity),
    formatNoteDays: formatNotes,
  };
}

// 每天的名次（只在 AI 之间排），用于“曾经登顶”
function leaderInfo(aiPlayers) {
  const everLed = new Set();
  for (let day = 1; day <= totalDays; day++) {
    let best = null, bestEq = -Infinity;
    for (const p of aiPlayers) {
      const x = p.curve.find((y) => y.day === day) ?? [...p.curve].reverse().find((y) => y.day < day);
      const eq = x ? x.equity : rules.initialEquity;
      if (eq > bestEq) { bestEq = eq; best = p.id; }
    }
    // 第 1 天大家都是本金，不算登顶；必须超过本金
    if (best && bestEq > rules.initialEquity) everLed.add(best);
  }
  return everLed;
}

function cmpBy(key) {
  const [m, dir] = key.split(":");
  return (a, b) => (dir === "min" ? (a[m] ?? Infinity) - (b[m] ?? Infinity) : (b[m] ?? -Infinity) - (a[m] ?? -Infinity));
}
function evalRequire(expr, m) {
  if (!expr) return true;
  return expr.split("&&").map((s) => s.trim()).every((t) => {
    if (t.startsWith("!")) return !m[t.slice(1)];
    const mm = t.match(/^(\w+)\s*(>=|<=|>|<|==)\s*(\w+)$/);
    if (!mm) return !!m[t];
    const val = (v) => (v === "initialEquity" ? rules.initialEquity : Number.isFinite(+v) ? +v : m[v]);
    const [, l, op, r] = mm, a = val(l), b = val(r);
    return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : op === "<=" ? a <= b : a === b;
  });
}
function pick(list, rule) {
  let cand = list.filter((m) => evalRequire(rule.require, m) && m[rule.metric] !== null && m[rule.metric] !== undefined);
  if (rule.minValue !== undefined) cand = cand.filter((m) => (rule.pick === "max" ? m[rule.metric] >= rule.minValue : m[rule.metric] <= rule.minValue));
  if (!cand.length) return null;
  const keys = [`${rule.metric}:${rule.pick}`, ...(rule.tieBreak ?? [])];
  cand.sort((a, b) => { for (const k of keys) { const v = cmpBy(k)(a, b); if (v) return v; } return 0; });
  return cand[0];
}

const ai = [];
for (const c of contestants) {
  const f = join(ROOT, "runs", c.id, "state.json");
  if (!existsSync(f)) continue;
  const st = JSON.parse(readFileSync(f, "utf8"));
  ai.push({ id: c.id, name: c.name, kind: "ai", curve: st.curve, log: st.log, acc: st.acc });
}
const bots = makeBaselines().map(simulateBot);
const aiM = ai.map(metrics), botM = bots.map(metrics);

const everLed = leaderInfo(ai);
const ranked = [...aiM].sort((a, b) => b.finalEquity - a.finalEquity);
ranked.forEach((m, j) => { m.finalRank = j + 1; m.everLed = everLed.has(m.id); m.finalRankAmongEverLeaders = m.everLed ? m.finalRank : null; });

const results = awards.map((rule) => {
  let w = pick(aiM, rule), via = "main";
  if (rule.fallback && (!w || w[rule.metric] === null)) {
    const fb = { ...rule.fallback, tieBreak: [] };
    const cand = aiM.filter((m) => evalRequire(fb.onlyIf, m));
    w = pick(cand, fb); via = "fallback";
  }
  return { id: rule.id, name: rule.name, desc: rule.desc, winner: w ? { id: w.id, name: w.name, value: w[rule.metric] ?? null } : null, via: w ? via : "vacant" };
});

mkdirSync(join(ROOT, "out"), { recursive: true });
const unfinished = aiM.filter((m) => !m.finished && !m.out).map((m) => m.id);
writeFileSync(join(ROOT, "out", "stats.json"), JSON.stringify({ generatedAt: new Date().toISOString(), totalDays, rules, unfinished, ranking: ranked, baselines: botM }, null, 2));
writeFileSync(join(ROOT, "out", "awards.json"), JSON.stringify({ generatedAt: new Date().toISOString(), unfinished, awards: results }, null, 2));
console.log(`已生成 out/stats.json、out/awards.json（${aiM.length} 个 AI，${botM.length} 个基线）`);
if (unfinished.length) console.log(`⚠ 还没跑完：${unfinished.join(", ")}——正式颁奖前要全部跑完`);
if (show) {
  for (const m of ranked) console.log(`${m.finalRank}. ${m.name.padEnd(20)} ${Math.round(m.finalEquity).toLocaleString().padStart(12)}  回撤 ${(m.maxDrawdown * 100).toFixed(1)}%  均杠杆 ${m.avgLeverage.toFixed(1)}  交易 ${m.trades}${m.out ? "  出局" : ""}`);
  for (const a of results) console.log(`🏆 ${a.name}：${a.winner ? a.winner.name : "空缺"}`);
} else console.log("（盲测：不打印名次，加 --show 查看）");
