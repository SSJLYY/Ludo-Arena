'use strict';

// ============================================================
// 引擎测试：node tests/run-tests.js
// 1) 规则单元测试（起飞/跳格/撞子/安全格/精确到达/弹回/连掷6/叠子/胜负）
// 2) 自动对战模拟 1000 局（4 AI 混合难度），校验无死循环、无非法状态
//
// 坐标速查（座位0=红，START_OFFSET=51，abs=(51+rp)%52）：
//   红 rp ≡ 0 (mod 4) 为己色格（rp 0,4,...,48），落己色格跳 +4（rp+4≤51 才跳）
//   黄 abs=(12+yp)%52，蓝 abs=(25+bp)%52，绿 abs=(38+gp)%52
// ============================================================

const rules = require('../miniprogram/engine/rules.js');
const move = require('../miniprogram/engine/move.js');
const engine = require('../miniprogram/engine/engine.js');
const ai = require('../miniprogram/engine/ai.js');
const board = require('../miniprogram/engine/board.js');

// ---------- 可复现随机 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 测试脚手架 ----------
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  const line = '  ✗ ' + name + (detail ? ' :: ' + detail : '');
  failures.push(line);
  console.error(line);
}

function eq(name, actual, expected) {
  check(name, actual === expected, 'actual=' + actual + ' expected=' + expected);
}

function fakeSeats() {
  return [0, 1, 2, 3].map((i) => ({
    type: 'ai', openId: 'o' + i, nickName: 'P' + i, avatarUrl: '', aiLevel: 2
  }));
}

function newGame(opt) {
  return move.createGame(Object.assign({ seats: fakeSeats() }, opt || {}));
}

function setPlane(g, seat, planeId, state, rp) {
  g.players[seat].planes[planeId].state = state;
  g.players[seat].planes[planeId].rp = rp;
}

// ---------- 规则常量与棋盘布局 ----------
function testRules() {
  console.log('· rules.js / board.js');
  eq('主环 52 格', rules.TRACK_LEN, 52);
  eq('归航道 5 格', rules.LANE_LEN, 5);
  eq('终点步数 57', rules.HOME_RP, 57);
  eq('红起飞点 abs=51', rules.START_OFFSET[0], 51);
  eq('黄起飞点 abs=12', rules.START_OFFSET[1], 12);
  eq('蓝起飞点 abs=25', rules.START_OFFSET[2], 25);
  eq('绿起飞点 abs=38', rules.START_OFFSET[3], 38);
  eq('安全格即四个起飞点', rules.SAFE_ABS.join(','), [51, 12, 25, 38].join(','));

  for (let s = 0; s < 4; s++) {
    let own = 0;
    for (let abs = 0; abs < 52; abs++) if (rules.colorOfAbs(abs) === s) own++;
    eq('座位' + s + '拥有13格', own, 13);
    check('座位' + s + '起飞点为己色', rules.colorOfAbs(rules.START_OFFSET[s]) === s);
    check('座位' + s + '起飞点为安全格', rules.isSafeAbs(rules.START_OFFSET[s]));
    for (let rp = 0; rp <= 48; rp += 4) {
      check('座位' + s + ' rp' + rp + ' 为己色格', rules.isOwnColor(s, rp));
    }
    for (let rp = 1; rp <= 51; rp++) {
      if (rp % 4 !== 0) check('座位' + s + ' rp' + rp + ' 非己色格', !rules.isOwnColor(s, rp));
    }
  }

  const L = board.layout(300);
  eq('棋盘主环格数', L.track.length, 52);
  for (let s = 0; s < 4; s++) {
    eq('座位' + s + '归航道5格', L.lanes[s].length, 5);
    eq('座位' + s + '停机位4个', L.bases[s].length, 4);
    // rp51 必落在归航道入口格，且入口格与航道第1格正交相邻
    const entrance = board.TRACK[rules.absOfRp(s, 51)];
    const laneHead = board.LANES[s][0];
    check('座位' + s + '航道口相邻', Math.abs(entrance[0] - laneHead[0]) + Math.abs(entrance[1] - laneHead[1]) === 1,
      JSON.stringify([entrance, laneHead]));
    // 起飞点与归航道口相邻（起飞/进港在同一臂根）
    const takeoff = board.TRACK[rules.START_OFFSET[s]];
    check('座位' + s + '起飞点与航道口相邻',
      Math.abs(takeoff[0] - entrance[0]) + Math.abs(takeoff[1] - entrance[1]) === 1);
  }
}

