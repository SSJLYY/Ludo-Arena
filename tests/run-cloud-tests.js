'use strict';

// ============================================================
// 云函数集成测试：tests/run-cloud-tests.js
// 用内存 wx-server-sdk 模拟器驱动全部云函数，跑通完整多人链路：
// 登录 → 建房（密码/锁定）→ 占座/观战 → 开局 → 全流程对局到胜利 →
// 结算（战绩/连胜/成就/排行榜）→ 心跳托管 → aiTick 离线推进 → 清理。
// 运行：node tests/run-cloud-tests.js
// ============================================================

const shim = require('./cloud-shim.js');

const db = shim.createDb();
const cloud = shim.createCloud(db);
const uninstall = shim.install(cloud);

// 拦截器安装后再加载云函数（它们在模块顶层 require('wx-server-sdk')）
const fns = {
  login: require('../cloudfunctions/login/index.js'),
  roomCreate: require('../cloudfunctions/roomCreate/index.js'),
  roomJoin: require('../cloudfunctions/roomJoin/index.js'),
  roomSeat: require('../cloudfunctions/roomSeat/index.js'),
  roomLeave: require('../cloudfunctions/roomLeave/index.js'),
  roomEmote: require('../cloudfunctions/roomEmote/index.js'),
  gameStart: require('../cloudfunctions/gameStart/index.js'),
  gameAction: require('../cloudfunctions/gameAction/index.js'),
  gameHeartbeat: require('../cloudfunctions/gameHeartbeat/index.js'),
  getLeaderboard: require('../cloudfunctions/getLeaderboard/index.js'),
  getWxacode: require('../cloudfunctions/getWxacode/index.js'),
  aiTick: require('../cloudfunctions/aiTick/index.js')
};

// CAS / 结算共享模块（用真实引擎副本）
const achievements = require('../cloudfunctions/gameAction/engine/achievements.js');
const createShared = require('../cloudfunctions/gameAction/shared.js');
const shared = createShared(cloud, db, achievements);

// ---------- 断言脚手架 ----------
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

async function expectErr(name, promise, code) {
  try {
    const res = await promise;
    // 直调云函数：错误以 { err: code } 返回而非抛出
    eq(name, res && res.err, code);
  } catch (e) {
    eq(name, e.code, code);
  }
}

// 以指定身份调用云函数
async function as(openId, fn, event) {
  cloud.currentOpenId = openId;
  return fn.main(event || {});
}

const users = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'];
function profile(i) {
  return { nickName: '玩家' + i, avatarUrl: 'https://mock/avatar/' + i + '.png' };
}

