// [自动生成] 共享模块：昵称内容安全（msgSecCheck）
// 请勿直接修改；改动请编辑源文件后运行 node tools/sync-engine.js
'use strict';

const cloud = require('wx-server-sdk');

// 返回 {ok:true} 放行 / {ok:false} 拒绝。
// 容错策略：未发布版本 openapi 可能不可用（非 87014 错误）→ 放行并记日志，不阻塞主流程。
async function checkText(openid, content) {
  const text = String(content || '').trim();
  if (!text) return { ok: true };
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid: openid,
      scene: 2,
      version: 2,
      content: text
    });
    const suggest = res && res.result && res.result.suggest;
    return { ok: !suggest || suggest === 'pass' };
  } catch (e) {
    // 87014 = 内容违规；其余（未发布/openapi 权限）视为服务不可用，放行
    const code = e && (e.errCode !== undefined ? e.errCode : e.errMsg);
    if (String(code).indexOf('87014') >= 0) return { ok: false };
    console.warn('[sec] msgSecCheck unavailable:', code);
    return { ok: true, skipped: true };
  }
}

module.exports = { checkText };