// ---------- 单步规则 ----------
function testMoveMechanics() {
  console.log('· move.js 机制');

  // —— 起飞 ——
  let g = newGame();
  eq('未掷6不能起飞', move.planMove(g, 0, 0, 3), null);
  const takeoff = move.planMove(g, 0, 0, 6);
  eq('掷6可起飞', takeoff.kind, 'takeoff');
  eq('起飞落己色格→跳至 rp4', takeoff.finalRp, 4);
  eq('起飞路径 [0,4]', takeoff.path.join(','), '0,4');
  eq('空盘起飞不撞子', takeoff.kills.length, 0);

  // 起飞跳过格上的敌机不受影响（只判最终落点）
  let g2 = newGame();
  setPlane(g2, 1, 0, 'track', 41); // 黄 abs=(12+41)%52=1，在起飞跳跃路径上
  const pass = move.planMove(g2, 0, 0, 6);
  eq('跳跃越过格不撞', pass.kills.length, 0);

  // 起飞最终落点撞子（rp4 → abs3）
  let g3 = newGame();
  setPlane(g3, 1, 0, 'track', 43); // 黄 abs=(12+43)%52=3
  const tk = move.planMove(g3, 0, 0, 6);
  eq('起飞落点撞子', tk.kills.length, 1);
  eq('撞的是黄0', tk.kills[0].seat, 1);

  // —— 跳格 ——
  let g4 = newGame();
  setPlane(g4, 0, 0, 'track', 0);
  const j1 = move.planMove(g4, 0, 0, 4); // 落 rp4(己色) → 跳 rp8
  eq('红掷4落rp4跳至rp8', j1.finalRp, 8);
  check('跳格路径含 rp8', j1.path.indexOf(8) >= 0);

  setPlane(g4, 0, 0, 'track', 44);
  const j2 = move.planMove(g4, 0, 0, 4); // 落 rp48(己色)，但 48+4>51 → 不跳
  eq('rp48 己色格但不再跳', j2.jump, null);
  eq('最终落 rp48', j2.finalRp, 48);

  const g5 = newGame({ allowJump: false });
  setPlane(g5, 0, 0, 'track', 0);
  eq('关闭跳格开关后不跳', move.planMove(g5, 0, 0, 4).jump, null);

  // —— 精确到达 / 弹回 ——
  let g6 = newGame();
  setPlane(g6, 0, 0, 'lane', 55);
  eq('精确到达：需2掷3不可动', move.planMove(g6, 0, 0, 3), null);
  eq('精确到达：掷2到终点', move.planMove(g6, 0, 0, 2).finalRp, 57);
  const g7 = newGame({ needExactFinish: false });
  setPlane(g7, 0, 0, 'lane', 55);
  const bounce = move.planMove(g7, 0, 0, 3);
  eq('弹回模式：55+3 → 56', bounce.finalRp, 56);
  check('弹回路径经过 57', bounce.path.indexOf(57) >= 0);
  eq('弹回落归航道', bounce.finalState, 'lane');

  // —— 撞子 / 安全格 ——
  let g8 = newGame();
  setPlane(g8, 0, 0, 'track', 20); // 红 20+1=21 → abs20（黄格，不跳）
  setPlane(g8, 1, 0, 'track', 8);  // 黄 rp8 → abs20 同格
  const direct = move.planMove(g8, 0, 0, 1);
  eq('直接落点撞子', direct.kills.length, 1);
  eq('撞的是黄0', direct.kills[0].seat, 1);
  const st2 = move.cloneState(g8);
  move.applyPlan(st2, direct);
  eq('被撞回基地', st2.players[1].planes[0].rp, -1);
  eq('击杀计数', st2.players[0].stats.kills, 1);
  eq('被杀计数', st2.players[1].stats.beenKilled, 1);

  let g9 = newGame();
  setPlane(g9, 1, 0, 'track', 0);  // 黄在己起飞点 abs12（安全格）
  setPlane(g9, 0, 0, 'track', 12); // 红 12+1=13 → abs12 落安全格
  const safe = move.planMove(g9, 0, 0, 1);
  eq('安全格不撞子', safe.kills.length, 0);
  eq('安全格非己色不跳', safe.jump, null);

  // —— 叠子 ——
  let g10 = newGame();
  setPlane(g10, 1, 0, 'track', 8);
  setPlane(g10, 1, 1, 'track', 8); // 黄叠子 abs20
  setPlane(g10, 0, 0, 'track', 20);
  const stackKill = move.planMove(g10, 0, 0, 1);
  eq('撞中叠子两架一起回基地', stackKill.kills.length, 2);
  const st3 = move.cloneState(g10);
  move.applyPlan(st3, stackKill);
  eq('黄0回基地', st3.players[1].planes[0].rp, -1);
  eq('黄1回基地', st3.players[1].planes[1].rp, -1);
  eq('击杀+2', st3.players[0].stats.kills, 2);

  let g11 = newGame();
  setPlane(g11, 0, 0, 'track', 2);
  setPlane(g11, 0, 1, 'track', 6); // 红1 rp6 → abs5
  const stackSelf = move.planMove(g11, 0, 0, 4); // 红0 2+4=6 → abs5 同格
  eq('己方叠子标记', stackSelf.stackedWith.join(','), '1');

  // —— 飞行箭头（v1.1）——
  // 箭头格 = 每色 rp36（红 abs=(51+36)%52=35，35%4=3 红 ✓），飞跃 12 至 rp48
  let gf = newGame();
  setPlane(gf, 0, 0, 'track', 32);
  const flyPlan = move.planMove(gf, 0, 0, 4); // 32+4=36 箭头格 → 飞 12
  eq('落箭头格 rp36 飞至 rp48', flyPlan.finalRp, 48);
  eq('飞越标记 fly=48', flyPlan.fly, 48);
  eq('飞跃不与跳格并存', flyPlan.jump, null);
  check('飞跃路径 [33..36,48]', flyPlan.path.join(',') === '33,34,35,36,48', flyPlan.path.join(','));

  const gf2 = newGame({ allowFly: false });
  setPlane(gf2, 0, 0, 'track', 32);
  const noFly = move.planMove(gf2, 0, 0, 4);
  eq('关闭飞箭后落36仍跳格至40', noFly.finalRp, 40);
  eq('无 fly 标记', noFly.fly, null);

  let gf3 = newGame();
  setPlane(gf3, 1, 0, 'track', 35); // 黄 rp35 → abs(12+35)%52=47 = 红飞越落点
  setPlane(gf3, 0, 0, 'track', 32);
  const flyKill = move.planMove(gf3, 0, 0, 4);
  eq('飞跃落点撞子', flyKill.kills.length, 1);

  let gf4 = newGame();
  setPlane(gf4, 1, 0, 'track', 28); // 黄 rp28 → abs40，在飞跃越过的区间内
  setPlane(gf4, 0, 0, 'track', 32);
  const flyOver = move.planMove(gf4, 0, 0, 4);
  eq('飞跃越过格不撞（只判落点）', flyOver.kills.length, 0);

  setPlane(gf, 0, 1, 'track', 48);
  const flyStack = move.planMove(gf, 0, 0, 4); // 飞跃落点与己方同格
  eq('飞跃落点叠子标记', flyStack.stackedWith.join(','), '1');

  // —— 可动计算 ——
  const g12 = newGame();
  setPlane(g12, 0, 0, 'base', -1);
  setPlane(g12, 0, 1, 'track', 10);
  setPlane(g12, 0, 2, 'lane', 55);
  setPlane(g12, 0, 3, 'home', 57);
  eq('掷6：基地+轨道+航道(55+6弹回关)不可', move.computeMovable(g12, 0, 6).join(','), '0,1');
  eq('掷2：轨道可动+55精确到57', move.computeMovable(g12, 0, 2).join(','), '1,2');
  eq('掷1：轨道+55可进港', move.computeMovable(g12, 0, 1).join(','), '1,2');
  eq('掷5：55不可精确超出', move.computeMovable(g12, 0, 5).join(','), '1');
  const g13 = newGame({ needExactFinish: false });
  setPlane(g13, 0, 2, 'lane', 55);
  eq('弹回模式 55+5 可动', move.computeMovable(g13, 0, 5).join(','), '2');
}

