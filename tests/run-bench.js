'use strict';

// ============================================================
// 基准套件：node tests/run-bench.js
// 1) AI 平衡性：四档 AI 同枱 N 局，验证胜率梯度（产品设计目标的数据证明）
// 2) 性能：引擎各操作耗时统计与阈值断言（大师档期望回推成本）
// ============================================================

const rules = require('../miniprogram/engine/rules.js');
const move = require('../miniprogram/engine/move.js');
const engine = require('../miniprogram/engine/engine.js');
const ai = require('../miniprogram/engine/ai.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(name + (detail ? ' :: ' + detail : ''));
  console.error('  ✗ ' + name + (detail ? ' :: ' + detail : ''));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 1) AI 平衡性 ----------
function benchBalance() {
  console.log('· AI 平衡性（四档同枱 300 局）');
  // 座位顺序有先手优势，轮转开局者对冲
  const GAMES = 300;
  const wins = [0, 0, 0, 0]; // seat0..3 胜场
  const LEVELS = [4, 3, 2, 1]; // 大师/困难/普通/简单
  const levelNames = ['大师', '困难', '普通', '简单'];
  const levelWins = { 4: 0, 3: 0, 2: 0, 1: 0 };

  for (let i = 0; i < GAMES; i++) {
    // 每局轮转座位分配（对冲先手优势）
    const shift = i % 4;
    const levels = [0, 1, 2, 3].map((s) => LEVELS[(s + shift) % 4]);
    const g = move.createGame({
      seats: [0, 1, 2, 3].map((s) => ({
        type: 'ai', openId: 'o' + s, nickName: 'P' + s, avatarUrl: '', aiLevel: levels[s]
      })),
      needExactFinish: true, allowJump: true, allowFly: true, allowItems: true
    });
    const rng = mulberry32(77000 + i);
    let cur = g;
    let guard = 0;
    while (cur.status === 'playing' && guard++ < 20000) {
      const seat = cur.currentSeat;
      if (cur.phase === 'rolling') {
        cur = engine.advance(cur, { type: 'ROLL', seat }, rng).state;
      } else {
        const pid = ai.choosePlane(cur, seat, cur.dice, levels[seat], rng);
        cur = engine.advance(cur, { type: 'SELECT_PLANE', seat, planeId: pid }, rng).state;
      }
    }
    if (cur.status !== 'finished') { check('平衡局完结 #' + i, false); return; }
    wins[cur.winner]++;
    levelWins[levels[cur.winner]]++;
  }

  const rates = [1, 2, 3, 4].map((lv) => (levelWins[lv] / GAMES * 100).toFixed(1) + '%');
  console.log('  各档胜率：简单 %s | 普通 %s | 困难 %s | 大师 %s', rates[0], rates[1], rates[2], rates[3]);

  // 断言：梯度成立（飞行棋随机性强，允许局部倒挂，但首尾必须分离）
  check('大师胜率高于简单', levelWins[4] > levelWins[1],
    'master=' + levelWins[4] + ' easy=' + levelWins[1]);
  check('大师胜率高于普通', levelWins[4] > levelWins[2],
    'master=' + levelWins[4] + ' normal=' + levelWins[2]);
  check('简单胜率垫底（低于其余三档均值）',
    levelWins[1] * 3 < levelWins[2] + levelWins[3] + levelWins[4],
    'easy=' + levelWins[1]);
}

// ---------- 2) 性能基准 ----------
function benchPerf() {
  console.log('· 引擎性能基准');

  // 2a) ROLL/SELECT 吞吐
  const g = move.createGame({
    seats: [0, 1, 2, 3].map((i) => ({ type: 'ai', openId: 'o' + i, nickName: 'P' + i, avatarUrl: '', aiLevel: 2 })),
    needExactFinish: true, allowJump: true, allowFly: true, allowItems: true
  });
  // 铺开棋子，制造多候选局面
  for (let s = 0; s < 4; s++) {
    for (let p = 0; p < 4; p++) {
      g.players[s].planes[p].state = 'track';
      g.players[s].planes[p].rp = (s * 13 + p * 9) % 50;
    }
  }
  const rng = mulberry32(42);
  let cur = move.cloneState(g);
  cur.phase = 'rolling';
  const t0 = Date.now();
  const N = 2000;
  let ops = 0;
  for (let i = 0; i < N; i++) {
    if (cur.phase === 'rolling') {
      const r = engine.advance(cur, { type: 'ROLL', seat: cur.currentSeat }, rng);
      if (r.ok) { cur = r.state; ops++; }
    } else {
      const pid = ai.choosePlane(cur, cur.currentSeat, cur.dice, 2, rng);
      const r = engine.advance(cur, { type: 'SELECT_PLANE', seat: cur.currentSeat, planeId: pid }, rng);
      if (r.ok) { cur = r.state; ops++; }
    }
  }
  const perOp = (Date.now() - t0) / ops;
  console.log('  普通 AI 行动：' + perOp.toFixed(3) + ' ms/步（' + ops + ' 步）');
  check('普通档行动 < 5ms/步', perOp < 5, perOp.toFixed(3) + 'ms');

  // 2b) 大师档评分（含期望回推）
  const masterState = move.cloneState(g);
  masterState.phase = 'selecting';
  masterState.dice = 4;
  const t1 = Date.now();
  const M = 500;
  for (let i = 0; i < M; i++) {
    ai.choosePlane(masterState, 0, 4, 4, rng);
  }
  const perMaster = (Date.now() - t1) / M;
  console.log('  大师档选机（含期望回推）：' + perMaster.toFixed(3) + ' ms/次');
  check('大师档选机 < 20ms/次', perMaster < 20, perMaster.toFixed(3) + 'ms');
  check('大师档不超过普通档 40 倍', perMaster < perOp * 40, perMaster.toFixed(3) + ' vs ' + perOp.toFixed(3));

  // 2c) cloneState 吞吐（CAS 写入路径热路径）
  const t2 = Date.now();
  for (let i = 0; i < 10000; i++) move.cloneState(g);
  const perClone = (Date.now() - t2) / 10000;
  console.log('  cloneState：' + perClone.toFixed(4) + ' ms/次');
  check('cloneState < 1ms/次', perClone < 1, perClone.toFixed(4) + 'ms');
}

// ---------- 汇总 ----------
function main() {
  console.log('=== 基准套件（平衡性 + 性能） ===');
  benchBalance();
  benchPerf();
  console.log('----------------------');
  console.log('通过 %d 项，失败 %d 项', passed, failed);
  if (failed > 0) {
    failures.forEach((f) => console.error(' - ' + f));
    process.exit(1);
  }
  console.log('✓ 基准全部通过');
}

main();
