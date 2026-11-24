// 生成可视化数据：基线机器人 + 已跑的 AI 选手 → viz/data.js（浏览器直接打开 viz/index.html）
// 用法：node pipeline/src/build-viz.ts   （在 ep02-fx/ 下运行）
// 注意：data.js 含 AI 结果，UP 主决定录屏前不要打开（盲测原则）。加 --bots-only 只导出基线机器人。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { newAccount, normalizeDecision, stepDay, equityAt } from "./engine.ts";
import { makeBaselines } from "./baselines.ts";
import { loadMarket } from "./run-season.ts";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const rules = readJson("config/rules.json");
const { events } = readJson("config/events.json");
const { contestants } = readJson("config/contestants.json");
const botsOnly = process.argv.includes("--bots-only");

const { market, csv } = loadMarket();
const { bars, seasonFrom, k } = market;
const season = bars.slice(seasonFrom);

function runBot(bot) {
  const acc = newAccount(rules);
  let pend = { action: "hold" };
  const curve = [], log = [];
  for (let i = seasonFrom; i < bars.length; i++) {
    const { d } = normalizeDecision(pend, rules);
    const r = stepDay(acc, bars[i], d, rules);
    curve.push({ day: bars[i].day, date: bars[i].date, equity: Math.round(equityAt(acc, bars[i].close)), units: acc.units });
    const ev = r.events.filter((e) => e.type !== "swap");
    if (ev.length) log.push({ day: bars[i].day, date: bars[i].date, events: ev, say: "" });
    pend = acc.out ? { action: "hold" } : bot.decide(bars.slice(0, i + 1), acc);
  }
  return { id: bot.id, name: bot.name, kind: "bot", curve, log, trades: acc.trades, maxDrawdown: acc.maxDrawdown, out: acc.out };
}

const players = makeBaselines().map(runBot);
if (!botsOnly) {
  for (const c of contestants) {
    const f = join(ROOT, "runs", c.id, "state.json");
    if (!existsSync(f)) continue;
    const st = JSON.parse(readFileSync(f, "utf8"));
    players.push({ id: c.id, name: c.name, kind: "ai", curve: st.curve, log: st.log.filter((l) => l.say || l.events.some((e) => e.type !== "swap")),
      trades: st.acc.trades, maxDrawdown: st.acc.maxDrawdown, out: st.acc.out });
  }
}

const data = {
  generatedAt: new Date().toISOString(), csv, provisional: csv.includes("provisional"), k,
  rules: { initialEquity: rules.initialEquity, targetEquity: rules.targetEquity, maxLeverage: rules.maxLeverage },
  bars: season.map((b) => [b.date, b.open, b.high, b.low, b.close, b.day]),
  events, players,
};
mkdirSync(join(ROOT, "viz"), { recursive: true });
writeFileSync(join(ROOT, "viz", "data.js"), "window.FX_DATA = " + JSON.stringify(data) + ";\n");
console.log(`viz/data.js：${season.length} 个交易日，${players.length} 位选手（${players.filter((p) => p.kind === "ai").length} 个 AI）`);
for (const p of players) console.log(`  ${p.name.padEnd(18)} 净值 ${p.curve.at(-1).equity.toLocaleString().padStart(12)}  回撤 ${(p.maxDrawdown * 100).toFixed(1)}%  交易 ${p.trades}${p.out ? "  已出局" : ""}`);