// ---------- 回合状态机 ----------
function testEngineTurns() {
  console.log('· engine.js 回合');

  // 连掷 3 个 6 作废本回合（rng 返回 0.99 → dice=6）
  let g = newGame();
  setPlane(g, 0, 0, 'track', 0);
  let r = engine.advance(g, { type: 'ROLL', seat: 0 }, () => 0.99);
  eq('第1个6进入选择', r.state.phase, 'selecting');
  r = engine.advance(r.state, { type: 'SELECT_PLANE', seat: 0, planeId: 0 }, () => 0.99);
  eq('掷6移动后仍归本方', r.state.currentSeat, 0);
  const r2 = engine.advance(r.state, { type: 'ROLL', seat: 0 }, () => 0.99);
  eq('第2个6计数', r2.state.consecutiveSix, 2);
  // 第2个6后进入选择，先选机（1号机起飞）再掷第3个6
  r = engine.advance(r2.state, { type: 'SELECT_PLANE', seat: 0, planeId: 1 }, () => 0.99);
  eq('起飞后仍归本方', r.state.currentSeat, 0);
  r = engine.advance(r.state, { type: 'ROLL', seat: 0 }, () => 0.99);
  eq('第3个6作废并换人', r.state.currentSeat, 1);
  check('作废事件存在', r.events.some((e) => e.type === 'void'));

  // 无子可动自动跳过
  let g2 = newGame();
  setPlane(g2, 0, 0, 'lane', 56);
  r = engine.advance(g2, { type: 'ROLL', seat: 0 }, () => 0.5); // dice=4
  eq('无子可动换人', r.state.currentSeat, 1);
  check('跳过事件存在', r.events.some((e) => e.type === 'skip'));

  // 唯一可动自动执行
  let g3 = newGame();
  setPlane(g3, 0, 0, 'track', 10);
  r = engine.advance(g3, { type: 'ROLL', seat: 0 }, () => 0.5); // dice=4
  check('唯一可动自动移动', r.events.some((e) => e.type === 'move'));
  eq('无额外掷骰换人', r.state.currentSeat, 1);

  // 撞子获得额外掷骰
  let g4 = newGame();
  setPlane(g4, 0, 0, 'track', 20);
  setPlane(g4, 1, 0, 'track', 8);
  r = engine.advance(g4, { type: 'ROLL', seat: 0 }, () => 0); // dice=1
  eq('撞子后仍归本方', r.state.currentSeat, 0);
  eq('extraRollLeft=1', r.state.extraRollLeft, 1);
  check('移动事件带撞子', r.events.some((e) => e.type === 'move' && e.kills.length === 1));

  // 非法动作
  let g5 = newGame();
  eq('非当前座位被拒', engine.advance(g5, { type: 'ROLL', seat: 1 }, () => 1).error, 'NOT_YOUR_TURN');
  eq('错误阶段被拒', engine.advance(g5, { type: 'SELECT_PLANE', seat: 0, planeId: 0 }, () => 1).error, 'ILLEGAL_ACTION');

  // runAiTurn：一次调用跑完一个座位的整回合
  const g6 = newGame();
  const steps = engine.runAiTurn(g6, mulberry32(42), () => 2);
  check('AI回合产生步骤', steps.length >= 1);
  const last = steps[steps.length - 1].state;
  check('AI回合结束已换人', last.currentSeat !== 0 || last.status === 'finished');

  // 胜负与排名：座位2 三机到港，最后一机 rp56 掷1 进终点
  const g7 = newGame();
  for (let id = 0; id < 3; id++) setPlane(g7, 2, id, 'home', 57);
  g7.players[2].finishedCount = 3;
  g7.finishCounter = 3;
  setPlane(g7, 2, 3, 'lane', 56);
  setPlane(g7, 0, 0, 'track', 30);

  // 随机推进到座位2的回合（其余座位只会空转几步，不可能取胜）
  let cur = g7;
  for (let i = 0; i < 30 && cur.currentSeat !== 2; i++) {
    const seat = cur.currentSeat;
    if (cur.phase === 'rolling') {
      cur = engine.advance(cur, { type: 'ROLL', seat }, mulberry32(100 + i)).state;
    } else {
      const pid = ai.choosePlane(cur, seat, cur.dice, 2, mulberry32(200 + i));
      cur = engine.advance(cur, { type: 'SELECT_PLANE', seat, planeId: pid }, mulberry32(300 + i)).state;
    }
  }
  eq('轮转到座位2', cur.currentSeat, 2);
  eq('座位2仍在掷骰阶段', cur.phase, 'rolling');
  cur = engine.advance(cur, { type: 'ROLL', seat: 2 }, () => 0).state; // dice=1 → 唯一可动自动进终点
  eq('4机到齐获胜', cur.winner, 2);
  eq('对局结束', cur.status, 'finished');
  eq('排名首位', cur.ranking[0], 2);
  eq('排名包含4人', cur.ranking.length, 4);
  eq('结束后拒绝行动', engine.advance(cur, { type: 'ROLL', seat: cur.currentSeat }, () => 1).error, 'GAME_ENDED');
  eq('完成序号=4', cur.players[2].finishRank, 4);
}

// ---------- 状态合法性（模拟用） ----------
function validateState(g, tag) {
  const seenAbs = {};
  for (let s = 0; s < g.players.length; s++) {
    const p = g.players[s];
    if (p.planes.length !== 4) check(tag + ' 座位' + s + ' 4机', false);
    for (const pl of p.planes) {
      if (pl.state === 'base') {
        if (pl.rp !== -1) check(tag + ' base rp=-1', false, 'rp=' + pl.rp);
      } else if (pl.state === 'track') {
        if (pl.rp < 0 || pl.rp > 51) check(tag + ' track rp 0..51', false, 'rp=' + pl.rp);
        const abs = rules.absOfRp(s, pl.rp);
        if (seenAbs[abs] !== undefined && seenAbs[abs] !== s) {
          if (!rules.isSafeAbs(abs)) check(tag + ' 非安全格不共存异色机', false, 'abs=' + abs);
        }
        seenAbs[abs] = s;
      } else if (pl.state === 'lane') {
        if (pl.rp < 52 || pl.rp > 56) check(tag + ' lane rp 52..56', false, 'rp=' + pl.rp);
      } else if (pl.state === 'home') {
        if (pl.rp !== 57) check(tag + ' home rp=57', false, 'rp=' + pl.rp);
      } else {
        check(tag + ' 未知状态', false, pl.state);
      }
    }
    if (p.finishRank !== null && (p.finishRank < 1 || p.finishRank > 4)) {
      check(tag + ' finishRank 合法', false, String(p.finishRank));
    }
  }
  if (g.currentSeat < 0 || g.currentSeat > 3) check(tag + ' currentSeat 0..3', false);
}

function validateEvent(ev, tag) {
  if (ev.type === 'move') {
    if (!ev.path || ev.path.length < 1) check(tag + ' 事件路径非空', false);
    for (const rp of ev.path) {
      if (rp < 0 || rp > 57) check(tag + ' 路径rp合法', false, 'rp=' + rp);
    }
    if (ev.jump !== null && ev.jump !== undefined) {
      if (ev.jump < 4 || ev.jump > 51) check(tag + ' 跳格目标合法', false, 'jump=' + ev.jump);
    }
    if (ev.fly !== null && ev.fly !== undefined) {
      if (ev.fly !== rules.FLY_RP + rules.FLY_DIST) check(tag + ' 飞越目标合法', false, 'fly=' + ev.fly);
    }
    if (ev.type === 'gain_item') {
      if (['shield', 'reroll'].indexOf(ev.item) < 0) check(tag + ' 道具类型合法', false, 'item=' + ev.item);
    }
    if (ev.type === 'reroll') {
      if (ev.dice < 1 || ev.dice > 6) check(tag + ' 重掷点数合法', false, 'dice=' + ev.dice);
    }
  }
}

