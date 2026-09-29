/**
 * tools/i18n-audit.js — i18n 覆盖自动审计（v39 起，可反复运行）
 *
 * 扫描 public/js/*.js 中含中文的字符串字面量，找出「疑似漏翻」的动态文案：
 *   - 字面量已是 JS_EN 词典键 → 认为已覆盖（跳过）
 *   - 字面量直接作为 I18N.T(...) 的实参 → 已覆盖（跳过）
 *   - 其余 → 报告文件:行号 + 原文，人工确认是否需要包 I18N.T / 加词条
 *
 * 用法：node tools/i18n-audit.js   （报告工具，永远退出码 0）
 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'server', 'public');
const FILES = ['js/app.js', 'js/board.js', 'js/api.js', 'js/fx.js', 'js/qr.js'];

// 从 i18n.js 抽 JS_EN 词典键：形如 '中文': 'English'
const i18nSrc = fs.readFileSync(path.join(PUB, 'js', 'i18n.js'), 'utf8');
const dictKeys = new Set();
const dictRe = /['"]([^'"]*[\u4e00-\u9fff][^'"]*)['"]\s*:\s*['"][^'"]*['"]/g;
let m;
while ((m = dictRe.exec(i18nSrc))) dictKeys.add(m[1]);

const CJK = /[\u4e00-\u9fff]/;
let total = 0, covered = 0;
const findings = [];

for (const rel of FILES) {
  const abs = path.join(PUB, rel);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const no = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return; // 注释
    const litRe = /(['"])([^'"\n]*[\u4e00-\u9fff][^'"\n]*)\1/g;
    let lm;
    while ((lm = litRe.exec(line))) {
      const raw = lm[2];
      if (!CJK.test(raw)) continue;
      total++;
      // 直接是 I18N.T 实参：I18N.T('...') 紧邻
      const before = line.slice(0, lm.index).trimEnd();
      if (/I18N\.T\(\s*$/.test(before)) { covered++; continue; }
      if (dictKeys.has(raw)) { covered++; continue; }
      findings.push({ file: rel, line: no, text: raw, inI18NLine: /I18N\.T\(/.test(line) });
    }
  });
}

console.log('扫描 ' + FILES.length + ' 个前端 JS，中文字面量 ' + total + ' 处，已覆盖 ' + covered + ' 处，疑似漏翻 ' + findings.length + ' 处：\n');
const seen = new Set();
for (const f of findings) {
  const key = f.file + ':' + f.text;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log('  ' + f.file + ':' + f.line + (f.inI18NLine ? ' [行内混拼]' : '') + '  ' + f.text.slice(0, 80));
}
console.log('\n（「行内混拼」= 该行有 I18N.T 但这个字面量不在其中，可能是拼接的半句；重复文案已去重）');
