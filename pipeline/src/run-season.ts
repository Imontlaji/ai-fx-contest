// 逐日驱动一位（或几位）选手跑完整个赛季，可断点续跑。
// 用法：node pipeline/src/run-season.ts <选手id>... [--days N]   （在 ep02-fx/ 下运行）
//   --days N  只往前推进 N 天（试跑用）
// 产物：runs/<选手id>/day-XXX.json（每天的原始输出）、runs/<选手id>/state.json（账户与进度）
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHANNELS } from "./channels.ts";
import { newAccount, normalizeDecision, stepDay, equityAt } from "./engine.ts";
import { parseCsv, buildMarket, revealPrice } from "./market.ts";
import { buildTask } from "./task.ts";

const ROOT = resolve(import.meta.dirname, "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const rules = readJson("config/rules.json");
const cfg = readJson("config/market.json");
const { contestants } = readJson("config/contestants.json");

export function loadMarket() {
  const csv = existsSync(join(ROOT, cfg.csv)) ? cfg.csv : cfg.fallbackCsv;
  if (csv === cfg.fallbackCsv) console.warn(`⚠ 没有 ${cfg.csv}，使用临时数据 ${cfg.fallbackCsv}（只有收盘价，正式比赛前必须换成真实 OHLC）`);
  return { market: buildMarket(parseCsv(readFileSync(join(ROOT, csv), "utf8")), cfg), csv };
}

function extractJson(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  for (const c of [...fenced, s >= 0 && e > s ? text.slice(s, e + 1) : ""]) {
    try { return JSON.parse(c.trim()); } catch {}
  }
  return null;
}

function callModel(c, prompt) {
  const ch = CHANNELS[c.channel];
  const dir = mkdtempSync(join(tmpdir(), "fx-"));
  writeFileSync(join(dir, "task.md"), prompt);
  const args = ch.args(c.model, prompt);
  const t0 = Date.now();
  const proc = spawnSync(ch.bin(), args, {
    cwd: dir, env: { ...process.env, ...(ch.env?.() ?? {}) }, encoding: "utf8",
    input: ch.stdin ? prompt : undefined, timeout: Number(process.env.RUN_TIMEOUT_MIN ?? 10) * 60_000,
    maxBuffer: 16 * 1024 * 1024, shell: ch.shell === true && process.platform === "win32",
  });
  const last = ch.lastMessageFile && join(dir, ch.lastMessageFile);
  const raw = last && existsSync(last) ? readFileSync(last, "utf8") : (proc.stdout ?? "");
  rmSync(dir, { recursive: true, force: true });
  return { raw, stderr: proc.stderr ?? "", exitCode: proc.status, error: proc.error?.message ?? null, durationMs: Date.now() - t0 };
}

const argv = process.argv.slice(2);
const di = argv.indexOf("--days");
const maxSteps = di >= 0 ? Number(argv[di + 1]) : Infinity;
const ids = argv.filter((a, j) => !a.startsWith("--") && !(di >= 0 && j === di + 1));
const MAX_ATTEMPTS = Number(process.env.FX_MAX_ATTEMPTS ?? 3);
const isMain = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("run-season.ts");
if (isMain && ids.length) {
  const { market, csv } = loadMarket();
  const { bars, seasonFrom, k } = market;
  const totalDays = bars.length - seasonFrom;
  for (const id of ids) {
    const c = contestants.find((x) => x.id === id);
    if (!c) { console.log(`SKIP ${id}: 不在 contestants.json`); continue; }
    const dir = join(ROOT, process.env.FX_RUNS_DIR ?? "runs", id);
    mkdirSync(dir, { recursive: true });
    const sf = join(dir, "state.json");
    // i = 刚收盘、即将做决策的那根 K 线；第一次决策在热身最后一根（第 0 天）收盘后
    let st = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8"))
      : { id, csv, k, i: seasonFrom - 1, acc: newAccount(rules), memo: "", says: [], curve: [], log: [] };
    let steps = 0;
    while (st.i < bars.length - 1 && !st.acc.out && steps < maxSteps) {
      const bar = bars[st.i];
      const prompt = buildTask({ market, i: st.i, acc: st.acc, memo: st.memo, recent: st.says.slice(-5), rules, cfg, totalDays });
      // 只在“没拿到任何输出”（启动失败、超时、限流、空输出）时重试；拿到输出但内容不合规不重跑，按 hold 处理并记 formatNotes
      let r, json, attempts = 0;
      do {
        attempts += 1;
        r = callModel(c, prompt);
        if (!r.raw.trim() && /Individual quota reached/i.test(r.stderr)) {
          throw new Error(`${id} 额度耗尽，第${bar.day + 1}个交易日尚未结算，可在额度刷新后续跑。`);
        }
        json = extractJson(r.raw);
        if (json || r.raw.trim()) break;
        if (attempts < MAX_ATTEMPTS) console.log(`  ${id} 第${bar.day}天 无输出（${r.error ?? "exit " + r.exitCode}），30 秒后重试`), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      } while (attempts < MAX_ATTEMPTS);
      const { d, notes } = normalizeDecision(json, rules);
      if (!json) notes.unshift(r.error ? `启动失败：${r.error}` : "输出中没有可解析的 JSON，按 hold 处理");
      if (attempts > 1) notes.push(`无输出重试 ${attempts - 1} 次`);
      // AI 给的是隐藏价格，换回真实价格再撮合
      const real = { ...d, stop_loss: d.stop_loss === null ? null : revealPrice(d.stop_loss, k), take_profit: d.take_profit === null ? null : revealPrice(d.take_profit, k) };
      writeFileSync(join(dir, `day-${String(bar.day).padStart(3, "0")}.json`), JSON.stringify({ day: bar.day, date: bar.date, attempts, prompt, ...r, parsed: json, decision: d, formatNotes: notes }, null, 2));
      const next = bars[st.i + 1];
      const res = stepDay(st.acc, next, real, rules);
      if (json && typeof json.memo === "string") st.memo = json.memo.slice(0, rules.maxMemoChars);
      if (d.say) st.says.push({ day: bar.day, say: d.say });
      st.log.push({ day: next.day, date: next.date, decision: real, say: d.say, notes, events: res.events });
      st.curve.push({ day: next.day, date: next.date, equity: Math.round(equityAt(st.acc, next.close)), units: st.acc.units, entry: st.acc.entry, close: next.close });
      st.i += 1; steps += 1;
      writeFileSync(sf, JSON.stringify(st, null, 2));
      const ev = res.events.filter((e) => e.type !== "swap").map((e) => e.type).join(",");
      console.log(`${id} 第${next.day}天 ${next.date} ${d.action}${d.leverage ? "×" + d.leverage : ""} 净值 ${st.curve.at(-1).equity.toLocaleString()} ${ev} ${notes.length ? "⚠" + notes.join("；") : ""}`);
    }
    console.log(`${id}: ${st.acc.out ? "已出局" : st.i >= bars.length - 1 ? "赛季结束" : "暂停"}，净值 ${Math.round(equityAt(st.acc, bars[st.i].close)).toLocaleString()}`);
  }
} else if (isMain) {
  console.log("用法: node pipeline/src/run-season.ts <选手id>... [--days N]");
  console.log("选手:", contestants.map((c) => c.id).join(", "));
}