// ---------- 自动对战模拟 ----------
function runOne(seed, opt, levels) {
  const g = move.createGame({
    seats: [0, 1, 2, 3].map((i) => ({
      type: 'ai', openId: 'o' + i, nickName: 'P' + i, avatarUrl: '', aiLevel: levels[i]
    })),
    needExactFinish: opt.needExactFinish !== false,
    allowJump: opt.allowJump !== false,
    allowFly: opt.allowFly !== false,
    allowItems: opt.allowItems !== false
  });
  const rng = mulberry32(seed);
  let cur = g;
  let rolls = 0;
  let kills = 0;
  const MAX_ROLLS = 20000;
  while (cur.status === 'playing' && rolls < MAX_ROLLS) {
    const seat = cur.currentSeat;
    let r;
    if (cur.phase === 'rolling') {
      r = engine.advance(cur, { type: 'ROLL', seat }, rng);
      rolls++;
    } else if (cur.phase === 'selecting') {
      const pid = ai.choosePlane(cur, seat, cur.dice, levels[seat], rng);
      if (pid === null) { check('SIM selecting必有可动机', false); break; }
      r = engine.advance(cur, { type: 'SELECT_PLANE', seat, planeId: pid }, rng);
    } else {
      check('SIM 未知阶段 ' + cur.phase, false);
      break;
    }
    if (!r.ok) { check('SIM 动作非法: ' + r.error, false); break; }
    cur = r.state;
    for (const ev of r.events) {
      validateEvent(ev, 'SIM');
      if (ev.type === 'move') kills += ev.kills.length;
    }
    validateState(cur, 'SIM');
  }
  if (cur.status !== 'finished') {
    check('SIM 对局终止（无死循环）', false, 'seed=' + seed + ' rolls=' + rolls);
  } else {
    if (cur.winner === null) check('SIM 有胜者', false);
    if (cur.ranking.length !== 4) check('SIM 排名4人', false, JSON.stringify(cur.ranking));
    // 胜者 4 机到齐；其余玩家未完成（游戏在首家完成时结束）
    const wp = cur.players[cur.winner];
    if (wp.finishedCount !== 4) check('SIM 胜者4机到齐', false, String(wp.finishedCount));
    for (let s = 0; s < 4; s++) {
      if (s !== cur.winner && cur.players[s].finishedCount >= 4) {
        check('SIM 其余玩家未完成', false, 'seat=' + s);
      }
    }
  }
  return { rolls, kills };
}

function testSimulation() {
  console.log('· 模拟对战（共 1000 局）');
  const agg = { games: 0, rolls: 0, kills: 0, maxRolls: 0 };
  function record(st) {
    agg.games++; agg.rolls += st.rolls; agg.kills += st.kills;
    if (st.rolls > agg.maxRolls) agg.maxRolls = st.rolls;
  }
  // 主规则 400 局（混合 AI 难度 1-3；飞箭+跳格+道具全开）
  for (let i = 0; i < 400; i++) {
    const levels = [1 + (i % 3), 2, 3 - (i % 2), 2];
    record(runOne(1000 + i, { needExactFinish: true, allowJump: true, allowFly: true, allowItems: true }, levels));
  }
  // 大师档 200 局（两路大师对垒）
  for (let i = 0; i < 200; i++) {
    record(runOne(3000 + i, { needExactFinish: true, allowJump: true, allowFly: true, allowItems: true }, [4, 4, 3, 2]));
  }
  // 弹回终点模式 100 局
  for (let i = 0; i < 100; i++) {
    record(runOne(5000 + i, { needExactFinish: false, allowJump: true, allowFly: true, allowItems: true }, [2, 2, 2, 2]));
  }
  // 关闭跳格 100 局（飞箭/道具仍开）
  for (let i = 0; i < 100; i++) {
    record(runOne(9000 + i, { needExactFinish: true, allowJump: false, allowFly: true, allowItems: true }, [1, 2, 3, 1]));
  }
  // 关闭飞箭 100 局
  for (let i = 0; i < 100; i++) {
    record(runOne(13000 + i, { needExactFinish: true, allowJump: true, allowFly: false, allowItems: true }, [2, 1, 3, 2]));
  }
  // 关闭道具 100 局
  for (let i = 0; i < 100; i++) {
    record(runOne(17000 + i, { needExactFinish: true, allowJump: true, allowFly: true, allowItems: false }, [2, 1, 3, 2]));
  }
  console.log('  %d 局全部结束：平均 %s 掷/局，最长 %s 掷，总撞子 %s',
    agg.games, (agg.rolls / agg.games).toFixed(1), agg.maxRolls, agg.kills);
  check('平均局长合理（<3000 掷）', agg.rolls / agg.games < 3000);
}

// ---------- AI 大师档 ----------
function testAiMaster() {
  console.log('· ai.js 大师档 / 跳格击杀线感知');

  // —— v1.3 跳格击杀线感知 ——
  // 黄0 在 rp4（abs16），红0 落 abs24：黄掷 4 → rp8（abs20 黄格）跳 4 → abs24 击杀。
  // 直线距离 8 > 6，升级前基础风险项失明；升级后应产生约 -30/4 的风险罚分。
  const gj = newGame();
  setPlane(gj, 0, 0, 'track', 24);
  setPlane(gj, 1, 0, 'track', 4);
  const planJ = move.planMove(gj, 0, 0, 1);
  eq('落点 rp25', planJ.finalRp, 25);
  const withThreat = ai.evaluatePlan(gj, 0, planJ);
  setPlane(gj, 1, 0, 'base', -1);
  const withoutThreat = ai.evaluatePlan(gj, 0, planJ);
  check('跳格击杀线被基础风险感知（分差>5）', withoutThreat - withThreat > 5,
    'diff=' + (withoutThreat - withThreat).toFixed(2));

  // —— 大师档翻转场景：救回暴露的飞机 ——
  // 红0 坐在 abs36（rp37），黄0 在 abs30（rp18）掷2 → 落 abs32（黄格）跳4 → abs36 击杀。
  // 该威胁暴露的是「未移动的红0」，基础风险项只评估移动者的落点，两个候选的基础分都看不见。
  //   候选A：移动红1（rp10→11），红0 仍暴露 → 黄在第 2 点位的击杀进入期望回推。
  //   候选B：移动红0 本身（rp37→38，abs37 安全）→ 击杀机会消失。
  // 基础分 A(9.6) > B(4.8)，普通档选 A；大师档净分反转选 B，救回暴露的红0。
  const g = newGame();
  setPlane(g, 0, 0, 'track', 37);
  setPlane(g, 0, 1, 'track', 10);
  setPlane(g, 1, 0, 'track', 18);

  const planA = move.planMove(g, 0, 1, 1);
  const planB = move.planMove(g, 0, 0, 1);
  eq('候选A红1落 rp11', planA.finalRp, 11);
  eq('候选B红0落 rp38', planB.finalRp, 38);
  check('A 落点无基础风险', planA.kills.length === 0);
  check('基础分 A > B（普通档会选A）',
    ai.evaluatePlan(g, 0, planA) > ai.evaluatePlan(g, 0, planB));

  const gainA = ai.expectedOpponentGain(g, 0, planA, 1);
  const gainB = ai.expectedOpponentGain(g, 0, planB, 1);
  check('A 的下家期望收益显著更高（红0 暴露被杀）', gainA > gainB + 10,
    'gainA=' + gainA.toFixed(1) + ' gainB=' + gainB.toFixed(1));
  eq('普通档选A（红1）', ai.choosePlane(g, 0, 1, 2, mulberry32(7)), 1);
  eq('大师档选B（救回红0）', ai.choosePlane(g, 0, 1, 4, mulberry32(7)), 0);
}