// ---------- 场景 A：登录 / 建房 / 密码 / 占座 / 观战 ----------
async function scenarioRoom() {
  console.log('· 场景A 登录/建房/密码/占座/观战');

  // 登录 + 昵称合规（risky → 拒绝；error → 容错放行）
  cloud.secCheckMode = 'risky';
  await expectErr('违规昵称被拒', as(users[0], fns.login, { nickName: '垃圾大王' }), 'NICKNAME_INVALID');
  cloud.secCheckMode = 'error';
  const lg = await as(users[0], fns.login, { nickName: '小明', avatarUrl: 'https://mock/a.png' });
  eq('登录返回 openId', lg.openId, users[0]);
  cloud.secCheckMode = 'pass';
  for (let i = 1; i < users.length; i++) {
    await as(users[i], fns.login, profile(i));
  }

  // 建房（带密码）+ room_auth 凭证存在
  const cr = await as(users[0], fns.roomCreate, {
    password: 'abc',
    settings: { needExactFinish: true, allowFly: true, allowItems: true, aiLevel: 2 },
    profile: profile(0)
  });
  check('建房返回 roomId/roomNo', !!cr.roomId && /^\d{6}$/.test(cr.roomNo));
  const roomId = cr.roomId;
  const auth = (await db.collection('room_auth').doc(roomId).get()).data;
  check('密码凭证在独立集合', !!auth.passwordHash && !!auth.salt && !!auth.failsByUser);

  // 密码：同一用户错误两次提示剩余次数，第三次写入锁定（第 4 次起返回 LOCKED）
  await expectErr('第一次密码错误', as(users[1], fns.roomJoin, { roomNo: cr.roomNo, password: 'wrong', profile: profile(1) }), 'WRONG_PASSWORD');
  await expectErr('第二次密码错误', as(users[1], fns.roomJoin, { roomNo: cr.roomNo, password: 'wrong', profile: profile(1) }), 'WRONG_PASSWORD');
  const third = await as(users[1], fns.roomJoin, { roomNo: cr.roomNo, password: 'wrong', profile: profile(1) });
  check('第三次错误写入锁定', third.err === 'WRONG_PASSWORD' && String(third.msg || '').indexOf('锁定') >= 0, JSON.stringify(third));
  await expectErr('锁定期间正确密码也拒绝', as(users[1], fns.roomJoin, { roomNo: cr.roomNo, password: 'abc', profile: profile(1) }), 'LOCKED');
  // 其他用户按用户独立计数，不受 u2 影响
  const j3 = await as(users[2], fns.roomJoin, { roomId: roomId, password: 'abc', profile: profile(2) });
  eq('u3 正确密码入座 seat1', j3.seatIndex, 1);
  const j4 = await as(users[3], fns.roomJoin, { roomId: roomId, password: 'abc', profile: profile(3) });
  eq('u4 入座 seat2', j4.seatIndex, 2);

  // 已在座位重复加入 → rejoin
  const re3 = await as(users[2], fns.roomJoin, { roomId: roomId, profile: profile(2) });
  eq('重复加入走回归', re3.rejoin, true);

  // 权限：非房主踢人被拒；非空座位坐下被拒
  await expectErr('非房主踢人被拒', as(users[2], fns.roomSeat, { roomId: roomId, seatIndex: 0, action: 'kick' }), 'NOT_OWNER');
  await expectErr('非房主加AI被拒', as(users[2], fns.roomSeat, { roomId: roomId, seatIndex: 3, action: 'addAI' }), 'NOT_OWNER');

  // 房主加满 AI（大师档）
  await as(users[0], fns.roomSeat, { roomId: roomId, seatIndex: 3, action: 'addAI', aiLevel: 4 });
  const roomDoc1 = (await db.collection('rooms').doc(roomId).get()).data;
  eq('座位3为大师AI', roomDoc1.seats[3].aiLevel, 4);
  eq('AI 名称同步', roomDoc1.seats[3].nickName, '电脑·大师');

  // 房满 → 观战（最多 4 人，超出 ROOM_FULL）
  const s1 = await as(users[4], fns.roomJoin, { roomId: roomId, profile: profile(4) });
  const s2 = await as(users[5], fns.roomJoin, { roomId: roomId, profile: profile(5) });
  const s3 = await as(users[6], fns.roomJoin, { roomId: roomId, profile: profile(6) });
  const s4 = await as(users[7], fns.roomJoin, { roomId: roomId, profile: profile(7) });
  check('满座加入转为观战', s1.spectator && s2.spectator && s3.spectator && s4.spectator);
  await expectErr('观战满员后加入被拒', as(users[8], fns.roomJoin, { roomId: roomId, profile: profile(8) }), 'ROOM_FULL');
  const roomDoc2 = (await db.collection('rooms').doc(roomId).get()).data;
  eq('观战者 4 人', Object.values(roomDoc2.spectators).filter(Boolean).length, 4);

  // 表情：合法 + 限频（按用户独立）
  const em1 = await as(users[2], fns.roomEmote, { roomId: roomId, type: '👍' });
  eq('表情发送成功', em1.ok, true);
  const em2 = await as(users[2], fns.roomEmote, { roomId: roomId, type: '😂' });
  eq('3 秒内第二条被限频', em2.err, 'EMOTE_TOO_FAST');
  const em3 = await as(users[3], fns.roomEmote, { roomId: roomId, type: '🎉' });
  eq('其他用户不受限', em3.ok, true);

  return { roomId: roomId, roomNo: cr.roomNo, humans: [users[0], users[2], users[3]], spectators: [users[4], users[5], users[6], users[7]] };
}

