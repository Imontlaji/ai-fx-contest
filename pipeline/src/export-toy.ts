// 从 pipeline 的正式比赛数据导出 Toy 数据 → toy/public/data/season2.json
// 用法：node pipeline/src/export-toy.ts（在 ep02-fx/ 下运行）
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeBaselines } from "./baselines.ts";
import { equityAt, newAccount, normalizeDecision, stepDay } from "./engine.ts";
import { loadMarket } from "./run-season.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const rules = read("config/rules.json");
const stats = read("out/stats.json");
const awardsRaw = read("out/awards.json").awards;
const { events } = read("config/events.json");
const { contestants } = read("config/contestants.json");

const ART: Record<string, string> = {
  "gpt-6.2-astra": "gpt_big",
  "gpt-6.2-sol": "gpt_small",
  "gemini-4-neon": "gemini_big",
  "gemini-4-hydrogen": "gemini_small",
  "grok-4.7": "grok",
  "claude-opus-5.5": "claude",
  "deepseek-v4.1-flash": "deepseek",
  "glm-5.3": "glm",
};
const COLORS: Record<string, string> = {
  "gpt-6.2-astra": "#10a37f",
  "gpt-6.2-sol": "#4cb89a",
  "gemini-4-neon": "#4285f4",
  "gemini-4-hydrogen": "#7baaf7",
  "claude-opus-5.5": "#d97757",
  "grok-4.7": "#3a3a3a",
  "deepseek-v4.1-flash": "#4d6bfe",
  "glm-5.3": "#8a5cf6",
};
const SHORT: Record<string, string> = {
  "gpt-6.2-astra": "Astra",
  "gpt-6.2-sol": "Sol",
  "gemini-4-neon": "Neon",
  "gemini-4-hydrogen": "Hydrogen",
  "grok-4.7": "Grok",
  "claude-opus-5.5": "Claude",
  "deepseek-v4.1-flash": "DeepSeek",
  "glm-5.3": "GLM",
};
const CHANNEL: Record<string, string> = {
  codex: "Codex",
  agy: "Antigravity",
  cursor: "Cursor",
  devin: "Devin",
};
const BOT_META: Record<string, { name: string; desc: string; color: string }> = {
  "bot-hold": { name: "躺平机", desc: "从头到尾不交易", color: "#9499a0" },
  "bot-long1": { name: "1 倍拿到底", desc: "第 1 天 1 倍做多，拿满一年", color: "#6e7b8b" },
  "bot-long25": { name: "25 倍梭哈机", desc: "第 1 天 25 倍做多，然后不管了", color: "#e09a10" },
  "bot-max": { name: "满杠杆复利机", desc: "每天把仓位补满 25 倍，从不止损", color: "#e5484d" },
  "bot-ma": { name: "均线机", desc: "20/60 日均线金叉多、死叉空，5 倍", color: "#5c7a99" },
  "bot-random": { name: "随机猴子", desc: "每天抛硬币乱买，3 倍杠杆", color: "#a1887f" },
};
const CATCH: Record<string, [string, RegExp]> = {
  "gpt-6.2-astra": ["按计划", /按计划/],
  "gpt-6.2-sol": ["繁体字", /[們這說當為對裡麼與後來會個時現從無還開關點價單槓損盤東]/],
  "gemini-4-neon": ["洗盘", /洗盘/],
  "gemini-4-hydrogen": ["观望", /观望/],
  "grok-4.7": ["按计划", /按计划/],
  "claude-opus-5.5": ["按计划", /按计划/],
  "deepseek-v4.1-flash": ["纪律", /纪律/],
  "glm-5.3": ["纪律", /纪律/],
};

// 每位选手精选 1 条标志性原话日期（真实日期），在「AI 战绩与独白」页展示
const QUOTE_DATES: Record<string, string[]> = {
  "gemini-4-neon": ["2024-11-15", "2024-09-26"],
  "gemini-4-hydrogen": ["2024-11-15", "2024-07-11"],
  "deepseek-v4.1-flash": ["2024-12-20", "2024-08-05"],
  "claude-opus-5.5": ["2024-08-05", "2024-05-01"],
  "gpt-6.2-sol": ["2024-12-20", "2024-12-30"],
  "grok-4.7": ["2024-08-05", "2024-01-02"],
  "gpt-6.2-astra": ["2024-07-11", "2024-12-19"],
  "glm-5.3": ["2024-11-07", "2024-08-05"],
};

