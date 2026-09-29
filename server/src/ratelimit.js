/**
 * ratelimit.js — v14 发奖励/交易接口防刷（内存滑动窗口 + 每日上限）
 *
 * 为什么在服务端：前端限制形同虚设，curl 直打 /api/ad/reward 可以无限刷金币钻石。
 * 设计：
 *   - 键 = 接口名 + 用户昵称（同一人多接口分开计数）。
 *   - 两层约束：minIntervalMs 最小操作间隔（防连点/脚本）；dailyMax 每日次数上限（东八区自然日）。
 *   - 规则可被 ABUSE_CONFIG 环境变量（JSON）整体覆盖，测试用小间隔快速验证。
 *   - 纯内存：重启即清零，误伤代价低；真实运营数据以审计日志（audit.js）为准。
 */

// 默认规则：key → { minIntervalMs, dailyMax }（dailyMax 缺省 = 不限次）
const DEFAULT_RULES = {
  adReward: { minIntervalMs: 30000, dailyMax: { coin: 10, diamond: 5 } },
  transfer: { minIntervalMs: 10000 },
  subscribe: { minIntervalMs: 10000 },
  subGrant: { minIntervalMs: 10000 },
  sign: { minIntervalMs: 5000 },
  dailyClaim: { minIntervalMs: 5000 },
  weeklyClaim: { minIntervalMs: 5000 },
  puzzleClaim: { minIntervalMs: 5000 },
  shopBuy: { minIntervalMs: 2000 },
  shopBuyProp: { minIntervalMs: 2000 },
  // v16 房间防洪水（按客户端 IP 计数，防刷房刷满内存/大厅）
  // roomJoin 300ms：同一 WiFi 下好友们各自点「加入」互不干扰，但脚本洪泛被限
  tournamentJoin: { minIntervalMs: 3000, dailyMax: 3 }, // v21 锦标赛报名（奖励发币入口）
  adminTry: { minIntervalMs: 500, dailyMax: 200 }, // v42 后台凭证试错（防在线爆破 ADMIN_TOKEN）
  clientError: { minIntervalMs: 500 }, // v32 前端异常上报（每 IP 每秒最多 2 条，防滥用）
  roomCreate: { minIntervalMs: 2000 },
  roomJoin: { minIntervalMs: 300 },
  pveStart: { minIntervalMs: 2000 },
};

let rules = DEFAULT_RULES;

/** 用环境变量覆盖规则（ABUSE_CONFIG=JSON；测试把间隔调成毫秒级） */
function initFromEnv() {
  if (!process.env.ABUSE_CONFIG) return;
  try {
    const patch = JSON.parse(process.env.ABUSE_CONFIG);
    rules = Object.assign({}, DEFAULT_RULES);
    for (const k of Object.keys(patch)) {
      rules[k] = Object.assign({}, rules[k] || {}, patch[k]);
    }
  } catch (e) {
    console.error('[ratelimit] ABUSE_CONFIG 解析失败，使用默认规则:', e.message);
  }
}

// key(name:nick) → { last, day, count: {kind: n} }
const hits = new Map();

function today() {
  // 与 stats.js dayStr 同口径：东八区自然日
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

/**
 * 通过返回 { ok:true }；被拦返回 { ok:false, error, retryAfter }（不抛错，调用方直接 res.json）。
 * @param {string} name  接口规则名（DEFAULT_RULES 的 key）
 * @param {string} nick  用户标识
 * @param {string} kind  可选：同规则下的分子类（如 adReward 的 coin/diamond 分开计日上限）
 */
function guard(name, nick, kind) {
  const rule = rules[name];
  if (!rule) return { ok: true };
  const key = name + ':' + String(nick || '').slice(0, 16);
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.day !== today()) {
    h = { last: 0, day: today(), count: {} };
    hits.set(key, h);
  }
  if (rule.minIntervalMs > 0 && now - h.last < rule.minIntervalMs) {
    return { ok: false, error: 'RATE_LIMITED', retryAfter: Math.ceil((rule.minIntervalMs - (now - h.last)) / 1000) };
  }
  if (rule.dailyMax) {
    const cap = (typeof rule.dailyMax === 'number') ? rule.dailyMax : rule.dailyMax[kind || ''];
    if (cap > 0 && (h.count[kind || '_'] || 0) >= cap) {
      return { ok: false, error: 'DAILY_LIMIT', used: cap };
    }
  }
  h.last = now;
  h.count[kind || '_'] = (h.count[kind || '_'] || 0) + 1;
  return { ok: true };
}

/** 后台/测试观察用：当前追踪的键数量 */
function size() { return hits.size; }

module.exports = { initFromEnv, guard, size, DEFAULT_RULES };
