// 基线机器人：只用来校准规则和给视频做参照，不参加颁奖。
// 每个策略是 (history: Bar[], acc) => Decision，history 是“今天收盘为止”的真实行情（策略只看比例，不受价格变换影响）。

function sma(h, n) {
  if (h.length < n) return null;
  let s = 0;
  for (let j = h.length - n; j < h.length; j++) s += h[j].close;
  return s / n;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeBaselines(seed = 2024) {
  const rnd = mulberry32(seed);
  return [
    { id: "bot-hold", name: "躺平机（从不交易）", decide: () => ({ action: "hold" }) },
    { id: "bot-long1", name: "1 倍做多拿到底", decide: (h, acc) => (acc.units === 0 && acc.trades === 0 ? { action: "long", leverage: 1 } : { action: "hold" }) },
    { id: "bot-long25", name: "25 倍梭哈机", decide: (h, acc) => (acc.units === 0 ? { action: "long", leverage: 25 } : { action: "hold" }) },
    {
      id: "bot-max", name: "满杠杆复利机（每天补到 25 倍）",
      decide: (h, acc) => ({ action: "long", leverage: 25 }),
    },
    {
      id: "bot-ma", name: "均线机（20/60，5 倍）",
      decide: (h, acc) => {
        const f = sma(h, 20), s = sma(h, 60);
        if (f === null || s === null) return { action: "hold" };
        const want = f > s ? 1 : -1;
        if (Math.sign(acc.units) === want) return { action: "hold" };
        return { action: want > 0 ? "long" : "short", leverage: 5 };
      },
    },
    {
      id: "bot-random", name: "猴子（随机，3 倍）",
      decide: (h, acc) => {
        const r = rnd();
        if (r < 0.1) return { action: "long", leverage: 3 };
        if (r < 0.2) return { action: "short", leverage: 3 };
        if (r < 0.25) return { action: "close" };
        return { action: "hold" };
      },
    },
  ];
}