const { market } = loadMarket();
const { bars, seasonFrom, k } = market;
const warmup = bars.slice(0, seasonFrom);
const season = bars.slice(seasonFrom);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function runBot(bot: any): number[] {
  const acc = newAccount(rules);
  let pend: any = { action: "hold" };
  const eq: number[] = [];
  for (let i = seasonFrom; i < bars.length; i++) {
    const { d } = normalizeDecision(pend, rules);
    stepDay(acc, bars[i], d, rules);
    eq.push(Math.round(equityAt(acc, bars[i].close)));
    pend = acc.out ? { action: "hold" } : bot.decide(bars.slice(0, i + 1), acc);
  }
  return eq;
}

const statById = new Map<string, any>(
  [...stats.ranking, ...stats.baselines].map((r: any) => [r.id, r]),
);

const aiList = contestants.map((c: any) => {
  const dir = join(ROOT, "runs", c.id);
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const s = statById.get(c.id)!;
  const byDate = new Map<string, any>(st.log.map((l: any) => [l.date, l]));

  let ms = 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.startsWith("day-"))) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    ms += d.durationMs ?? 0;
    n++;
  }
  let opens = 0;
  let noStop = 0;
  for (const l of st.log) {
    if (["long", "short"].includes(l.decision?.action)) {
      opens++;
      if (l.decision.stop_loss == null) noStop++;
    }
  }
  const allSays: string[] = st.log.map((l: any) => l.say ?? "");
  const [catchWord, re] = CATCH[c.id];
  const catchCount = allSays.filter((x) => re.test(x)).length;

  const pickedDates = QUOTE_DATES[c.id] ?? [];
  const quotes = pickedDates
    .map((date) => {
      const l = byDate.get(date);
      return l?.say ? { day: l.day, date, text: l.say } : null;
    })
    .filter(Boolean);

  return {
    id: c.id,
    name: c.name,
    short: SHORT[c.id],
    channel: CHANNEL[c.channel],
    art: ART[c.id],
    image: `img/${ART[c.id]}.webp`,
    color: COLORS[c.id],
    finalRank: s.finalRank,
    finalEquity: s.finalEquity,
    returnPct: Math.round(s.returnPct * 10000) / 10000,
    peakEquity: s.peakEquity,
    maxDrawdown: Math.round(s.maxDrawdown * 10000) / 10000,
    trades: s.trades,
    avgLeverage: Math.round((s.avgLeverage ?? 0) * 100) / 100,
    maxLeverage: Math.round((s.maxLeverage ?? 0) * 100) / 100,
    liquidations: s.liquidations,
    longestUnderwaterHold: s.longestUnderwaterHold,
    opens,
    noStop,
    avgSec: Math.round(ms / Math.max(1, n) / 1000),
    catchWord,
    catchCount,
    quotes,
    eq: st.curve.map((x: any) => x.equity),
  };
});

const botList = makeBaselines().map((b: any) => {
  const s = statById.get(b.id)!;
  return {
    id: b.id,
    ...BOT_META[b.id],
    finalEquity: s.finalEquity,
    returnPct: Math.round(s.returnPct * 10000) / 10000,
    peakEquity: s.peakEquity,
    maxDrawdown: Math.round(s.maxDrawdown * 10000) / 10000,
    trades: s.trades,
    avgLeverage: Math.round((s.avgLeverage ?? 0) * 100) / 100,
    liquidations: s.liquidations,
    eq: runBot(b),
  };
});

const out = {
  meta: {
    title: "FX 战士模拟器",
    season: "2024 USD/JPY",
    totalDays: season.length,
    videoBvid: "",
  },
  rules: {
    initialEquity: rules.initialEquity,
    targetEquity: rules.targetEquity,
    maxLeverage: rules.maxLeverage,
    maintenanceRatio: rules.maintenanceRatio,
    halfSpread: rules.halfSpread,
    swapLongAnnual: rules.swapLongAnnual,
    swapShortAnnual: rules.swapShortAnnual,
    minEquityToTrade: rules.minEquityToTrade,
  },
  market: {
    k,
    digits: 3,
    // 热身 60 根：[o, h, l, c]（真实价格）
    warmup: warmup.map((b: any) => [r3(b.open), r3(b.high), r3(b.low), r3(b.close)]),
    // 比赛 262 根：[date, o, h, l, c, swapDays]（真实价格与真实日期，游玩中隐藏）
    bars: season.map((b: any) => [b.date, r3(b.open), r3(b.high), r3(b.low), r3(b.close), b.swapDays]),
  },
  events,
  contestants: aiList,
  bots: botList,
  awards: awardsRaw.map((a: any) => ({
    id: a.id,
    name: a.name,
    desc: a.desc,
    winner: a.winner?.id ?? null,
    value: a.winner?.value ?? null,
    via: a.via,
  })),
};

const dst = join(ROOT, "../toy/public/data/season2.json");
mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, JSON.stringify(out));
console.log(
  `已导出 ${dst}（${(Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(1)} KB，${season.length} 天，${aiList.length} AI，${botList.length} 机器人）`,
);
