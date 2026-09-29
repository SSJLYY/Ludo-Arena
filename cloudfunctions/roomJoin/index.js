const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const sec = require('./sec.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_SPECTATORS = 4;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// 加入房间：支持 roomId（分享卡片直达）或 roomNo（手输房号）
// v1.1：满 4 座时转为观战席（最多 4 人）；昵称接入 msgSecCheck（容错）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const rooms = db.collection('rooms');
  let room = null;
  try {
    if (event.roomId) {
      room = (await rooms.doc(event.roomId).get()).data;
    } else if (event.roomNo) {
      const res = await rooms.where({ roomNo: String(event.roomNo) }).limit(1).get();
      room = res.data[0] || null;
    }
  } catch (e) { room = null; }
  if (!room) return { err: 'ROOM_NOT_FOUND' };
  if (room.status === 'dissolved') return { err: 'ROOM_NOT_FOUND' };

  const profile = event.profile || {};
  const spectators = room.spectators || {};

  // 已在座位 → 直接回归（分享链接重复点击 / 断线重连）
  const myIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === OPENID);
  if (myIdx >= 0) {
    return { ok: true, roomId: room._id, roomNo: room.roomNo, seatIndex: myIdx, rejoin: true };
  }
  // 已是观战者 → 回归观战
  if (Object.keys(spectators).some((k) => spectators[k] && spectators[k].openId === OPENID)) {
    return { ok: true, roomId: room._id, roomNo: room.roomNo, spectator: true, rejoin: true };
  }

  // v1.14 观战加入统一走「计数原子递增 + 追加列表」：并发下硬上限不超
  // （spectatorCount 条件递增保证上限；数组为展示用途，极端并发下可能少记昵称）
  async function addSpectator(roomId) {
    const res = await rooms
      .where({ _id: roomId, spectatorCount: _.lt(MAX_SPECTATORS) })
      .update({
        data: {
          spectatorCount: _.inc(1),
          ['spectators.' + OPENID.replace(/[^a-zA-Z0-9_-]/g, '_')]: {
            openId: OPENID,
            nickName: String(profile.nickName || '观众').slice(0, 20),
            avatarUrl: String(profile.avatarUrl || '').slice(0, 500),
            joinedAt: Date.now()
          },
          updatedAt: Date.now()
        }
      });
    return res.stats.updated === 1;
  }

  if (room.status === 'waiting' && room.seats.every((s) => s.type !== 'empty')) {
    // v1.1：开局前满座 → 入观战席
    const added = await addSpectator(room._id);
    if (!added) return { err: 'ROOM_FULL' };
    try {
      await db.collection('users').doc(OPENID).update({
        data: { lastRoomId: room._id, updatedAt: Date.now() }
      });
    } catch (e) { /* 忽略 */ }
    return { ok: true, roomId: room._id, roomNo: room.roomNo, spectator: true };
  }

  if (room.status === 'playing') {
    // 对局中加入：有座位可补位则补位，否则观战
    const hasEmpty = room.seats.some((s) => s.type === 'empty');
    if (!hasEmpty) {
      const added = await addSpectator(room._id);
      if (!added) return { err: 'ROOM_FULL' };
      try {
        await db.collection('users').doc(OPENID).update({
          data: { lastRoomId: room._id, updatedAt: Date.now() }
        });
      } catch (e) { /* 忽略 */ }
      return { ok: true, roomId: room._id, roomNo: room.roomNo, spectator: true };
    }
  } else if (room.status !== 'waiting') {
    return { err: 'ROOM_CLOSED' };
  }

  // 密码校验（哈希与盐存 room_auth 集合，客户端不可读）
  // v1.3：错误计数按用户独立——同房间不同人互不影响，各自 3 次错误锁 60 秒
  if (room.hasPassword) {
    let auth = null;
    try {
      auth = (await db.collection('room_auth').doc(room._id).get()).data;
    } catch (e) { auth = null; }
    const now = Date.now();
    if (!auth) return { err: 'WRONG_PASSWORD' };
    const myEntry = (auth.failsByUser || {})[OPENID] || { fails: 0, lockUntil: 0 };
    if (myEntry.lockUntil && myEntry.lockUntil > now) {
      return { err: 'LOCKED', msg: '密码错误次数过多，' + Math.ceil((myEntry.lockUntil - now) / 1000) + ' 秒后再试' };
    }
    if (sha256(auth.salt + (event.password || '')) !== auth.passwordHash) {
      const fails = (myEntry.fails || 0) + 1;
      const entry = { fails: fails, lockUntil: 0 };
      let msg;
      if (fails >= 3) {
        entry.fails = 0;
        entry.lockUntil = now + 60000;
        msg = '密码错误次数过多，锁定 60 秒';
      } else {
        msg = '密码错误，还可尝试 ' + (3 - fails) + ' 次';
      }
      await db.collection('room_auth').doc(room._id).update({
        data: { ['failsByUser.' + OPENID]: entry, updatedAt: now }
      });
      return { err: 'WRONG_PASSWORD', msg: msg };
    }
    await db.collection('room_auth').doc(room._id).update({
      data: { ['failsByUser.' + OPENID]: { fails: 0, lockUntil: 0 }, updatedAt: now }
    });
  }

  // 昵称内容安全（openapi 不可用时容错放行）
  if (profile.nickName) {
    const check = await sec.checkText(OPENID, profile.nickName);
    if (!check.ok) return { err: 'NICKNAME_INVALID', msg: '昵称包含违规内容，请先在「我的」里修改' };
  }

  // 依序找空位并原子占座（防两人抢同一座位）
  const order = [0, 1, 2, 3].filter((i) => room.seats[i].type === 'empty');
  for (const idx of order) {
    const seat = {
      index: idx,
      color: ['red', 'yellow', 'blue', 'green'][idx],
      type: 'human',
      openId: OPENID,
      nickName: String(profile.nickName || '玩家' + (idx + 1)).slice(0, 20),
      avatarUrl: String(profile.avatarUrl || '').slice(0, 500),
      aiLevel: 0,
      isOnline: true,
      lastSeen: Date.now(),
      isHosted: false
    };
    const res = await rooms.where({ _id: room._id, ['seats.' + idx + '.type']: 'empty' })
      .update({ data: { ['seats.' + idx]: seat, updatedAt: Date.now() } });
    if (res.stats.updated === 1) {
      try {
        await db.collection('users').doc(OPENID).update({
          data: { lastRoomId: room._id, updatedAt: Date.now() }
        });
      } catch (e) { /* 忽略 */ }
      return { ok: true, roomId: room._id, roomNo: room.roomNo, seatIndex: idx };
    }
    // 座位被抢，尝试下一个
  }

  // v1.14 并发抢座失利：重读房间，若已满员则转为观战（而非直接 ROOM_FULL）
  const fresh = (await rooms.doc(room._id).get()).data;
  if (fresh && fresh.status === 'waiting' && fresh.seats.every((s) => s.type !== 'empty')) {
    const added = await addSpectator(fresh._id);
    if (!added) return { err: 'ROOM_FULL' };
    return { ok: true, roomId: fresh._id, roomNo: fresh.roomNo, spectator: true };
  }
  return { err: 'ROOM_FULL' };
};
