#!/usr/bin/env node
/**
 * Hermes 面板 · 跨平台启动器
 *
 *   node bin/hermes-panel.mjs            默认 8650 端口，起来自动开浏览器
 *   node bin/hermes-panel.mjs --port 9000
 *   node bin/hermes-panel.mjs --no-open  只起服务不弹浏览器
 *   node bin/hermes-panel.mjs --data ~/hermes-data
 *
 * 环境变量优先级：命令行参数 > 已有环境变量 > 默认值
 * 数据目录默认 ~/.hermes-panel/data，跟面板代码分开，升级不丢配置。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const APP_DIR = join(REPO, "app");
const MONITOR = join(APP_DIR, "server", "monitor.js");

// ─── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const wantedPort = Number(opt("--port", process.env.UI_PORT || "8650"));
const dataDir = resolve(opt("--data", process.env.HERMES_DATA_DIR || join(homedir(), ".hermes-panel", "data")));
const varDir = resolve(opt("--var", process.env.HERMES_VAR_DIR || join(dataDir, "..", "var")));
const openBrowser = !flag("--no-open");

if (!existsSync(MONITOR)) {
  console.error(`[ERR] 找不到 ${MONITOR}`);
  console.error(`      这个脚本要放在仓库的 bin/ 目录下跑。`);
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(varDir, { recursive: true });

// ─── 找空闲端口 ──────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise((ok) => {
    const s = http.createServer();
    s.once("error", () => ok(false));
    s.once("listening", () => s.close(() => ok(true)));
    s.listen(port, "127.0.0.1");
  });
}
let port = wantedPort;
for (let i = 0; i < 20; i++) {
  if (await portFree(port)) break;
  port++;
}

// ─── 起 monitor ─────────────────────────────────────────────────────────
const env = {
  ...process.env,
  APP_DIR,
  DATA_DIR: dataDir,
  VAR_DIR: varDir,
  UI_PORT: String(port),
  // 不给 MONITOR_SOCKET_PATH → 纯 TCP 模式，Windows 也能跑
};
delete env.MONITOR_SOCKET_PATH;

const child = spawn(process.execPath, [MONITOR], {
  cwd: join(APP_DIR, "server"),
  env,
  stdio: ["ignore", "inherit", "inherit"],
});

const URL = `http://127.0.0.1:${port}/`;
console.log(`[面板] 代码目录 ${APP_DIR}`);
console.log(`[面板] 数据目录 ${dataDir}`);
console.log(`[面板] 正在启动，端口 ${port} ...`);

// ─── 等端口通了再开浏览器 ────────────────────────────────────────────────
let tries = 0;
const timer = setInterval(() => {
  tries++;
  const req = http.get(URL, (res) => {
    res.resume();
    clearInterval(timer);
    console.log(`[面板] 就绪 → ${URL}`);
    if (openBrowser) {
      const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "cmd" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", URL] : [URL];
      try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch {}
    }
    console.log(`[面板] Ctrl+C 停止`);
  });
  req.on("error", () => {
    if (tries > 60) {
      clearInterval(timer);
      console.error(`[面板] 等了 30 秒还没起来，看上面的报错`);
      child.kill();
      process.exit(1);
    }
  });
}, 500);

const stop = () => { try { child.kill("SIGTERM"); } catch {} setTimeout(() => process.exit(0), 300); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => { clearInterval(timer); process.exit(code ?? 0); });
