/**
 * audit.js — v14 敏感操作审计日志（JSONL 追加写 + 简单轮转）
 *
 * 记录所有发奖励/交易/后台管理操作（含被防刷拦截的尝试），
 * 落 ${DATA_DIR}/audit.jsonl，超过 512KB 轮转为 .old（保留一份）。
 * 后台 /api/admin/audit 可查看最近 N 条。
 */

const fs = require('fs');
const path = require('path');

let file = '';
const ROTATE_BYTES = 512 * 1024;

function init(dataDir) {
  file = path.join(dataDir, 'audit.jsonl');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* 目录已存在 */ }
}

/** kind: ad_reward / transfer / subscribe / sign / daily_claim / shop_buy / admin_* / blocked_* … */
function log(kind, nick, detail) {
  if (!file) return;
  const entry = { at: Date.now(), kind, nick: String(nick || '').slice(0, 16), detail: detail || {} };
  try {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) {
        fs.renameSync(file, file + '.old');
      }
    } catch (e) { /* 轮转失败不影响写入 */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
  return entry;
}

/** 最近 n 条（新在前）；includeOld 为真时把 .old 也拼上 */
function list(n, includeOld) {
  if (!file) return [];
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { return []; }
  };
  const old = includeOld ? read(file + '.old') : [];
  return old.concat(read(file)).slice(-n).reverse();
}

module.exports = { init, log, list };
