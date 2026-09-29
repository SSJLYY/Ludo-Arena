const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 获取小程序码（scene=roomId，扫码直达大厅并自动进房）
// 需在 config.json 声明 openapi 权限
// v1.10：envVersion 三环境降级链（正式版→体验版→开发版）
// v1.12：按环境版本缓存 fileID（rooms.wxacode_{envVersion}），同房间同版本只生成一次，
//        消除重复生成与云存储对象堆积
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { err: 'NO_AUTH' };
  const roomId = event && event.roomId;
  if (!roomId) return { err: 'PARAM' };

  const rooms = db.collection('rooms');
  let room = null;
  try { room = (await rooms.doc(roomId).get()).data; } catch (e) { room = null; }

  const versions = ['release', 'trial', 'develop'];
  // 先查各环境版本的缓存
  if (room) {
    for (const v of versions) {
      const cached = room['wxacode_' + v];
      if (cached) return { ok: true, fileID: cached, envVersion: v, cached: true };
    }
  }

  let lastErr = null;
  for (const envVersion of versions) {
    try {
      const res = await cloud.openapi.wxacode.getUnlimited({
        scene: String(roomId).slice(0, 32),
        page: 'pages/hall/hall',
        width: 280,
        checkPath: false,
        envVersion: envVersion
      });
      if (!res || !res.buffer) { lastErr = new Error('empty buffer'); continue; }
      const upload = await cloud.uploadFile({
        cloudPath: 'wxacode/' + roomId + '-' + envVersion + '-' + Date.now() + '.png',
        fileContent: Buffer.from(res.buffer)
      });
      if (room) {
        try {
          await rooms.doc(roomId).update({
            data: { ['wxacode_' + envVersion]: upload.fileID, updatedAt: Date.now() }
          });
        } catch (e) { /* 缓存写入失败不影响返回 */ }
      }
      return { ok: true, fileID: upload.fileID, envVersion: envVersion };
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn('[getWxacode] all envVersions failed:', lastErr && (lastErr.errMsg || lastErr.message));
  return { ok: false, msg: '小程序码生成失败' };
};
