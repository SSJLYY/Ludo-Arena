const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 座位操作：sit 入座 / stand 起身 / addAI / removeAI / setAiLevel / kick
// 裁定：只有房主可改动他人座位与 AI 配置（架构文档 7.2）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { roomId, seatIndex, action, aiLevel, profile } = event || {};
  if (!roomId || !(seatIndex >= 0 && seatIndex <= 3)) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  const room = (await rooms.doc(roomId).get()).data;
  if (!room) return { err: 'ROOM_NOT_FOUND' };

  const seat = room.seats[seatIndex];
  const isOwner = room.ownerOpenId === OPENID;
  const myIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === OPENID);
  const now = Date.now();
  const path = 'seats.' + seatIndex;

  // v1.18 观战者接管 AI 座位：对局中也允许，单独处理（涉及 games 文档同步）
  if (action === 'takeover') {
    if (myIdx >= 0) return { err: 'PARAM', msg: '你已经有座位了' };
    if (room.status !== 'waiting' && room.status !== 'playing') return { err: 'ROOM_CLOSED' };
    if (seat.type !== 'ai') return { err: 'PARAM', msg: '只能接管 AI 座位' };
    // 从观战名单移除（若在）
    const spectatorMap = room.spectators || {};
    const spectators = Object.keys(spectatorMap)
      .filter((k) => spectatorMap[k] && spectatorMap[k].openId !== OPENID)
      .map((k) => spectatorMap[k]);
    const humanSeat = Object.assign({}, seat, {
      type: 'human',
      openId: OPENID,
      nickName: String((profile && profile.nickName) || '玩家' + (seatIndex + 1)).slice(0, 20),
      avatarUrl: String((profile && profile.avatarUrl) || '').slice(0, 500),
      aiLevel: 0,
      isOnline: true,
      lastSeen: now,
      isHosted: false
    });
    // 先改房间（原子：座位仍是 AI 才允许），再同步对局文档
    const res = await rooms.where({ _id: roomId, ['seats.' + seatIndex + '.type']: 'ai' })
      .update({
        data: {
          [path]: humanSeat,
          spectators: spectators,
          updatedAt: now
        }
      });
    if (res.stats.updated !== 1) return { err: 'SEAT_TAKEN' };
    // 对局进行中：同步 players 字段（CAS 重试，失败则回滚房间座位为 AI）
    if (room.status === 'playing' && room.gameId) {
      const games = db.collection('games');
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        const game = (await games.doc(room.gameId).get()).data;
        const upd = await games.where({ _id: room.gameId, seq: game.seq }).update({
          data: {
            ['players.' + seatIndex + '.type']: 'human',
            ['players.' + seatIndex + '.openId']: OPENID,
            ['players.' + seatIndex + '.nickName']: humanSeat.nickName,
            ['players.' + seatIndex + '.avatarUrl']: humanSeat.avatarUrl,
            updatedAt: Date.now()
          }
        });
        ok = !!(upd.stats && upd.stats.updated === 1);
      }
      if (!ok) {
        // 回滚：恢复 AI 座位
        await rooms.doc(roomId).update({ data: { [path]: seat, updatedAt: Date.now() } });
        return { err: 'SEQ_CONFLICT', msg: '接管失败，请重试' };
      }
      // 从观战名单移除该用户
      await rooms.doc(roomId).update({
        data: { spectators: spectators }
      });
      return { ok: true, takeover: true };
    }
    return { ok: true, takeover: true };
  }

  if (room.status !== 'waiting') return { err: 'ROOM_STARTED' };

  function emptySeat(i) {
    return {
      index: i,
      color: ['red', 'yellow', 'blue', 'green'][i],
      type: 'empty',
      openId: '', nickName: '', avatarUrl: '', aiLevel: 0,
      isOnline: false, lastSeen: 0, isHosted: false
    };
  }

  switch (action) {
    case 'sit': {
      if (myIdx >= 0) return { err: 'PARAM', msg: '你已经在座位上了' };
      if (seat.type !== 'empty') return { err: 'SEAT_TAKEN' };
      const s = Object.assign(emptySeat(seatIndex), {
        type: 'human',
        openId: OPENID,
        nickName: String((profile && profile.nickName) || '玩家' + (seatIndex + 1)).slice(0, 20),
        avatarUrl: String((profile && profile.avatarUrl) || '').slice(0, 500),
        isOnline: true,
        lastSeen: now
      });
      const res = await rooms.where({ _id: roomId, ['seats.' + seatIndex + '.type']: 'empty' })
        .update({ data: { [path]: s, updatedAt: now } });
      if (res.stats.updated !== 1) return { err: 'SEAT_TAKEN' };
      break;
    }
    case 'stand': {
      if (myIdx !== seatIndex) return { err: 'NOT_IN_ROOM' };
      await rooms.doc(roomId).update({ data: { [path]: emptySeat(seatIndex), updatedAt: now } });
      break;
    }
    case 'addAI': {
      if (!isOwner) return { err: 'NOT_OWNER' };
      if (seat.type !== 'empty') return { err: 'SEAT_TAKEN' };
      const lv = [1, 2, 3, 4].indexOf(aiLevel) >= 0 ? aiLevel : (room.settings.aiLevel || 2);
      const names = { 1: '电脑·简单', 2: '电脑·普通', 3: '电脑·困难', 4: '电脑·大师' };
      const s = Object.assign(emptySeat(seatIndex), { type: 'ai', nickName: names[lv], aiLevel: lv });
      const res = await rooms.where({ _id: roomId, ['seats.' + seatIndex + '.type']: 'empty' })
        .update({ data: { [path]: s, updatedAt: now } });
      if (res.stats.updated !== 1) return { err: 'SEAT_TAKEN' };
      break;
    }
    case 'removeAI': {
      if (!isOwner) return { err: 'NOT_OWNER' };
      if (seat.type !== 'ai') return { err: 'PARAM' };
      await rooms.doc(roomId).update({ data: { [path]: emptySeat(seatIndex), updatedAt: now } });
      break;
    }
    case 'setAiLevel': {
      if (!isOwner) return { err: 'NOT_OWNER' };
      if (seat.type !== 'ai') return { err: 'PARAM' };
      const lv = [1, 2, 3, 4].indexOf(aiLevel) >= 0 ? aiLevel : 2;
      const names = { 1: '电脑·简单', 2: '电脑·普通', 3: '电脑·困难', 4: '电脑·大师' };
      await rooms.doc(roomId).update({
        data: { [path + '.aiLevel']: lv, [path + '.nickName']: names[lv], updatedAt: now }
      });
      break;
    }
    case 'kick': {
      if (!isOwner) return { err: 'NOT_OWNER' };
      if (seat.type !== 'human') return { err: 'PARAM' };
      if (seat.openId === OPENID) return { err: 'PARAM', msg: '不能踢自己，用「离开」' };
      await rooms.doc(roomId).update({ data: { [path]: emptySeat(seatIndex), updatedAt: now } });
      break;
    }
    default:
      return { err: 'PARAM' };
  }

  const fresh = (await rooms.doc(roomId).get()).data;
  return { ok: true, seats: fresh.seats };
};
