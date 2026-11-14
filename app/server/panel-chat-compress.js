/* panel-chat-compress.js — 面板会话「真压缩」路由（2026-11-13）
 *
 * 面板的上下文真身是 ${VAR_DIR}/chat/sessions/<id>.json 的 messages：
 * monitor.js 的 buildChatHistory 就是拿它拼成 OpenAI messages 发给网关的。
 * 所以真压缩必须落在这个文件上，而不是往对话里塞一句「请把会话压缩成摘要」。
 *
 * 落地逻辑全在 panel-chat-compress.py 里（跑真 LLM 摘要、写回、备份），
 * 这里只负责：参数校验、并发锁、超时、错误翻译。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function createChatCompress(options = {}) {
  const sessionsDir = options.sessionsDir;
  const dataDir = options.dataDir;
  const serverDir = options.serverDir;
  const log = options.log || (() => {});
  const running = new Set(); // 同一会话不允许并发压缩（会互相覆盖写回）

  const scriptPath = options.scriptPath || (serverDir ? join(serverDir, "panel-chat-compress.py") : "panel-chat-compress.py");
  const pythonBin = (() => {
    const cand = dataDir ? join(dataDir, "venv", "bin", "python") : "";
    return cand && existsSync(cand) ? cand : "python3";
  })();

  function runScript(args, timeoutMs) {
    return new Promise((resolve) => {
      execFile(
        pythonBin,
        [scriptPath, ...args],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HERMES_DATA_DIR: dataDir || "" } },
        (err, stdout, stderr) => {
          const out = String(stdout || "").trim();
          const errText = String(stderr || "").trim();
          if (errText) log(`[compress] stderr: ${errText.slice(0, 600)}`);
          let parsed = null;
          // 脚本约定：最后一行是 JSON；前面是进度日志
          const lines = out.split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim().startsWith("{")) {
              try { parsed = JSON.parse(lines[i]); break; } catch (_) { /* 继续往前找 */ }
            }
          }
          if (err && err.killed) return resolve({ timeout: true, parsed, stderr: errText });
          resolve({ err, parsed, stderr: errText });
        }
      );
    });
  }

  return async function compress(body) {
    const sid = String((body && body.session_id) || "").trim();
    if (!SESSION_ID_RE.test(sid)) return { status: 400, json: { ok: false, error: "会话 id 不合法" } };
    if (!sessionsDir || !existsSync(join(sessionsDir, sid + ".json"))) {
      return { status: 404, json: { ok: false, error: "会话不存在" } };
    }
    if (running.has(sid)) return { status: 429, json: { ok: false, error: "这个会话正在压缩，等这一次跑完" } };

    const keepLast = Number(body.keep_last) || 0;
    const focus = String(body.focus || "").slice(0, 500);
    const preview = !!body.preview;

    const args = ["--session", sid, "--home", dataDir, "--chat-dir", require_dirname(sessionsDir)];
    if (keepLast > 0) args.push("--keep-last", String(Math.min(keepLast, 2000)));
    if (focus) args.push("--focus", focus);
    if (preview) args.push("--preview");

    running.add(sid);
    const started = Date.now();
    log(`[compress] start sid=${sid} preview=${preview} keep=${keepLast} focus=${focus ? "yes" : "no"}`);
    try {
      const r = await runScript(args, preview ? 60_000 : 360_000);
      const cost = Date.now() - started;
      if (r.timeout) {
        log(`[compress] timeout sid=${sid} after ${cost}ms`);
        return { status: 504, json: { ok: false, error: "压缩超时（模型太久没返回），原会话未改动" } };
      }
      if (r.parsed) {
        log(`[compress] done sid=${sid} ok=${r.parsed.ok} ${r.parsed.before_tokens || "?"}->${r.parsed.after_tokens || "?"} cost=${cost}ms`);
        const code = r.parsed.ok === false ? 422 : 200;
        return { status: code, json: { ...r.parsed, elapsed_ms: cost } };
      }
      log(`[compress] no-json sid=${sid} exit=${r.err ? r.err.code : 0} cost=${cost}ms`);
      return {
        status: 500,
        json: {
          ok: false,
          error: "压缩脚本没有返回结果" + (r.stderr ? ("：" + r.stderr.split("\n").slice(-2).join(" ").slice(0, 300)) : ""),
        },
      };
    } finally {
      running.delete(sid);
    }
  };
}

function require_dirname(p) {
  // sessionsDir 形如 .../chat/sessions → 脚本要的是 .../chat
  return p.replace(/\/sessions\/?$/, "");
}
