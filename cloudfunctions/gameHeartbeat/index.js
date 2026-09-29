const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 在线心跳（客户端 10s 一次）：
//  - 更新自己的 lastSeen / isOnline / 解除托管
//  - v1.1：event.hosted=true/false 主动开关 AI 托管（挂机免掉线等待）
//  - 巡检：掉线 >30s 的真人座位自动切 AI 托管（对局不卡死）
//  - 房主掉线 >60s 自动转移房主权限
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };

  const { roomId } = event || {};
  if (!roomId) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  let room;
  try {
    room = (await rooms.doc(roomId).get()).data;
  } catch (e) {
    return { ok: false, err: 'ROOM_NOT_FOUND' };
  }
  if (!room) return { ok: false, err: 'ROOM_NOT_FOUND' };

  const now = Date.now();
  const myIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === OPENID);
  if (myIdx < 0) return { ok: true, seat: -1 };

  // 主动托管开关：带 hosted 参数时按参数设置（心跳期间保持）；否则视为回线接管
  const patch = {
    ['seats.' + myIdx + '.lastSeen']: now,
    ['seats.' + myIdx + '.isOnline']: true,
    ['seats.' + myIdx + '.isHosted']: event.hosted === true,
    updatedAt: now
  };

  // 巡检其它真人座位
  for (let i = 0; i < 4; i++) {
    if (i === myIdx) continue;
    const s = room.seats[i];
    if (s.type !== 'human') continue;
    const silentFor = now - (s.lastSeen || 0);
    if (silentFor > 30000 && (s.isOnline || !s.isHosted)) {
      patch['seats.' + i + '.isOnline'] = false;
      patch['seats.' + i + '.isHosted'] = true;
    }
  }

  // 房主掉线转移（>60s 且存在其他在线真人）
  const ownerSeatIdx = room.seats.findIndex((s) => s.type === 'human' && s.openId === room.ownerOpenId);
  if (ownerSeatIdx >= 0 && ownerSeatIdx !== myIdx) {
    const ownerSilent = now - (room.seats[ownerSeatIdx].lastSeen || 0);
    if (ownerSilent > 60000) {
      const nextOwner = room.seats.find((s, i) =>
        s.type === 'human' && i !== ownerSeatIdx && (s.isOnline || now - (s.lastSeen || 0) <= 30000));
      if (nextOwner) patch.ownerOpenId = nextOwner.openId;
    }
  }

  await rooms.doc(roomId).update({ data: patch });

  // 顺手刷新 lastRoomId（用户中途杀进程后可「继续上局」）
  try {
    await db.collection('users').doc(OPENID).update({
      data: { lastRoomId: roomId, updatedAt: now }
    });
  } catch (e) { /* 忽略 */ }

  return { ok: true, seat: myIdx, now: now };
};
