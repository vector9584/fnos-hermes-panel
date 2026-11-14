/* esc_equiv.mjs — 转义层等价性验证
 *
 * 目的：把 6 处 esc 收归 core/dom.js 之后，必须证明新实现和旧实现
 * 对任意输入输出逐字节一致。不是"看着对"，是跑出来对。
 *
 * 用法：node esc_equiv.mjs
 */
import fs from "node:fs";
import path from "node:path";

const UI = "/vol1/@apphome/hermes-agent/data/workspace/fnos-hermes-agent-src/app/ui";

// 旧实现原样搬过来，作为基准
const oldEsc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oldEscapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const oldEsc30 = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 从 dom.js 里取出新实现（不引 jsdom，直接 eval 那个 IIFE 的返回值）
const src = fs.readFileSync(path.join(UI, "js/core/dom.js"), "utf8");
let DOM;
new Function("window", src)({ set DOM(v) { DOM = v; }, get DOM() { return DOM; } });

// 语料：正常、边界、攻击向量、emoji、Unicode、超长
const corpus = [
  "", " ", "abc", "中文测试", "<b>粗体</b>", "a & b", "<script>alert(1)</script>",
  `"><img src=x onerror=alert(1)>`, `' onmouseover='alert(1)`, `"双引号"`, `'单引号'`,
  "&amp;", "&lt;", "&#39;", "&", "<", ">", '"', "'",
  "行1\n行2", "制表\t符", "😀🎉🐳", "𝕳𝖊𝖗𝖒𝖊𝖘", "日本語テスト",
  "x".repeat(5000), null, undefined, 0, false, 123, { a: 1 }, [1, 2],
  "`反引号`", "\\\\反斜杠", "${模板}", "%00空字节", "\u0000"
];

let pass = 0, fail = 0;
const failures = [];

function check(name, oldFn, newFn) {
  corpus.forEach((input) => {
    const a = oldFn(input);
    const b = newFn(input);
    if (a === b) { pass++; }
    else {
      fail++;
      failures.push({ name, input: String(input).slice(0, 40), old: a.slice(0, 80), new: b.slice(0, 80) });
    }
  });
  console.log(`  ${oldFn(input => input) === undefined ? "" : ""}${name}: ${corpus.length} 例`);
}

check("esc (279 处调用点)", oldEsc, DOM.esc);
check("escapeHtml / escAttr", oldEscapeHtml, DOM.escAttr);
check("esc30 / escDouble", oldEsc30, DOM.escDouble);

// 关键回归：msgHTML 依赖 esc() 不转单引号
const q = `it's`;
if (DOM.esc(q) === `it's`) { pass++; console.log("  esc 不转单引号（msgHTML 内联 onclick 依赖）: OK"); }
else { fail++; console.log("  esc 不转单引号: FAIL —— 会破坏 msgHTML 的 replace(/'/g)"); }

// escAttr 必须转单引号
if (DOM.escAttr(q) === "it&#39;s") { pass++; console.log("  escAttr 转单引号: OK"); }
else { fail++; console.log("  escAttr 转单引号: FAIL"); }

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  passed=${pass} failed=${fail}  语料 ${corpus.length} 条`);
failures.slice(0, 5).forEach((f) => console.log("  !", JSON.stringify(f)));

// 源码里不许再有第二套实现
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith(".js") && !f.name.endsWith(".min.js")) files.push(p);
  }
})(path.join(UI, "js"));

const offenders = [];
const implRe = /function\s+(esc|escAttr|esc30|escapeHtml)\s*\(\s*s\s*\)\s*\{([\s\S]{0,320}?)\n\s*\}/g;
const ALLOW = ["js/core/dom.js"]; // 唯一允许有实现的地方
for (const f of files) {
  if (ALLOW.includes(path.relative(UI, f))) continue;
  const t = fs.readFileSync(f, "utf8");
  let m;
  while ((m = implRe.exec(t))) {
    if (!/DOM\.(esc|escAttr|escDouble)/.test(m[2])) {
      offenders.push(`${path.relative(UI, f)}: function ${m[1]}() 自建实现`);
    }
  }
}
console.log(offenders.length === 0 ? "\n无自建转义实现 ✅" : "\n仍有自建转义实现 ❌\n  " + offenders.join("\n  "));

process.exit(fail === 0 && offenders.length === 0 ? 0 : 1);