// ---------- 场景 B：开局 + 全流程对局到胜利 ----------
async function scenarioGame(ctx) {
  console.log('· 场景B 开局与全流程对局');
  const gs = await as(ctx.humans[0], fns.gameStart, { roomId: ctx.roomId });
  check('开局返回 gameId', !!gs.gameId);
  const gameId = gs.gameId;

  let game = (await db.collection('games').doc(gameId).get()).data;
  eq('对局允许道具', game.allowItems, true);
  eq('对局允许飞箭', game.allowFly, true);
  eq('初始 4 机全部在基地', game.players.every((p) => p.planes.every((pl) => pl.state === 'base')), true);

  // 非当前座位行动被拒
  const seat0OpenId = game.players[0].openId;
  cloud.currentOpenId = game.players[1].openId;
  await expectErr('非当前座位掷骰被拒', fns.gameAction.main({ gameId: gameId, action: 'ROLL' }), 'NOT_YOUR_TURN');
  void seat0OpenId;

  // 驱动整局到结束（人类走 ROLL/SELECT，AI 走 AI_STEP）
  let guard = 0;
  let steps = 0;
  while (game.status === 'playing' && guard++ < 6000) {
    const seat = game.currentSeat;
    const p = game.players[seat];
    if (p.type === 'ai') {
      cloud.currentOpenId = 'anyone';
      const r = await fns.gameAction.main({ gameId: gameId, action: 'AI_STEP' });
      check('AI_STEP 成功', r.ok === true, JSON.stringify(r).slice(0, 80));
      if (!r.ok) break;
      steps += r.steps || 0;
    } else {
      cloud.currentOpenId = p.openId;
      let r;
      if (game.phase === 'rolling') {
        r = await fns.gameAction.main({ gameId: gameId, action: 'ROLL' });
      } else if (game.phase === 'selecting') {
        r = await fns.gameAction.main({
          gameId: gameId, action: 'SELECT_PLANE',
          payload: { planeId: (game.movablePlanes || [])[0] }
        });
      } else break;
      check('真人行动成功 step' + guard, r.ok === true, JSON.stringify(r).slice(0, 80));
      if (!r.ok) break;
    }
    game = (await db.collection('games').doc(gameId).get()).data;
    steps++;
  }
  check('集成对局完整结束', game.status === 'finished', 'status=' + game.status + ' steps=' + steps);
  check('产生胜者', game.winner !== null && game.winner !== undefined);
  check('排名完整', (game.ranking || []).length === 4);

  // 房间状态同步为 finished
  const roomDoc = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  eq('房间状态 finished', roomDoc.status, 'finished');

  // 结算：真人战绩/连胜/成就
  for (const p of game.players) {
    if (p.type !== 'human') continue;
    const u = (await db.collection('users').doc(p.openId).get()).data;
    eq('局数结算 ' + p.nickName, u.stats.games, 1);
    const isWinner = game.winner === p.seat;
    eq('胜场结算 ' + p.nickName, u.stats.wins, isWinner ? 1 : 0);
    eq('连胜结算 ' + p.nickName, u.winStreak, isWinner ? 1 : 0);
    check('成就列表存在 ' + p.nickName, Array.isArray(u.achievements));
    if (isWinner) check('胜者解锁首胜', u.achievements.indexOf('first_win') >= 0);
    check('最近对局含时长', u.recentGames[0].durationSec >= 0);
  }

  // 排行榜：AI 夺冠时不在榜（无 users 文档），以人类身份查询
  cloud.currentOpenId = ctx.humans[0];
  const lb = await fns.getLeaderboard.main({});
  check('排行榜非空', (lb.rows || []).length >= 1);
  eq('胜者排第一', lb.rows[0].rank, 1);
  check('我的排名有效', lb.myRank >= 1, 'myRank=' + lb.myRank);
  check('排行榜不含 openId', !JSON.stringify(lb.rows).match(/u\d|"openId"/));

  return { gameId: gameId, winnerOpenId: game.players[game.winner].openId, roomNo: ctx.roomNo };
}

