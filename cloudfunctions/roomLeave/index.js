const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 离开房间：waiting 阶段腾出座位并转移房主；playing 阶段视为掉线托管
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { roomId } = event || {};
  if (!roomId) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  const room = (await rooms.doc(roomId).get()).data;
  if (!room) return { err: 'ROOM_NOT_FOUND' };

  const myIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === OPENID);
  const now = Date.now();
  if (myIdx < 0) {
    // v1.14：观战者离开（计数递减 + 条目置空）
    const spectators = room.spectators || {};
    const myKey = Object.keys(spectators).find((k) => spectators[k] && spectators[k].openId === OPENID);
    if (myKey) {
      await rooms.doc(roomId).update({
        data: {
          ['spectators.' + myKey]: null,
          spectatorCount: db.command.inc(-1),
          updatedAt: now
        }
      });
      return { ok: true, spectator: true };
    }
    return { ok: true, seatIndex: -1 };
  }

  // 对局中：座位保留，切 AI 托管（防止四人局报废）
  if (room.status === 'playing') {
    await rooms.doc(roomId).update({
      data: { ['seats.' + myIdx + '.isOnline']: false, ['seats.' + myIdx + '.isHosted']: true, updatedAt: now }
    });
    return { ok: true, seatIndex: myIdx, hosted: true };
  }

  function emptySeat(i) {
    return {
      index: i,
      color: ['red', 'yellow', 'blue', 'green'][i],
      type: 'empty',
      openId: '', nickName: '', avatarUrl: '', aiLevel: 0,
      isOnline: false, lastSeen: 0, isHosted: false
    };
  }

  const patch = { ['seats.' + myIdx]: emptySeat(myIdx), updatedAt: now };
  const remainingHumans = room.seats.filter((s, i) => i !== myIdx && s.type === 'human');

  if (room.ownerOpenId === OPENID) {
    if (remainingHumans.length === 0) {
      // 没有真人了：解散房间
      patch.status = 'dissolved';
    } else {
      // 房主权限转移给下一个真人
      patch.ownerOpenId = remainingHumans[0].openId;
    }
  }
  if (patch.status === 'dissolved' || remainingHumans.length === 0) {
    // 清空所有 AI 座位
    for (let i = 0; i < 4; i++) {
      if (i !== myIdx && room.seats[i].type === 'ai') patch['seats.' + i] = emptySeat(i);
    }
  }
  await rooms.doc(roomId).update({ data: patch });

  try {
    await db.collection('users').doc(OPENID).update({
      data: { lastRoomId: '', updatedAt: now }
    });
  } catch (e) { /* 忽略 */ }

  return { ok: true, seatIndex: myIdx, dissolved: patch.status === 'dissolved' };
};