// ---------- 成就系统 ----------
function testAchievements() {
  console.log('· achievements.js 成就系统');
  const ach = require('../miniprogram/engine/achievements.js');
  eq('成就定义共 8 个', ach.DEFINITIONS.length, 8);
  check('定义 id 无重复', new Set(ach.DEFINITIONS.map((d) => d.id)).size === 8);

  function ctx(over) {
    return Object.assign({
      isWinner: true,
      totalWins: 1,
      winStreakAfter: 1,
      stats: { kills: 0, sixes: 0, beenKilled: 0 },
      beatenAiLevels: []
    }, over || {});
  }

  let r = ach.evaluateAchievements([], ctx());
  check('首胜解锁', r.fresh.indexOf('first_win') >= 0);
  check('零被杀胜解锁完美', r.fresh.indexOf('flawless') >= 0);
  check('非胜利局不解锁任何成就',
    ach.evaluateAchievements([], ctx({ isWinner: false, totalWins: 0, winStreakAfter: 0, stats: { kills: 9, sixes: 99, beenKilled: 9 } })).fresh.length === 0);

  r = ach.evaluateAchievements(['first_win'], ctx({ totalWins: 2, stats: { kills: 0, sixes: 0, beenKilled: 1 } }));
  check('不重复解锁', r.fresh.length === 0 && r.all.join(',') === 'first_win',
    'fresh=' + JSON.stringify(r.fresh) + ' all=' + r.all.join(','));

  r = ach.evaluateAchievements([], ctx({ totalWins: 2, winStreakAfter: 2 }));
  check('两连胜不解锁三连胜', r.fresh.indexOf('streak_3') < 0);
  r = ach.evaluateAchievements([], ctx({ totalWins: 3, winStreakAfter: 3 }));
  check('三连胜解锁', r.fresh.indexOf('streak_3') >= 0);

  r = ach.evaluateAchievements([], ctx({ totalWins: 10, winStreakAfter: 1 }));
  check('十胜解锁常胜将军', r.fresh.indexOf('veteran') >= 0);

  r = ach.evaluateAchievements([], ctx({ stats: { kills: 4, sixes: 0, beenKilled: 2 } }));
  check('击落4不解锁王牌', r.fresh.indexOf('ace') < 0);
  r = ach.evaluateAchievements([], ctx({ stats: { kills: 5, sixes: 0, beenKilled: 2 } }));
  check('击落5解锁王牌且非完美', r.fresh.indexOf('ace') >= 0 && r.fresh.indexOf('flawless') < 0);

  r = ach.evaluateAchievements([], ctx({ stats: { kills: 0, sixes: 24, beenKilled: 0 } }));
  check('24 次六点不解锁', r.fresh.indexOf('lucky') < 0);
  r = ach.evaluateAchievements([], ctx({ stats: { kills: 0, sixes: 25, beenKilled: 0 } }));
  check('25 次六点解锁天选', r.fresh.indexOf('lucky') >= 0);

  r = ach.evaluateAchievements([], ctx({ stats: { kills: 1, sixes: 0, beenKilled: 3 } }));
  check('被杀3仍胜解锁绝地反击', r.fresh.indexOf('comeback') >= 0);

  r = ach.evaluateAchievements([], ctx({ beatenAiLevels: [2, 3] }));
  check('胜困难不解锁大师克星', r.fresh.indexOf('master_slayer') < 0);
  r = ach.evaluateAchievements([], ctx({ beatenAiLevels: [4] }));
  check('胜大师解锁大师克星', r.fresh.indexOf('master_slayer') >= 0);

  // 已有全部成就再胜一场：无新解锁，列表稳定
  const all = ach.DEFINITIONS.map((d) => d.id);
  r = ach.evaluateAchievements(all, ctx({ beatenAiLevels: [4], stats: { kills: 9, sixes: 30, beenKilled: 3 } }));
  eq('全成就后无重复', r.fresh.length, 0);
  eq('全成就列表稳定', r.all.join(','), all.join(','));

  // find 接口
  eq('find 首胜图标', ach.find('first_win').icon, '🥇');
  eq('find 未知 id', ach.find('nope'), null);
}

