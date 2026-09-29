#!/usr/bin/env node
'use strict';

// ============================================================
// WXML 静态检查：拦截编译器不支持的模板语法
//  - {{}} 内的方法调用（如 .toFixed()）——真机编译错误
//  - 可选链 ?. / 空值合并 ?? / 模板字符串 / 箭头函数
// 用法：node tools/check-wxml.js（npm run check:wxml）
// 背景：v1.19.1 修复真机预览错误 mine.wxml toFixed 编译失败。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const fp = path.join(d, f);
    fs.statSync(fp).isDirectory() ? walk(fp) : files.push(fp);
  }
})(ROOT);

let bad = 0;

// {{}} 内出现 foo( 形式的方法调用（WXML 表达式不支持方法调用）
const methodCall = /\w+\s*\(/;

for (const f of files.filter((x) => x.endsWith('.wxml'))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);

  // 1) 插值内方法调用
  const exprs = src.match(/\{\{[^}]*\}\}/g) || [];
  for (const e of exprs) {
    if (methodCall.test(e) && !/wx:/.test(e)) {
      console.error('✗ 方法调用（WXML 不支持） ' + rel + ': ' + e.trim().slice(0, 90));
      bad++;
    }
  }

  // 2) 可选链 / 空值合并
  if (/\?\./.test(src)) {
    console.error('✗ 可选链 ?. ' + rel);
    bad++;
  }
  if (/\?\?/.test(src)) {
    console.error('✗ 空值合并 ?? ' + rel);
    bad++;
  }

  // 3) 模板字符串 / 箭头函数
  if (src.indexOf('`') >= 0) {
    console.error('✗ 模板字符串 ' + rel);
    bad++;
  }
  if (src.indexOf('=>') >= 0) {
    console.error('✗ 箭头函数 ' + rel);
    bad++;
  }

  // 4) 标签配平
  const stack = [];
  const re = /<\/?([a-zA-Z][\w-]*)((\"[^\"]*\"|'[^']*'|[^'\">])*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1];
    const close = m[0][1] === '/';
    const selfClose = /\/>$/.test(m[0]);
    if (close) {
      if (stack[stack.length - 1] === tag) stack.pop();
      else { console.error('✗ 标签不匹配 ' + rel + ': </' + tag + '>'); bad++; }
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  if (stack.length) {
    console.error('✗ 未闭合标签 ' + rel + ': ' + stack.join(','));
    bad++;
  }
}

if (bad > 0) {
  console.error('WXML 检查失败 x' + bad);
  process.exit(1);
}
console.log('✓ WXML 静态检查通过（%d 个文件）', files.filter((x) => x.endsWith('.wxml')).length);
