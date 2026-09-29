const cloud = require('wx-server-sdk');
const engine = require('./engine/engine.js');
const ai = require('./engine/ai.js');
const achievements = require('./engine/achievements.js');
const createShared = require('./shared.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// v1.5：CAS 写入与对局结算抽为共享模块，aiTick（定时器）复用同一实现
const shared = createShared(cloud, db, achievements);
const casWrite = shared.casWrite;
const onFinished = shared.onFinished;

// 【核心】对局行动入口。铁律：客户端只提交 action，随机数与规则判定全在服务端。
//  - ROLL / SELECT_PLANE：真人当前座位行动，一次 CAS 写入（seq 乐观锁）
//  - AI_STEP：由任一在线客户端触发，服务端一次调用跑完 AI/托管座位的整回合
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { gameId, action, payload } = event || {};
  if (!gameId || !action) return { err: 'PARAM' };

  const games = db.collection('games');
  let game;
  try {
    game = (await games.doc(gameId).get()).data;
  } catch (e) {
    return { err: 'GAME_NOT_FOUND' };
  }
  if (!game) return { err: 'GAME_NOT_FOUND' };
  if (game.status !== 'playing') return { err: 'GAME_ENDED' };

  // 房间数据提供在线状态（isHosted）与 AI 难度；房间文档缺失时降级用对局内嵌座位信息
  let room = null;
  try {
    room = (await db.collection('rooms').doc(game.roomId).get()).data;
  } catch (e) { room = null; }

  if (action === 'ROLL' || action === 'SELECT_PLANE' || action === 'USE_ITEM') {
    const seat = game.currentSeat;
    const meIdx = game.players.findIndex((p) => p.type === 'human' && p.openId === OPENID);
    if (meIdx !== seat) return { err: 'NOT_YOUR_TURN' };
    const roomSeat = room && room.seats ? room.seats[seat]
      : { type: game.players[seat].type, isHosted: false };
    if (roomSeat.type !== 'human' || roomSeat.isHosted) {
      return { err: 'NOT_YOUR_TURN' }; // 托管中由服务端 AI 代走
    }

    const act = action === 'ROLL'
      ? { type: 'ROLL', seat: seat }
      : (action === 'USE_ITEM'
        ? { type: 'USE_ITEM', seat: seat, item: payload && payload.item }
        : { type: 'SELECT_PLANE', seat: seat, planeId: payload && payload.planeId });
    const r = engine.advance(game, act, Math.random);
    if (!r.ok) return { err: r.error };

    const written = await casWrite(gameId, game.seq, r.state);
    if (!written) return { err: 'SEQ_CONFLICT' };
    logMove(gameId, r.state.seq, seat, action, r.events);
    await onFinished(gameId, r.state, room);
    return { ok: true, seq: r.state.seq, events: r.events };
  }

  if (action === 'AI_STEP') {
    let cur = game;
    let steps = 0;
    for (let guard = 0; guard < 12; guard++) {
      if (cur.status !== 'playing') break;
      const seat = cur.currentSeat;
      const roomSeat = room && room.seats ? room.seats[seat]
        : { type: cur.players[seat].type, isHosted: true };
      const isAuto = roomSeat.type === 'ai' || roomSeat.isHosted;
      if (!isAuto) break;
      const level = roomSeat.type === 'ai'
        ? (roomSeat.aiLevel || (room && room.settings && room.settings.aiLevel) || 2)
        : ((room && room.settings && room.settings.aiLevel) || 2); // 掉线托管用房间默认难度

      if (cur.phase === 'rolling') {
        const r = engine.advance(cur, { type: 'ROLL', seat: seat }, Math.random);
        if (!r.ok) break;
        if (!(await casWrite(gameId, cur.seq, r.state))) break; // 冲突即止，客户端会重新触发
        logMove(gameId, r.state.seq, seat, 'ai-roll', r.events);
        cur = r.state;
        steps++;
      } else if (cur.phase === 'selecting') {
        const pid = ai.choosePlane(cur, seat, cur.dice, level, Math.random);
        if (pid === null || pid === undefined) break;
        const r = engine.advance(cur, { type: 'SELECT_PLANE', seat: seat, planeId: pid }, Math.random);
        if (!r.ok) break;
        if (!(await casWrite(gameId, cur.seq, r.state))) break;
        logMove(gameId, r.state.seq, seat, 'ai-select', r.events);
        cur = r.state;
        steps++;
      } else {
        break;
      }
    }
    if (steps > 0) await onFinished(gameId, cur, room);
    return { ok: true, seq: cur.seq, steps: steps };
  }

  return { err: 'UNKNOWN_ACTION' };
};

// 操作流水（复盘 + 审计），失败不影响主流程
function logMove(gameId, seq, seat, action, events) {
  db.collection('moves').add({
    data: { gameId: gameId, seq: seq, seat: seat, action: action, events: events, ts: Date.now() }
  }).catch(() => { });
}