// ---------- 道具卡 ----------
function testItems() {
  console.log('· move.js/engine.js 道具卡');

  // 命中即得卡（rng 序列：先掷出 1 点，再抽中护盾），自动挂到最靠前的轨道飞机
  let g = newGame();
  setPlane(g, 0, 0, 'track', 20);
  setPlane(g, 1, 0, 'track', 8);   // 黄 abs20
  let seq = [0, 0.4];
  const r1 = engine.advance(g, { type: 'ROLL', seat: 0 }, () => seq.shift()); // dice=1 → 击杀；得卡 shield
  check('命中敌机获得护盾卡', r1.events.some((e) => e.type === 'gain_item' && e.item === 'shield'));
  eq('护盾计数=1', r1.state.items[0].shield, 1);
  eq('护盾挂在红0（唯一轨道机）', r1.state.players[0].planes[0].shield, true);
  eq('真实击杀计数生效', r1.state.players[0].stats.kills, 1);

  // 护盾反震：进攻带盾目标 → 进攻机回基地，目标原地护盾消耗
  const g2 = newGame();
  setPlane(g2, 0, 0, 'track', 22);  // 红0 abs21，带盾
  g2.players[0].planes[0].shield = true;
  g2.items[0].shield = 1;
  setPlane(g2, 1, 0, 'track', 8);   // 黄 rp8 dice1 → abs21 命中带盾红0
  g2.currentSeat = 1;
  const r2 = engine.advance(g2, { type: 'ROLL', seat: 1 }, () => 0); // dice=1
  const mv2 = r2.events.find((e) => e.type === 'move');
  check('击杀被盾抵消', mv2 && mv2.kills[0] && mv2.kills[0].blocked === true);
  eq('进攻方被反震回基地', r2.state.players[1].planes[0].state, 'base');
  eq('防守方原地保留', r2.state.players[0].planes[0].state, 'track');
  eq('护盾已消耗', r2.state.players[0].planes[0].shield, false);
  eq('被抵消不给撞子奖励（换人）', r2.state.currentSeat, 2);
  eq('反震计入被击数', r2.state.players[1].stats.beenKilled, 1);
  eq('盾方不获得击杀数', r2.state.players[0].stats.kills, 0);

  // 重掷：selecting 阶段重掷一次，重算可动；每回合一次；不计连六、不触发掷6奖励
  const g3 = newGame();
  setPlane(g3, 0, 0, 'track', 10);
  setPlane(g3, 0, 1, 'lane', 52);
  setPlane(g3, 0, 2, 'lane', 55);
  setPlane(g3, 0, 3, 'lane', 56);
  let r3 = engine.advance(g3, { type: 'ROLL', seat: 0 }, () => 0.5); // dice=4 → 两机可动 → selecting
  eq('进入选择阶段', r3.state.phase, 'selecting');
  check('红1 可动（52+4=56）', r3.state.movablePlanes.indexOf(1) >= 0);
  r3.state.items[0].reroll = 1; // 预先持有一张重掷卡
  r3 = engine.advance(r3.state, { type: 'USE_ITEM', seat: 0, item: 'reroll' }, () => 0.99); // 重掷=6
  check('重掷事件', r3.events.some((e) => e.type === 'reroll' && e.dice === 6 && e.prevDice === 4));
  eq('重掷卡消耗', r3.state.items[0].reroll, 0);
  eq('重掷出6不计连六', r3.state.consecutiveSix, 0);
  check('重掷后红1不可动（52+6=58 精确到达约束）', r3.state.movablePlanes.indexOf(1) < 0);
  check('重掷后唯一可动自动执行', r3.events.some((e) => e.type === 'move'));
  eq('重掷的6不触发掷6奖励（换人）', r3.state.currentSeat, 1);
  eq('无额外掷骰', r3.state.extraRollLeft, 0);
  const g8 = newGame();
  setPlane(g8, 0, 0, 'track', 10);
  setPlane(g8, 0, 1, 'track', 20);
  g8.phase = 'selecting';
  g8.dice = 4;
  g8.movablePlanes = [0, 1];
  eq('无卡重掷被拒', engine.advance(g8, { type: 'USE_ITEM', seat: 0, item: 'reroll' }, () => 0).error, 'NO_ITEM');

  // wantsReroll
  const g4 = newGame();
  setPlane(g4, 0, 0, 'track', 20);
  setPlane(g4, 1, 0, 'track', 7);   // 黄 abs19，红掷1落 abs21 → 直线距离1，重风险
  g4.items[0].reroll = 1;
  const planLow = move.planMove(g4, 0, 0, 1);
  check('候选为高风险负分', ai.evaluatePlan(g4, 0, planLow) < 0, 'score=' + ai.evaluatePlan(g4, 0, planLow).toFixed(1));
  eq('有卡+负分 → 建议重掷', ai.wantsReroll(g4, 0, 1, 2), true);
  g4.items[0].reroll = 0;
  eq('无卡不重掷', ai.wantsReroll(g4, 0, 1, 2), false);
  g4.items[0].reroll = 1;
  eq('简单档不重掷', ai.wantsReroll(g4, 0, 1, 1), false);
  const g5 = newGame({ allowItems: false });
  eq('关闭道具不重掷', ai.wantsReroll(g5, 0, 1, 2), false);

  // allowItems=false：无获得、USE_ITEM 拒绝
  const g6 = newGame({ allowItems: false });
  setPlane(g6, 0, 0, 'track', 20);
  setPlane(g6, 1, 0, 'track', 8);
  const r6 = engine.advance(g6, { type: 'ROLL', seat: 0 }, () => 0.4);
  check('关闭道具无获得事件', !r6.events.some((e) => e.type === 'gain_item'));
  r6.state.phase = 'selecting'; r6.state.currentSeat = 0; r6.state.dice = 4;
  eq('关闭道具拒绝重掷', engine.advance(r6.state, { type: 'USE_ITEM', seat: 0, item: 'reroll' }, () => 0).error, 'ILLEGAL_ACTION');

  // cloneState 保留道具字段
  const g7 = newGame();
  g7.items[2] = { shield: 1, reroll: 0 };
  setPlane(g7, 2, 0, 'track', 0);
  g7.players[2].planes[0].shield = true;
  const c7 = move.cloneState(g7);
  eq('克隆保留道具', JSON.stringify(c7.items[2]), '{"shield":1,"reroll":0}');
  eq('克隆保留盾标记', c7.players[2].planes[0].shield, true);
}

// ---------- 段位系统 ----------
function testTiers() {
  console.log('· tiers.js 段位系统');
  const tiers = require('../miniprogram/engine/tiers.js');
  eq('0 胜青铜', tiers.tierOf(0).id, 'bronze');
  eq('2 胜青铜', tiers.tierOf(2).id, 'bronze');
  eq('3 胜白银', tiers.tierOf(3).id, 'silver');
  eq('9 胜白银', tiers.tierOf(9).id, 'silver');
  eq('10 胜黄金', tiers.tierOf(10).id, 'gold');
  eq('24 胜黄金', tiers.tierOf(24).id, 'gold');
  eq('25 胜铂金', tiers.tierOf(25).id, 'platinum');
  eq('49 胜铂金', tiers.tierOf(49).id, 'platinum');
  eq('50 胜王者', tiers.tierOf(50).id, 'diamond');
  eq('负数容错青铜', tiers.tierOf(-5).id, 'bronze');
  eq('青铜升白银差 3 胜', tiers.winsToNext(0), 3);
  eq('白银升黄金差 1 胜', tiers.winsToNext(9), 1);
  eq('王者无下一级', tiers.winsToNext(50), -1);
  check('段位单调递增', tiers.TIERS.every((t, i) => i === 0 || t.min > tiers.TIERS[i - 1].min));
}

