const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ALLOWED_EMOTES = ['👍', '😂', '😭', '🎉', '😡', '🤔', '🚀', '💥'];
const MAX_EMOTES = 20;

// v1.1 表情互动：对局/房间内快捷表情，写 rooms.emotes（不碰 games.seq，不影响状态机）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { roomId, type } = event || {};
  if (!roomId || ALLOWED_EMOTES.indexOf(type) < 0) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  let room;
  try {
    room = (await rooms.doc(roomId).get()).data;
  } catch (e) {
    return { err: 'ROOM_NOT_FOUND' };
  }
  if (!room) return { err: 'ROOM_NOT_FOUND' };

  // 发送者身份：座位玩家或观战者
  const seatIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === OPENID);
  const spectatorMap = room.spectators || {};
  const isSpectator = Object.keys(spectatorMap).some((k) => spectatorMap[k] && spectatorMap[k].openId === OPENID);
  if (seatIdx < 0 && !isSpectator) return { err: 'NOT_IN_ROOM' };

  // v1.2 限频：同一用户 3 秒内只发一条
  const emotes = (room.emotes || []);
  const mine = emotes.filter((e) => e.openId === OPENID);
  const myLast = mine[mine.length - 1];
  const now = Date.now();
  if (myLast && now - myLast.ts < 3000) {
    return { err: 'EMOTE_TOO_FAST', msg: '表情发得太快啦' };
  }

  const from = seatIdx >= 0 ? room.seats[seatIdx].nickName
    : ((Object.values(spectatorMap).find((s) => s.openId === OPENID) || {}).nickName);

  const kept = emotes.slice(-MAX_EMOTES + 1);
  kept.push({
    seat: seatIdx,          // -1 = 观战者
    openId: OPENID,
    from: from || '',
    type: type,
    ts: now
  });
  await rooms.doc(roomId).update({ data: { emotes: kept, updatedAt: now } });
  return { ok: true };
};