// ---------- 场景 C：心跳托管 / 主动托管 / CAS 冲突 ----------
async function scenarioHosting(ctx) {
  console.log('· 场景C 心跳托管 / CAS');
  const roomDoc = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  const u1Seat = roomDoc.seats.findIndex((s) => s.openId === ctx.humans[0]);
  const u2Seat = roomDoc.seats.findIndex((s) => s.openId === ctx.humans[1]);

  // u2 静默超 30s → u1 心跳触发托管
  const old = Date.now() - 40000;
  await db.collection('rooms').doc(ctx.roomId).update({
    data: { ['seats.' + u2Seat + '.lastSeen']: old }
  });
  await as(ctx.humans[0], fns.gameHeartbeat, { roomId: ctx.roomId });
  let room = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  eq('掉线座位自动托管', room.seats[u2Seat].isHosted, true);
  eq('掉线座位离线标记', room.seats[u2Seat].isOnline, false);

  // u2 回线心跳 → 接管
  await as(ctx.humans[1], fns.gameHeartbeat, { roomId: ctx.roomId });
  room = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  eq('回线解除托管', room.seats[u2Seat].isHosted, false);

  // 主动托管：u2 带 hosted=true 心跳保持托管态
  await as(ctx.humans[1], fns.gameHeartbeat, { roomId: ctx.roomId, hosted: true });
  room = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  eq('主动托管生效', room.seats[u2Seat].isHosted, true);

  // CAS 冲突：过期 seq 写入失败，正确 seq 成功
  const game = (await db.collection('games').doc(ctx.gameId).get()).data;
  const badWrite = await shared.casWrite(ctx.gameId, game.seq + 100, game);
  eq('过期 seq 写入被拒', badWrite, false);
  const goodWrite = await shared.casWrite(ctx.gameId, game.seq, game);
  eq('当前 seq 写入成功', goodWrite, true);
  const after = (await db.collection('games').doc(ctx.gameId).get()).data;
  eq('CAS 推进 seq', after.seq, game.seq + 1);
}

// ---------- 场景 D：aiTick 离线推进 ----------
async function scenarioAiTick(ctx) {
  console.log('· 场景D aiTick 离线推进');
  // 回拨对局到 playing + updatedAt 拨旧，并把行动权交给 AI 座位（模拟全离线）
  let game = (await db.collection('games').doc(ctx.gameId).get()).data;
  const aiSeat = game.players.findIndex((p) => p.type === 'ai');
  check('对局存在 AI 座位', aiSeat >= 0);
  game.status = 'playing';
  game.phase = 'rolling';
  game.currentSeat = aiSeat;
  game.updatedAt = Date.now() - 20000;
  await db.collection('games').doc(ctx.gameId).set({ data: game });
  const before = game.seq;
  const r = await fns.aiTick.main({});
  check('aiTick 扫描到对局', r.scanned >= 1, 'scanned=' + r.scanned);
  check('aiTick 推进了 AI 回合', r.advanced >= 1, 'advanced=' + r.advanced);
  const after = (await db.collection('games').doc(ctx.gameId).get()).data;
  check('aiTick 推进 seq', after.seq > before, 'before=' + before + ' after=' + after.seq);

  // 未托管真人座位不推进
  game = (await db.collection('games').doc(ctx.gameId).get()).data;
  const humanSeat = game.players.findIndex((p) => p.type === 'human');
  game.status = 'playing';
  game.phase = 'rolling';
  game.currentSeat = humanSeat;
  game.updatedAt = Date.now() - 20000;
  await db.collection('games').doc(ctx.gameId).set({ data: game });
  const seqBefore = game.seq;
  const r2 = await fns.aiTick.main({});
  check('未托管真人座位不被推进', r2.advanced === 0, 'advanced=' + r2.advanced);
  const after2 = (await db.collection('games').doc(ctx.gameId).get()).data;
  eq('真人座位 seq 不变', after2.seq, seqBefore);
}
// ---------- 场景 E：getWxacode 缓存 ----------
async function scenarioWxacode(ctx) {
  console.log('· 场景E 小程序码缓存');
  const r1 = await as(ctx.humans[0], fns.getWxacode, { roomId: ctx.roomId });
  check('首次生成成功', r1.ok === true && !!r1.fileID);
  const r2 = await as(ctx.humans[0], fns.getWxacode, { roomId: ctx.roomId });
  eq('第二次命中缓存', r2.cached, true);
  eq('缓存 fileID 一致', r2.fileID, r1.fileID);
}