// ---------- Fuzz 健壮性：随机（含非法）动作轰炸 ----------
function testFuzz() {
  console.log('· fuzz 非法动作轰炸（2 万次注入）');
  const rng = mulberry32(777);

  // 随机构造一个合法初始状态（保证不变量成立）
  function randomLegalGame(seedRng) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const g = newGame();
      for (let s = 0; s < 4; s++) {
        for (let p = 0; p < 4; p++) {
          const roll = seedRng();
          if (roll < 0.25) continue; // 留在基地
          const state = roll < 0.6 ? 'track' : roll < 0.8 ? 'lane' : 'home';
          const rp = state === 'track'
            ? Math.floor(seedRng() * 52)
            : state === 'lane' ? 52 + Math.floor(seedRng() * 5) : 57;
          setPlane(g, s, p, state, rp);
        }
      }
      // 校验随机摆放是否合法（异色机不共处非安全格），不合法则重摆
      let ok = true;
      const seen = {};
      for (let s = 0; s < 4 && ok; s++) {
        for (const pl of g.players[s].planes) {
          if (pl.state !== 'track') continue;
          const abs = rules.absOfRp(s, pl.rp);
          if (seen[abs] !== undefined && seen[abs] !== s && !rules.isSafeAbs(abs)) { ok = false; break; }
          seen[abs] = s;
        }
      }
      if (ok) return g;
    }
    return newGame(); // 兜底
  }

  let cur = randomLegalGame(rng);
  let okCount = 0;
  let errCount = 0;
  const TYPES = ['ROLL', 'SELECT_PLANE', 'USE_ITEM', 'UNKNOWN'];
  const ITEMS = ['reroll', 'shield', undefined];

  for (let i = 0; i < 20000; i++) {
    if (i % 200 === 0 || cur.status !== 'playing') cur = randomLegalGame(rng);
    const type = TYPES[Math.floor(rng() * TYPES.length)];
    const seat = Math.floor(rng() * 5) - 1; // 含越界 -1/4
    const action = {
      type: type,
      seat: seat,
      planeId: Math.floor(rng() * 7) - 1, // 含越界 -1/5/6 与 undefined 风险
      item: ITEMS[Math.floor(rng() * ITEMS.length)]
    };
    if (rng() < 0.1) action.planeId = undefined; // 缺字段
    if (rng() < 0.1) action.seat = undefined;

    let r;
    try {
      r = engine.advance(cur, action, rng);
    } catch (e) {
      check('FUZZ 引擎不得抛异常 #' + i, false, JSON.stringify(action) + ' :: ' + e.message);
      cur = randomLegalGame(rng);
      continue;
    }
    if (r.ok) {
      okCount++;
      check('FUZZ 成功路径必有事件流 #' + i, Array.isArray(r.events) && r.events.length > 0);
      check('FUZZ 成功路径必有状态', !!r.state);
      if (r.state) {
        validateState(r.state, 'FUZZ');
        cur = r.state;
      }
    } else {
      errCount++;
      check('FUZZ 错误路径不得携带状态 #' + i, r.state === undefined);
      check('FUZZ 错误码为字符串 #' + i, typeof r.error === 'string');
    }
    // 失败后状态必须仍然合法
    validateState(cur, 'FUZZ_ERR');
  }
  console.log('  注入 20000 次：成功 %d，拒绝 %d', okCount, errCount);
  check('fuzz 覆盖两类路径', okCount > 100 && errCount > 100, 'ok=' + okCount + ' err=' + errCount);
}

