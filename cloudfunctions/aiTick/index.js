const cloud = require('wx-server-sdk');
const engine = require('./engine/engine.js');
const createShared = require('./shared.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// v1.5 定时器：全离线时服务端自动推进 AI 对局（修复「AI 无观察者时暂停」）。
// 触发节奏见 config.json（每 20 秒）；扫描 updatedAt 停滞 >8s 的进行中对局，
// 与客户端 AI_STEP 触发通过 seq 乐观锁天然去重，谁先写入谁生效。
// 只推进 type=ai 的座位或已在房间侧标记 isHosted 的真人座位。
exports.main = async () => {
  const now = Date.now();
  const staleBefore = now - 8000;

  let res;
  try {
    res = await db.collection('games')
      .where({ status: 'playing', updatedAt: db.command.lt(staleBefore) })
      .limit(5)
      .get();
  } catch (e) {
    console.warn('[aiTick] scan failed', e && e.errMsg);
    return { ok: false };
  }

  const shared = createShared(cloud, db, require('./engine/achievements.js'));
  let advanced = 0;

  for (const game of res.data || []) {
    try {
      if (!game.players || !game.players[game.currentSeat]) continue;
      let room = null;
      try { room = (await db.collection('rooms').doc(game.roomId).get()).data; } catch (e) { room = null; }
      const seat = game.currentSeat;
      const gameSeat = game.players[seat];
      const roomSeat = room && room.seats ? room.seats[seat] : null;
      const isAuto = gameSeat.type === 'ai' || (roomSeat && roomSeat.type === 'human' && roomSeat.isHosted);
      if (!isAuto) continue;

      const level = roomSeat && roomSeat.type === 'ai'
        ? (roomSeat.aiLevel || (room && room.settings && room.settings.aiLevel) || 2)
        : ((room && room.settings && room.settings.aiLevel) || 2);

      // 一次调用跑完该 AI 座位的整回合（与 AI_STEP 相同的引擎入口）
      const steps = engine.runAiTurn(game, Math.random, () => level);
      let cur = game;
      let persisted = 0;
      for (const step of steps) {
        if (!(await shared.casWrite(game._id, cur.seq, step.state))) break;
        cur = step.state;
        persisted++;
      }
      if (persisted > 0) {
        advanced++;
        if (cur.status === 'finished') await shared.onFinished(game._id, cur, room);
      }
    } catch (e) {
      console.warn('[aiTick] advance failed', game && game._id, e && e.errMsg);
    }
  }

  const cleaned = await cleanupOld(db, now);
  return { ok: true, scanned: (res.data || []).length, advanced: advanced, cleaned: cleaned };
};

// v1.11 存储卫生（每约 10 分钟一次，按触发时间戳分钟取模判断，实例无状态）：
// 清理 7 天前的完结对局 / 解散房间 / 操作流水，防止集合无限增长
async function cleanupOld(db, now) {
  if (Math.floor(now / 60000) % 10 !== 0) return 0;
  const cutoff = now - 7 * 24 * 3600 * 1000;
  const _ = db.command;
  let removed = 0;
  try {
    const r1 = await db.collection('games')
      .where({ status: 'finished', updatedAt: _.lt(cutoff) }).limit(20).remove();
    removed += (r1.stats && r1.stats.removed) || 0;
  } catch (e) { /* 忽略 */ }
  try {
    const r2 = await db.collection('rooms')
      .where({ status: 'dissolved', updatedAt: _.lt(cutoff) }).limit(20).remove();
    removed += (r2.stats && r2.stats.removed) || 0;
  } catch (e) { /* 忽略 */ }
  try {
    const r3 = await db.collection('moves')
      .where({ ts: _.lt(cutoff) }).limit(50).remove();
    removed += (r3.stats && r3.stats.removed) || 0;
  } catch (e) { /* 忽略 */ }
  return removed;
}