// ---------- 场景 F：观战离开 / 房间解散 ----------
async function scenarioLeave(ctx) {
  console.log('· 场景F 观战离开 / 房主解散');
  const before = Object.values((await db.collection('rooms').doc(ctx.roomId).get()).data.spectators || {}).filter(Boolean).length;
  await as(users[4], fns.roomLeave, { roomId: ctx.roomId });
  const after = Object.values((await db.collection('rooms').doc(ctx.roomId).get()).data.spectators || {}).filter(Boolean).length;
  eq('观战者离开后移除', after, before - 1);
}

// ---------- 场景 G：并发正确性 ----------
async function scenarioConcurrency(ctx) {
  console.log('· 场景G 并发正确性');

  // 1) 并发抢座：房间留 1 个空位，8 人同时加入 → 恰好 1 人入座，4 人转观战，其余 ROOM_FULL
  const cr = await as(ctx.humans[0], fns.roomCreate, { profile: profile(0) });
  await as(ctx.humans[0], fns.roomSeat, { roomId: cr.roomId, seatIndex: 1, action: 'addAI' });
  await as(ctx.humans[0], fns.roomSeat, { roomId: cr.roomId, seatIndex: 2, action: 'addAI' });
  const racers = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
  const results = await Promise.all(racers.map((openId, i) =>
    as(openId, fns.roomJoin, { roomId: cr.roomId, profile: profile(i) })));
  const seated = results.filter((r) => r.ok && r.seatIndex !== undefined);
  const spectators = results.filter((r) => r.ok && r.spectator);
  const rejected = results.filter((r) => r.err);
  eq('并发抢座恰好 1 人成功', seated.length, 1);
  check('其余 7 人全部转为观战或被拒', spectators.length + rejected.length === 7);
  check('转观战不超过上限', spectators.length <= 4, 'spectators=' + spectators.length);
  check('被拒均为 ROOM_FULL', rejected.every((r) => r.err === 'ROOM_FULL'), JSON.stringify(rejected));
  const seatDoc = (await db.collection('rooms').doc(cr.roomId).get()).data;
  check('观战硬上限生效', (seatDoc.spectatorCount || 0) <= 4, 'count=' + seatDoc.spectatorCount);
  eq('空位归属与占座结果一致', seatDoc.seats[3].openId, seated[0] ? racers[results.indexOf(seated[0])] : '');

  // 2) 并发 AI_STEP：10 个请求同时推进同一 AI 回合 → 无重复推进、seq 单调一致
  const gs = await as(ctx.humans[0], fns.gameStart, { roomId: cr.roomId });
  const gameId = gs.gameId;
  let beforeDoc = (await db.collection('games').doc(gameId).get()).data;
  const aiSeatIdx = beforeDoc.players.findIndex((p) => p.type === 'ai');
  await db.collection('games').doc(gameId).update({ data: { currentSeat: aiSeatIdx, updatedAt: Date.now() - 20000 } });
  beforeDoc = (await db.collection('games').doc(gameId).get()).data;
  const beforeSeq = beforeDoc.seq;
  const burst = await Promise.all(Array.from({ length: 10 }, () =>
    as('anyone', fns.gameAction, { gameId: gameId, action: 'AI_STEP' })));
  check(
    '并发 AI_STEP 全部有响应',
    burst.every((r) => r.ok === true || typeof r.err === 'string'));
  const afterDoc = (await db.collection('games').doc(gameId).get()).data;
  check('并发后 seq 单调前进', afterDoc.seq > beforeSeq, 'before=' + beforeSeq + ' after=' + afterDoc.seq);
  check('并发后状态合法', afterDoc.status === 'playing' || afterDoc.status === 'finished');
  check('无重复推进（步数不超过单回合上限）', afterDoc.seq - beforeSeq <= 12, 'delta=' + (afterDoc.seq - beforeSeq));

  // 3) 并发心跳：多人同时心跳，各自座位状态正确
  const beats = await Promise.all(ctx.humans.map((openId) =>
    as(openId, fns.gameHeartbeat, { roomId: ctx.roomId })));
  check(
    '并发心跳全部成功',
    beats.every((b) => b.ok === true && b.seat >= 0));
  const hbRoom = (await db.collection('rooms').doc(ctx.roomId).get()).data;
  check('并发心跳后全部在线', hbRoom.seats.filter((s) => s.type === 'human').every((s) => s.isOnline));
}
// ---------- 场景 H：座位组合矩阵（架构文档核心承诺） ----------
async function scenarioCompositions() {
  console.log('· 场景H 座位组合矩阵（4真人/1+3/2+2/3+1）');
  const combos = [
    { name: '4真人', humans: 4, ai: 0 },
    { name: '1真人+3AI', humans: 1, ai: 3 },
    { name: '2真人+2AI', humans: 2, ai: 2 },
    { name: '3真人+1AI', humans: 3, ai: 1 }
  ];
  for (const combo of combos) {
    const owner = 'own-' + combo.name;
    const cr = await as(owner, fns.roomCreate, { profile: profile(combo.name) });
    // 真人依序入座（房主已占 seat0，其余 human-1 人加入）
    for (let i = 1; i < combo.humans; i++) {
      const j = await as('h' + combo.name + i, fns.roomJoin, { roomId: cr.roomId, profile: profile(i) });
      check(combo.name + ' 真人' + i + ' 入座', typeof j.seatIndex === 'number', JSON.stringify(j));
    }
    // 其余座位填 AI（不同难度覆盖）
    const aiLevels = [1, 2, 3, 4];
    for (let s = combo.humans; s < 4; s++) {
      await as(owner, fns.roomSeat, { roomId: cr.roomId, seatIndex: s, action: 'addAI', aiLevel: aiLevels[s] });
    }
    const gs = await as(owner, fns.gameStart, { roomId: cr.roomId });
    check(combo.name + ' 开局成功', !!gs.gameId, JSON.stringify(gs));
    if (!gs.gameId) continue;
    const gameId = gs.gameId;
    // 驱动到终局：人类用其 openId 行动，AI 用 AI_STEP
    let game = (await db.collection('games').doc(gameId).get()).data;
    let guard = 0;
    while (game.status === 'playing' && guard++ < 6000) {
      const seat = game.currentSeat;
      const p = game.players[seat];
      let r;
      if (p.type === 'ai') {
        cloud.currentOpenId = 'anyone';
        r = await fns.gameAction.main({ gameId: gameId, action: 'AI_STEP' });
      } else {
        cloud.currentOpenId = p.openId;
        if (game.phase === 'rolling') {
          r = await fns.gameAction.main({ gameId: gameId, action: 'ROLL' });
        } else if (game.phase === 'selecting') {
          r = await fns.gameAction.main({
            gameId: gameId, action: 'SELECT_PLANE',
            payload: { planeId: (game.movablePlanes || [])[0] }
          });
        } else break;
      }
      check(combo.name + ' 行动成功 #' + guard, r.ok === true, JSON.stringify(r).slice(0, 80));
      if (!r.ok) break;
      game = (await db.collection('games').doc(gameId).get()).data;
    }
    check(combo.name + ' 对局完整结束', game.status === 'finished', 'status=' + game.status + ' guard=' + guard);
    check(combo.name + ' 排名完整', (game.ranking || []).length === 4);
    // 每个组合完成后重置为 playing 供下一组合复用？不需要——每个组合新建房间
  }
}
// ---------- 场景 I：观战者接管 AI 座位 ----------
async function scenarioTakeover() {
  console.log('· 场景I 观战者接管 AI 座位');
  const owner = 'tk-owner';
  const cr = await as(owner, fns.roomCreate, { profile: profile(0) });
  // 真人甲入座 seat1
  await as('tk-h', fns.roomJoin, { roomId: cr.roomId, profile: { nickName: '真人甲' } });
  // 填满 AI（seat2、seat3）
  await as(owner, fns.roomSeat, { roomId: cr.roomId, seatIndex: 2, action: 'addAI', aiLevel: 3 });
  await as(owner, fns.roomSeat, { roomId: cr.roomId, seatIndex: 3, action: 'addAI', aiLevel: 2 });
  // 观战者加入（满座 → 观战）
  const sj = await as('tk-spec', fns.roomJoin, { roomId: cr.roomId, profile: { nickName: '观战者' } });
  check('观战者加入成功', sj.spectator === true, JSON.stringify(sj));
  // 开局
  const gs = await as(owner, fns.gameStart, { roomId: cr.roomId });
  check('开局成功', !!gs.gameId, JSON.stringify(gs));
  const gameId = gs.gameId;
  let game = (await db.collection('games').doc(gameId).get()).data;
  const aiSeat = game.players.findIndex((p) => p.type === 'ai');
  check('存在 AI 座位', aiSeat >= 0);
  // 观战者接管该 AI 座位
  const tk = await as('tk-spec', fns.roomSeat, { roomId: cr.roomId, seatIndex: aiSeat, action: 'takeover', profile: { nickName: '观战者' } });
  check('接管成功', tk.ok === true && tk.takeover === true, JSON.stringify(tk));
  game = (await db.collection('games').doc(gameId).get()).data;
  eq('对局文档座位类型转人类', game.players[aiSeat].type, 'human');
  eq('对局文档 openId 同步', game.players[aiSeat].openId, 'tk-spec');
  const roomAfter = (await db.collection('rooms').doc(cr.roomId).get()).data;
  eq('房间座位类型转人类', roomAfter.seats[aiSeat].type, 'human');
  // 接管者可行动（轮到他时 ROLL 成功）
  let guard = 0;
  let rolled = false;
  game = (await db.collection('games').doc(gameId).get()).data;
  while (game.status === 'playing' && guard++ < 6000 && !rolled) {
    const cur = game.players[game.currentSeat];
    cloud.currentOpenId = cur.openId || 'anyone';
    let r;
    if (cur.type === 'ai') {
      r = await fns.gameAction.main({ gameId: gameId, action: 'AI_STEP' });
    } else if (game.phase === 'rolling') {
      r = await fns.gameAction.main({ gameId: gameId, action: 'ROLL' });
    } else {
      r = await fns.gameAction.main({
        gameId: gameId, action: 'SELECT_PLANE',
        payload: { planeId: (game.movablePlanes || [])[0] }
      });
    }
    check('接管后行动成功 #' + guard, r.ok === true, JSON.stringify(r).slice(0, 80));
    if (!r.ok) break;
    if (game.currentSeat === aiSeat) rolled = true; // 接管座位已成功行动
    game = (await db.collection('games').doc(gameId).get()).data;
  }
  check('接管者已掷骰', rolled, 'guard=' + guard);
  // 接管后该座位不再被 AI_STEP 推进（类型已转人类）
  game = (await db.collection('games').doc(gameId).get()).data;
  game.currentSeat = aiSeat;
  game.phase = 'rolling';
  await db.collection('games').doc(gameId).update({ data: { currentSeat: aiSeat, phase: 'rolling' } });
  await fns.aiTick.main({});
  const after = (await db.collection('games').doc(gameId).get()).data;
  check('aiTick 不推进已接管座位', after.currentSeat === aiSeat, 'seat=' + after.currentSeat);
}
// ---------- 主流程 ----------
async function main() {
  console.log('=== 云函数集成测试 ===');
  const ctx = await scenarioRoom();
  const gctx = await scenarioGame(ctx);
  ctx.gameId = gctx.gameId;
  await scenarioHosting(ctx);
  await scenarioAiTick(ctx);
  await scenarioWxacode(ctx);
  await scenarioLeave(ctx);
  await scenarioConcurrency(ctx);
  await scenarioCompositions();
  await scenarioTakeover();
  await scenarioConcurrency(ctx);
  console.log('----------------------');
  console.log('通过 %d 项，失败 %d 项', passed, failed);
  if (failed > 0) {
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }
  console.log('✓ 云函数集成测试全部通过');
}

main().then(uninstall).catch((e) => {
  console.error('测试进程异常：', e);
  process.exit(1);
});