// ---------- 回放一致性 ----------
function testReplayConsistency() {
  console.log('· replay.js 回放逐帧一致性');
  const replayMod = require('../miniprogram/engine/replay.js');
  const gameCount = 100;
  let framesChecked = 0;
  for (let gi = 0; gi < gameCount; gi++) {
    const levels = [1 + (gi % 3), 2, 3 - (gi % 2), 2];
    const g = move.createGame({
      seats: [0, 1, 2, 3].map((i) => ({
        type: 'ai', openId: 'o' + i, nickName: 'P' + i, avatarUrl: '', aiLevel: levels[i]
      })),
      needExactFinish: gi % 2 === 0,
      allowJump: true,
      allowFly: true,
      allowItems: true
    });
    const rng = mulberry32(99000 + gi);
    const moves = [];
    const states = [];
    let cur = g;
    let rolls = 0;
    while (cur.status === 'playing' && rolls < 8000) {
      const seat = cur.currentSeat;
      let r;
      if (cur.phase === 'rolling') {
        r = engine.advance(cur, { type: 'ROLL', seat: seat }, rng);
        rolls++;
      } else {
        // selecting 阶段：AI 可能重掷（ moves 一并记录用于回放比对）
        if (ai.wantsReroll(cur, seat, cur.dice, levels[seat], rng)) {
          const r0 = engine.advance(cur, { type: 'USE_ITEM', seat: seat, item: 'reroll' }, rng);
          if (r0.ok) {
            moves.push({ events: r0.events });
            states.push(r0.state);
            cur = r0.state;
          }
        }
        if (!(cur.status === 'playing' && cur.phase === 'selecting')) continue;
        const pid = ai.choosePlane(cur, seat, cur.dice, levels[seat], rng);
        r = engine.advance(cur, { type: 'SELECT_PLANE', seat: seat, planeId: pid }, rng);
      }
      if (!r.ok) { check('回放源模拟动作非法 ' + r.error, false); break; }
      moves.push({ events: r.events });
      states.push(r.state);
      cur = r.state;
    }
    check('回放源对局已完结 #' + gi, cur.status === 'finished');

    // 回放重建 frames，与引擎真实状态逐帧比对
    const frames = replayMod.buildFrames(g, moves);
    eq('回放帧数与操作步数一致 #' + gi, frames.length, states.length);
    const view = (st) => JSON.stringify({
      planes: st.players.map((p) => p.planes),
      items: st.items,
      dice: st.dice,
      seat: st.currentSeat,
      fin: st.players.map((p) => p.finishedCount)
    });
    for (let i = 0; i < Math.min(frames.length, states.length); i++) {
      check('回放帧与引擎一致 #' + gi + ':' + i, view(frames[i].state) === view(states[i]),
        '差异@' + gi + ':' + i + ' eng=' + view(states[i]).slice(0, 200) + ' rep=' + view(frames[i].state).slice(0, 200));
      framesChecked++;
    }
  }
  check('回放一致性覆盖足量帧', framesChecked > 3000, 'frames=' + framesChecked);
  console.log('  %d 局逐帧比对 %s 帧', gameCount, framesChecked);
}
// ---------- runAiTurn 集成重掷 ----------
function testRunAiTurnReroll() {
  console.log('· engine.js runAiTurn 重掷集成');
  // 构造 selecting 起点并打桩 wantsReroll=true，强制触发重掷分支
  const g = newGame();
  setPlane(g, 0, 0, 'track', 20);
  setPlane(g, 0, 1, 'track', 40);
  g.items[0].reroll = 1;

  const realWantsReroll = ai.wantsReroll;
  ai.wantsReroll = () => true;
  try {
    const steps = engine.runAiTurn(g, mulberry32(11), () => 2);
    check('runAiTurn 产生重掷步骤', steps.some((s) => (s.events || []).some((e) => e.type === 'reroll')),
      'steps=' + steps.map((s) => (s.events || []).map((e) => e.type).join('/')).join('|'));
    check('重掷后仍有选机步骤', steps.some((s) => (s.events || []).some((e) => e.type === 'move')));
  } finally {
    ai.wantsReroll = realWantsReroll;
  }
}
// ---------- 对局页视图模型 ----------
function testView() {
  console.log('· view.js 视图模型');
  const view = require('../miniprogram/engine/view.js');
  const roomSeats = [0, 1, 2, 3].map((i) => ({ type: 'ai', openId: 'o' + i, isOnline: true, isHosted: false }));
  const g = newGame();
  g.players[0].type = 'human';
  const v = view.deriveViewState(g, roomSeats, 'o0', false);
  eq('我的座位 0', v.mySeat, 0);
  eq('rolling 阶段可掷骰', v.canRoll, true);
  eq('非托管', v.hostedMe, false);
  check('提示轮到你', v.hintText.indexOf('轮到你') >= 0, v.hintText);
  const vs = view.deriveViewState(g, roomSeats, 'spectator', false);
  eq('观战 mySeat -1', vs.mySeat, -1);
  check('观战提示', vs.hintText.indexOf('观战中') >= 0, vs.hintText);

  // 掉线托管（我 = seat0 人类，离线且被托管）
  const seats2 = roomSeats.slice();
  seats2[0] = { type: 'human', openId: 'o0', isOnline: false, isHosted: true };
  const g2 = newGame();
  g2.players[0].type = 'human';
  g2.phase = 'rolling';
  const v2 = view.deriveViewState(g2, seats2, 'o0', false);
  eq('掉线托管', v2.hostedMe, true);
  eq('托管不可掷', v2.canRoll, false);
  check('掉线托管提示', v2.hintText.indexOf('掉线') >= 0, v2.hintText);
  const v3 = view.deriveViewState(g2, roomSeats, 'o0', true);
  eq('主动托管覆盖', v3.hostedMe, true);
  g2.currentSeat = 1;
  const v4 = view.deriveViewState(g2, roomSeats, 'o0', false);
  check('等待他人提示', v4.hintText.indexOf('等待') >= 0, v4.hintText);
  g2.status = 'finished';
  const v5 = view.deriveViewState(g2, seats2, 'o0', false);
  eq('结束提示', v5.hintText, '对局已结束');

  // 持卡与重掷
  const g6 = newGame();
  g6.players[0].type = 'human';
  g6.items[0] = { shield: 1, reroll: 1 };
  const v6 = view.deriveViewState(g6, roomSeats, 'o0', false);
  eq('持卡显示', v6.heldItems, '🛡 🔄');
  g6.phase = 'selecting'; g6.currentSeat = 0; g6.movablePlanes = [0, 1]; g6.dice = 4; g6.rerolledThisTurn = false;
  const v7 = view.deriveViewState(g6, roomSeats, 'o0', false);
  eq('持卡可重掷', v7.canReroll, true);
  g6.rerolledThisTurn = true;
  eq('本回合已重掷不可再掷', view.deriveViewState(g6, roomSeats, 'o0', false).canReroll, false);
  const g8 = newGame({ allowItems: false });
  g8.players[0].type = 'human';
  g8.items[0] = { shield: 1, reroll: 1 };
  g8.phase = 'selecting'; g8.currentSeat = 0; g8.movablePlanes = [0, 1];
  eq('关闭道具不可重掷', view.deriveViewState(g8, roomSeats, 'o0', false).canReroll, false);
  check('playersView 含进度', v.playersView.every((p) => typeof p.progress === 'number'));
}

// ---------- runAiTurn 集成重掷 ----------
function testRunAiTurnReroll() {
  console.log('· engine.js runAiTurn 重掷集成');
  // 构造 selecting 起点并打桩 wantsReroll=true，强制触发重掷分支
  const g = newGame();
  setPlane(g, 0, 0, 'track', 20);
  setPlane(g, 0, 1, 'track', 40);
  g.items[0].reroll = 1;

  const realWantsReroll = ai.wantsReroll;
  ai.wantsReroll = () => true;
  try {
    const steps = engine.runAiTurn(g, mulberry32(11), () => 2);
    check('runAiTurn 产生重掷步骤', steps.some((s) => (s.events || []).some((e) => e.type === 'reroll')),
      'steps=' + steps.map((s) => (s.events || []).map((e) => e.type).join('/')).join('|'));
    check('重掷后仍有选机步骤', steps.some((s) => (s.events || []).some((e) => e.type === 'move')));
  } finally {
    ai.wantsReroll = realWantsReroll;
  }
}
// ---------- animator 纯函数 ----------
function testAnimator() {
  console.log('· animator.js 补间纯函数');
  const animator = require('../miniprogram/utils/animator.js');
  eq('easeInOut(0)=0', animator.easeInOut(0), 0);
  eq('easeInOut(1)=1', animator.easeInOut(1), 1);
  eq('easeInOut 中点', animator.easeInOut(0.5), 0.5);
  check('easeOutBack(0)≈0', Math.abs(animator.easeOutBack(0)) < 1e-9);
  eq('easeOutBack(1)=1', animator.easeOutBack(1), 1);
  check('easeOutBack 过冲', animator.easeOutBack(0.7) > 1, String(animator.easeOutBack(0.7)));
  const p = animator.arcLerp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5, 40);
  check('arcLerp 中点高于直线', p.y < 0, 'y=' + p.y);
  const e1 = animator.arcLerp({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 40);
  const e2 = animator.arcLerp({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 40);
  check('arcLerp 起点终点吻合（浮点容差）', Math.abs(e1.x) < 1e-9 && Math.abs(e1.y) < 1e-9 && Math.abs(e2.x - 100) < 1e-9 && Math.abs(e2.y) < 1e-9);
}
// ---------- 汇总 ----------
function main() {
  console.log('=== 飞行棋引擎测试 ===');
  testRules();
  testMoveMechanics();
  testEngineTurns();
  testAiMaster();
  testItems();
  testAchievements();
  testTiers();
  testRunAiTurnReroll();
  testView();
  testFuzz();
  testAnimator();
  testSimulation();
  console.log('----------------------');
  console.log('通过 %d 项，失败 %d 项', passed, failed);
  if (failed > 0) {
    console.error('失败明细：');
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
  console.log('✓ 全部通过');
}

main();
