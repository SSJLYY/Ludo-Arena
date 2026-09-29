const cloud = require('wx-server-sdk');
const move = require('./engine/move.js');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 开局：校验房主 + 满 4 座，用引擎 createGame 生成权威对局快照
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { roomId } = event || {};
  if (!roomId) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  const room = (await rooms.doc(roomId).get()).data;
  if (!room) return { err: 'ROOM_NOT_FOUND' };
  if (room.ownerOpenId !== OPENID) return { err: 'NOT_OWNER' };
  if (room.status === 'playing') return { ok: true, gameId: room.gameId }; // 幂等

  const filled = room.seats.filter((s) => s.type === 'human' || s.type === 'ai');
  if (filled.length < 4) return { err: 'NOT_ENOUGH_PLAYERS' };

  const game = move.createGame({
    roomId: roomId,
    seats: room.seats.map((s) => ({
      type: s.type,
      openId: s.openId || '',
      nickName: s.nickName || '',
      avatarUrl: s.avatarUrl || '',
      aiLevel: s.aiLevel || 0
    })),
    needExactFinish: room.settings.needExactFinish !== false,
    allowJump: room.settings.allowJump !== false,
    allowFly: room.settings.allowFly !== false,
    allowItems: room.settings.allowItems !== false
  });

  const gameId = 'g_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  await db.collection('games').doc(gameId).set({ data: game });
  await rooms.doc(roomId).update({
    data: { status: 'playing', gameId: gameId, updatedAt: Date.now() }
  });

  // 真人玩家的 lastRoomId（供「继续上局」回归）
  for (const seat of room.seats) {
    if (seat.type === 'human' && seat.openId) {
      try {
        await db.collection('users').doc(seat.openId).update({
          data: { lastRoomId: roomId, updatedAt: Date.now() }
        });
      } catch (e) { /* 忽略 */ }
    }
  }

  return { ok: true, gameId: gameId };
};
