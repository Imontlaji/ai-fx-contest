// 从 ep01 的 run-cli.ts 原样抽出的渠道定义（CLI 参数、纯净环境），供逐日驱动复用
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type Channel = {
  bin: () => string;
  args: (model: string, prompt: string) => string[];
  env?: () => Record<string, string>;
  stdin?: boolean;
  shell?: boolean;
  lastMessageFile?: string;
};

const ROOT = resolve(import.meta.dirname, "../..");
const LOCAL = join(ROOT, "..", ".local");
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? "";
const CODEX_CLEAN_HOME = process.env.CODEX_CLEAN_HOME ?? join(process.env.USERPROFILE ?? "", ".codex-zhuangren");
// Cursor CLI 会强制加载 ~/.claude、~/.codex、~/.agents 下的 skills，且没有开关；换一个空的用户目录即可（登录态不受影响）
const CURSOR_CLEAN_HOME = process.env.CURSOR_CLEAN_HOME ?? join(process.env.USERPROFILE ?? "", ".cursor-zhuangren-home");

// PATH 上的 `agent` 是 Grok CLI，这里绕开 Cursor 的 cmd/ps1 包装，直接用它自带的 node 跑最新版本
function cursorAgentDir(): string {
  const versions = join(LOCALAPPDATA, "cursor-agent", "versions");
  const latest = readdirSync(versions, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.split("-")[0].split(".").map((p) => p.padStart(2, "0")).join("").localeCompare(
      b.split("-")[0].split(".").map((p) => p.padStart(2, "0")).join("")))
    .at(-1);
  if (!latest) throw new Error(`没有找到 Cursor CLI 版本目录：${versions}`);
  return join(versions, latest);
}

// Devin 会往 --config 指定的文件里回写登录信息，所以放在 gitignore 的 .local/ 里长期复用
function devinCleanConfig(): string {
  const file = join(LOCAL, "devin-clean.json");
  if (!existsSync(file)) {
    mkdirSync(LOCAL, { recursive: true });
    const off = ["agents_standard", "cursor", "windsurf", "claude", "copilot", "codex", "kiro", "opencode", "zed", "cloud"];
    writeFileSync(file, JSON.stringify({ version: 1, read_config_from: Object.fromEntries(off.map((k) => [k, false])) }, null, 2));
  }
  return file;
}

export const CHANNELS: Record<string, Channel> = {
  devin: {
    bin: () => "devin",
    args: (m) => ["--config", devinCleanConfig(), "-p", "--model", m, "--prompt-file", "task.md", "--respect-workspace-trust", "false"],
    shell: true,
  },
  codex: {
    bin: () => "codex",
    args: (m) => [
      "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
      "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false", "-c", "model_reasoning_effort=medium",
      "-s", "read-only", "-m", m, "-o", "last.txt", "-",
    ],
    // 专用的干净 CODEX_HOME（不含全局 AGENTS.md），放在项目外，避免登录凭据随仓库外泄
    env: () => (existsSync(join(CODEX_CLEAN_HOME, "auth.json")) ? { CODEX_HOME: CODEX_CLEAN_HOME } : {}),
    stdin: true,
    shell: true,
    lastMessageFile: "last.txt",
  },
  agy: {
    bin: () => join(LOCALAPPDATA, "agy", "bin", "agy.exe"),
    args: (m, prompt) => ["-p", prompt, "--model", m, "--output-format", "text"],
  },
  cursor: {
    bin: () => join(cursorAgentDir(), "node.exe"),
    args: (m, prompt) => [join(cursorAgentDir(), "index.js"), "-p", prompt, "--mode", "ask", "--trust", "--model", m, "--output-format", "text"],
    env: () => {
      mkdirSync(CURSOR_CLEAN_HOME, { recursive: true });
      return { CURSOR_INVOKED_AS: "cursor-agent.cmd", USERPROFILE: CURSOR_CLEAN_HOME, HOME: CURSOR_CLEAN_HOME };
    },
  },
};

