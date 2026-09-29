#!/usr/bin/env node
'use strict';

// ============================================================
// 同步引擎：把 miniprogram/engine（服务端需要的部分）复制到
// cloudfunctions/gameAction/engine，保证两端跑同一套规则代码。
// 用法：node tools/sync-engine.js   （每次改动 engine/ 后、部署云函数前执行）
// ============================================================

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'miniprogram', 'engine');

// 服务端需要的引擎子集：
//   gameAction → 全套（rules/move/ai/engine/achievements）
//   gameStart → 仅建局（rules/move）
//   aiTick → 定时器推进 AI（rules/move/ai/engine/achievements）
const TARGETS = [
  {
    dir: path.join(__dirname, '..', 'cloudfunctions', 'gameAction', 'engine'),
    files: ['rules.js', 'move.js', 'ai.js', 'engine.js', 'achievements.js']
  },
  {
    dir: path.join(__dirname, '..', 'cloudfunctions', 'gameStart', 'engine'),
    files: ['rules.js', 'move.js']
  },
  {
    dir: path.join(__dirname, '..', 'cloudfunctions', 'aiTick', 'engine'),
    files: ['rules.js', 'move.js', 'ai.js', 'engine.js', 'achievements.js']
  }
];
// board.js 是纯渲染几何，不复制

// 跨函数共享模块（源 → 副本列表）：
//   sec.js 以 login/ 为源；shared.js（CAS + 对局结算）以 gameAction/ 为源
const SHARED = [
  {
    src: path.join(__dirname, '..', 'cloudfunctions', 'login', 'sec.js'),
    dsts: [path.join(__dirname, '..', 'cloudfunctions', 'roomJoin', 'sec.js')]
  },
  {
    src: path.join(__dirname, '..', 'cloudfunctions', 'gameAction', 'shared.js'),
    dsts: [path.join(__dirname, '..', 'cloudfunctions', 'aiTick', 'shared.js')]
  }
];

let changed = 0;
for (const target of TARGETS) {
  fs.mkdirSync(target.dir, { recursive: true });
  for (const file of target.files) {
    const src = path.join(SRC, file);
    const dst = path.join(target.dir, file);
    const content = fs.readFileSync(src, 'utf8');
    const rel = path.relative(path.join(target.dir, '..'), src).split(path.sep).join('/');
    const header = '// [自动生成] 源文件 ' + rel +
      ' —— 请勿直接修改；改动请编辑源文件后运行 node tools/sync-engine.js\n';
    const body = content.replace(/^'use strict';\s*$/m, '').trim();
    const target2 = header + "'use strict';\n\n" + body + '\n';
    let existing = '';
    try { existing = fs.readFileSync(dst, 'utf8'); } catch (e) { /* 新文件 */ }
    if (existing !== target2) {
      fs.writeFileSync(dst, target2, 'utf8');
      changed++;
      console.log('已同步', target.dir.split(path.sep).pop() + '/' + file);
    }
  }
}

for (const item of SHARED) {
  const content = fs.readFileSync(item.src, 'utf8');
  for (const dst of item.dsts) {
    let existing = '';
    try { existing = fs.readFileSync(dst, 'utf8'); } catch (e) { /* 新文件 */ }
    if (existing !== content) {
      fs.writeFileSync(dst, content, 'utf8');
      changed++;
      console.log('已同步', path.relative(process.cwd(), dst));
    }
  }
}
console.log(changed > 0 ? '同步完成，更新 ' + changed + ' 个文件' : '引擎副本已是最新的');
