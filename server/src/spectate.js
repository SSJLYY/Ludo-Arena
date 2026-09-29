/**
 * spectate.js — v14 观战者消息下发（含防偷跑延迟）
 *
 * websocket.js（broadcast）与 room-manager.js（notifyRoomUpdate）都要给观战者发消息，
 * 且观战者的对局状态必须延迟下发（防止场外串通报点），抽成共享模块避免循环依赖。
 * SPECTATE_DELAY_MS 环境变量可调（测试用小值）；0 = 关闭延迟。
 */

const DELAY = (() => {
  const v = parseInt(process.env.SPECTATE_DELAY_MS, 10);
  return Number.isFinite(v) ? v : 2500;
})();

/**
 * 给房间全部观战者发一条消息。
 * @param {object} room 房间对象（含 spectators Map）
 * @param {string|object} payload 字符串（已序列化）或对象
 * @param {string} type 消息类型；'state' 走延迟，其余即时
 */
function sendToSpectators(room, payload, type) {
  const sps = room && room.spectators;
  if (!sps || !sps.size) return;
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const send = () => {
    for (const sp of sps.values()) {
      if (sp && sp.ws && sp.ws.readyState === 1) sp.ws.send(str);
    }
  };
  if (type === 'state' && DELAY > 0) setTimeout(send, DELAY);
  else send();
}

module.exports = { sendToSpectators, DELAY };
