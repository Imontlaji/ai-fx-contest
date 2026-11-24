# RUNBOOK：第二期「AI 外汇战士大赛」实验执行手册

> 写给执行实验的人 / 模型。规则已在 `PLAN.md` 和 `pipeline/config/` 定稿，**执行期间不要修改任何规则文件**。
> 所有命令在 `F:\git\bilibili-toy\ep02-fx\` 下的 cmd 中运行（环境说明见仓库根目录 `AGENTS.md`）。

## 0. 铁律（违反任何一条都要停下来问 UP 主）

1. **规则冻结**：`config/rules.json`、`config/market.json`、`config/awards.json`、`src/engine.ts`、`src/market.ts`、`src/task.ts` 在正式开跑后不得修改。开跑前先记录它们的 sha256（见 §2）。
2. **不重跑、不挑选**：模型拿到输出但格式错误 → 按 `hold` 处理并记入 `formatNotes`，**不重跑**。唯一允许自动重试的是“完全没有输出”（启动失败、超时、限流、空输出），脚本已经内置最多 3 次。
3. **不能删 / 改 `runs/`**：如果某个选手跑坏了需要整体重来（例如 CLI 配置错误导致全部无输出），先停下，把原目录改名为 `runs/<id>.void-<日期>/` 保留，并在 §6 的日志里写明原因，经 UP 主同意再重来。
4. **盲测**：跑的过程中不要把名次、净值、独白发给 UP 主，也不要打开带 AI 数据的看板给 UP 主看。只报告“进度 + 是否有异常”。需要看板时用 `--bots-only`。
5. **纯净环境**：所有 CLI 都按 ep01 的方式屏蔽全局配置（`src/channels.ts` 已经从 ep01 原样抽出）。不要在任务目录里放任何其他文件。
6. **信息隔离**：不要向任何选手透露日期、货币对名称、真实价格或新闻。任务包只由 `src/task.ts` 生成。

## 1. 环境检查

```
node -v                       :: 需要能直接运行 .ts（与 ep01 相同的 Node 版本）
set PYTHONIOENCODING=utf-8
```
确认 ep01 那套 CLI 都能用（codex / agy / cursor / devin 的登录状态），方法同 ep01。

## 2. 冻结规则

```
certutil -hashfile pipeline\config\rules.json SHA256
certutil -hashfile pipeline\config\market.json SHA256
certutil -hashfile pipeline\config\awards.json SHA256
certutil -hashfile pipeline\data\usdjpy-2024.csv SHA256
certutil -hashfile pipeline\src\engine.ts SHA256
certutil -hashfile pipeline\src\task.ts SHA256
```
把结果写进 §6 日志，并 `git commit` 一次（提交信息：`ep02: 规则冻结`）。

## 3. 冒烟测试（dry run）

1. 只导出基线、生成看板，确认页面能打开：
   ```
   node pipeline/src/build-viz.ts --bots-only
   ```
   然后用浏览器打开 `pipeline/viz/index.html`（顶部应显示“盲测模式”，6 个基线机器人；“每天补到 25 倍”应在 2024-04-29 爆仓）。
2. 每个渠道各挑一个选手试跑 2 天，输出目录放到 dry run 专用位置，**不进正式 runs/**：
   ```
   set FX_RUNS_DIR=runs-dryrun
   node pipeline/src/run-season.ts claude-opus-5.5 gpt-6.2-sol gemini-4-hydrogen grok-4.7 --days 2
   ```
   > 如果 `run-season.ts` 还不支持 `FX_RUNS_DIR`，就临时把输出复制走后删除 `runs/<id>`。dry run 的数据不计入比赛。
3. 检查 `runs-dryrun/<id>/day-000.json`：
   - `prompt` 里没有出现真实日期、`USD`、`JPY`、`日元`、真实价格（应在 100 附近）；
   - `parsed` 是 JSON，`formatNotes` 为空；
   - `durationMs` 合理（估算全赛季耗时：单次时长 × 263）。
4. 有问题只允许修 **调用层**（`channels.ts`、`run-season.ts` 的启动 / 解析部分），不允许改规则和任务包措辞；如果必须改 `task.ts`，先停下来问 UP 主，改完重新冻结（§2）。

## 4. 正式开跑

每个选手互相独立，可以开多个 cmd 窗口并行（同一渠道建议不超过 2 个并行，避免限流）：

```
node pipeline/src/run-season.ts gpt-6.2-astra
node pipeline/src/run-season.ts gpt-6.2-sol
node pipeline/src/run-season.ts gemini-4-neon
node pipeline/src/run-season.ts gemini-4-hydrogen
node pipeline/src/run-season.ts grok-4.7
node pipeline/src/run-season.ts claude-opus-5.5
node pipeline/src/run-season.ts deepseek-v4.1-flash
node pipeline/src/run-season.ts glm-5.3
```

- 断点续跑：中断后重新执行同一条命令即可，会从 `runs/<id>/state.json` 继续。
- 每个选手约 263 次调用；比赛日 = 2024-01-02 到 2024-12-31。
- 进度检查（不看净值）：数一下 `runs/<id>/day-*.json` 的数量。
- 异常监控：如果某个选手连续 5 天 `formatNotes` 非空，停下记录，问 UP 主（不要自行修改提示词）。

## 5. 收尾

```
node pipeline/src/awards.ts          :: 生成 out/stats.json、out/awards.json（默认不打印名次）
node pipeline/src/build-viz.ts       :: 生成含 AI 结果的 viz/data.js —— 生成后不要打开，等 UP 主
```
- 确认 8 个选手都已“赛季结束”或“已出局”（`awards.ts` 会列出没跑完的）。
- `git commit`：`ep02: 正式比赛数据`（`runs/` 体积大的话按 ep01 的 .gitignore 规则处理 raw 输出）。
- 向 UP 主报告：每个选手的完成状态、总耗时、formatNotes 天数、重试次数、任何异常。**不报告名次和净值**，等 UP 主说“看结果”再给。

## 6. 执行日志（执行者填写）

| 时间 | 事项 | 备注 |
|---|---|---|
| 2026-11-22 | 规则冻结 sha256 | rules.json `eceea7a0…3ecb`；market.json `0f3f4884…a475`；awards.json `f03ff7ba…b235`；contestants.json `2794015a…4186`；usdjpy-2024.csv `b9edc48f…650e`；engine.ts `0a174d50…e922`；market.ts `bf7d442e…0941`；task.ts `7a649950…6030`（全长见下方）。仓库不是 git 仓库，未 commit |
| 2026-11-22 | 基线看板 | `build-viz --bots-only` 正常，6 个基线；满杠杆复利机首次强平 2024-04-29，与预期一致 |
| 2026-11-22 | dry run 结果 | `runs-dryrun/`，4 个渠道各 2 天（claude-opus-5.5 / gpt-6.2-sol / gemini-4-hydrogen / grok-4.7）：全部 exit 0、JSON 可解析、formatNotes 为空、无重试；prompt 无日期/货币名泄漏，价格区间 100.4~107.7。单次耗时约 claude 10s、gpt-sol 15s、gemini-hy 23s、grok 76–182s |
| 2026-11-22 | 正式开跑 | 7 个独立 cmd 窗口（最小化）：astra、sol、neon、hydrogen、grok、deepseek 各一个，claude-opus-5.5 → glm-5.3 串行一个（devin 渠道同时最多 2 路）。日志在 `.local/ep02-logs/`（含净值，盲测期间不给 UP 主看）；盲测安全的进度：`node .local/ep02-progress.js` |
| | 异常 / 作废记录 | |
| | 完成 | |

### 冻结 sha256 全长（2026-11-22）
```
eceea7a0c801e4e15f50ef70287606eaf134cb92a000c06f9469deb02a773ecb  config/rules.json
0f3f4884cff15ed94fc86b5c495584e84c0854c3c133907bcaf57964b586a475  config/market.json
f03ff7ba2fd71841bb851e7cab2e4e70fa7a02c1e7bc51efd64756b1372bb235  config/awards.json
2794015af471b0777eab9fc42e63098c2b41b9e718c4399f9c13b10a3dfb4186  config/contestants.json
b9edc48f39dc438c9914dbaeb3b714e20d4496ba74b23c765d9f97c226c5650e  data/usdjpy-2024.csv
0a174d50137f2080b9ae86f2a3d5612f9c488598a4b56639b37345013b68e922  src/engine.ts
bf7d442e70b423a8144c6b30c24434aa41fb268d1e645829df787f1f72ab0941  src/market.ts
7a6499a0dcdaf2116875328022324f5a939452e7acedb9ad0298350261686030  src/task.ts
```

- 2026-11-22 23:56（台北时间）半小时巡检发现 Gemini Neon 已推进至第 250 天，第 230–250 天连续 21 天有 formatNotes，累计重试 42 次。按异常监控规则停止 Neon 的逐日进程，保留正式赛记录，等待 UP 主决定。其余选手继续按原安排运行。

- 2026-11-23，UP 主确认额度刷新后从交易日 230 续跑。旧目录完整保存在 pipeline/runs-archive/gemini-4-neon.void-20261123，正式目录保留前 229 天。用冻结引擎重放已保存决策，逐日核对事件与收盘净值，并验证交易日 230 的完整输入与首次调用一致。预约 01:43（台北时间）核验额度后续跑。调用层收到 Individual quota reached 且无输出时在结算前退出。
- 2026-11-23 02:09（台北时间）核验 Gemini Neon 已正常完成 262 个交易日。01:43 额度刷新后从第 230 天续跑，第 230–262 天共 33 份原始输出均含有效决策，与逐日结算记录对应，格式异常 0 天、重试 0 次。初始 1,000,000 日元，最终收盘净值 7,552,475 日元，累计收益率 +655.25%。Neon 进程已退出。
- 2026-11-23 16:54（台北时间）恢复 Grok。原日志显示 05:45 写入第 241 天原始输出时 F 盘已满（ENOSPC），留下空文件；第 240 天收盘存档完整。确认 F 盘可用约 16.7 GiB 且无旧进程后，保留空文件副本，从原存档单进程续跑。新日志在 .local/ep02-logs/grok-resume-20261123-165440.*。
- 续跑核验：第 241 天已取得有效模型输出并完成结算，首次调用成功、格式异常 0、重试 0，进程继续运行。
