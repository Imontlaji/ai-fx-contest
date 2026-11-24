// 每日任务包：AI 只看到隐藏后的 K 线和自己的账户，不给人设，风格自由发挥。
import { hiddenTable, hidePrice } from "./market.ts";
import { equityAt, effectiveLeverage, liquidationPrice } from "./engine.ts";

const fmt = (n) => Math.round(n).toLocaleString("en-US");

/**
 * @param market  buildMarket 的结果
 * @param i       今天（刚收盘）的全局下标
 * @param acc     账户
 * @param memo    上一次自己留下的笔记
 * @param recent  最近几天自己的 say（数组）
 */
export function buildTask({ market, i, acc, memo, recent, rules, cfg, totalDays }) {
  const { k } = market;
  const bar = market.bars[i];
  const hp = (p) => (p === null || p === undefined ? "无" : hidePrice(p, k, cfg.digits));
  const eq = equityAt(acc, bar.close);
  const pos = acc.units === 0
    ? "空仓"
    : `${acc.units > 0 ? "做多" : "做空"} ${fmt(Math.abs(acc.units))} 单位，开仓均价 ${hp(acc.entry)}，当前有效杠杆 ${effectiveLeverage(acc, bar.close).toFixed(1)} 倍，止损 ${hp(acc.stop)}，止盈 ${hp(acc.take)}，强平价约 ${hp(liquidationPrice(acc, rules))}`;
  const daysLeft = totalDays - bar.day;

  return `# 外汇交易挑战（第 ${bar.day} 天 / 共 ${totalDays} 天）

你是一名外汇交易员，正在参加一场交易比赛。比赛用的是**某个真实货币对的历史日线**，但日期被替换成了“第 N 天”，价格也经过了等比例缩放，所以你无法、也不需要猜出它是哪段行情。你只能根据 K 线本身做判断。交易风格、分析方法完全由你自己决定。

## 规则
- 开局资金 ${fmt(rules.initialEquity)}，目标是在比赛结束时把资金做到 ${fmt(rules.targetEquity)}（20 倍）。资金最多的选手获胜。
- 每天收盘后做一次决策，**下一个交易日开盘价成交**（可能跳空）。
- 可做多或做空，杠杆 1–${rules.maxLeverage} 倍（按你当时的全部资金计算仓位）。
- 价格 × 单位数 = 名义本金；点差已计入成交价；持仓过夜会产生利息：做多每年约 +${(rules.swapLongAnnual * 100).toFixed(1)}%，做空每年约 ${(rules.swapShortAnnual * 100).toFixed(1)}%（按名义本金计）。
- 净值低于必要保证金的 ${rules.maintenanceRatio * 100}% 会被**强制平仓**。资金不足 ${fmt(rules.minEquityToTrade)} 时出局。
- 止损 / 止盈按盘中最高最低价触发，跳空时按开盘价成交。
- 你每天都是新的会话，不记得之前的分析；可以用 memo 给明天的自己留笔记。

## 你的账户（第 ${bar.day} 天收盘）
- 净值：${fmt(eq)}
- 持仓：${pos}
- 已交易次数：${acc.trades}
- 剩余交易日：${daysLeft}

## 你昨天留给自己的笔记
${memo ? memo : "（无）"}

## 你最近几天说过的话
${recent.length ? recent.map((r) => `- 第 ${r.day} 天：${r.say}`).join("\n") : "（无）"}

## 最近 ${cfg.windowBars} 根日 K 线（今天是最后一行）
\`\`\`csv
${hiddenTable(market, i, cfg.windowBars, cfg.digits)}
\`\`\`

## 输出
只输出一个 JSON 对象，不要输出其他内容：
\`\`\`json
{
  "action": "long",
  "leverage": 5,
  "stop_loss": null,
  "take_profit": null,
  "say": "一句话说说你今天的想法（会公开，最多 ${rules.maxSayChars} 字）",
  "memo": "留给明天自己的笔记（最多 ${rules.maxMemoChars} 字）"
}
\`\`\`
- action：long（做多 / 把仓位调整为做多）、short（做空 / 调整为做空）、close（平仓）、hold（保持现状）。
- leverage：开仓或调整仓位时的杠杆，hold / close 时忽略。
- stop_loss / take_profit：价格或 null；hold 时填写则更新，null 表示沿用。
`;
}
