/**
 * meta.js — P0 扩展存储层（JSON 文件，零依赖）
 *
 * 与 stats.js 同宿主约束：CentOS 7 / 内核 3.10 + overlayfs 下 SQLite 不可用，
 * 故复用 JSON 原子写(tmp→rename) + ensureFresh 模式。独立文件 meta.json，
 * 不撑大 stats.json（stats 已含玩家/对局/好友）。
 *
 * 存储 ${STATS_DIR:-<server>/data}/meta.json：
 *   guilds:  { gid -> {gid, name, owner, members:[nick], score, createdAt} }
 *   banners: [ {id, title, sub, color, url, active} ]   大厅活动轮播（后台可配）
 *   notices: string                                    大厅公告（后台可配）
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

let data = load();
let diskMtime = statMtime();

function statMtime() {
  try { return fs.statSync(META_FILE).mtimeMs; } catch (e) { return 0; }
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    return {
      guilds: raw && raw.guilds && typeof raw.guilds === 'object' ? raw.guilds : {},
      banners: Array.isArray(raw && raw.banners) ? raw.banners : [],
      notices: typeof (raw && raw.notices) === 'string' ? raw.notices : '',
      // 🔴 reports 必须在这里显式保留，否则 ensureFresh 重载会把举报记录抹掉
      reports: Array.isArray(raw && raw.reports) ? raw.reports : [],
      // v13 限时活动（后台配置，前端活动中心展示）
      events: Array.isArray(raw && raw.events) ? raw.events : [],
      // 🔴 v17 hall/lastSettledSeason 必须显式保留，否则 ensureFresh 重载会抹掉名人堂
      hall: Array.isArray(raw && raw.hall) ? raw.hall : [],
      lastSettledSeason: typeof (raw && raw.lastSettledSeason) === 'string' ? raw.lastSettledSeason : '',
      // 🔴 v18 mail 同理：站内信（战报）按 nick 分箱
      mail: raw && raw.mail && typeof raw.mail === 'object' ? raw.mail : {},
      // 🔴 v21 锦标赛进度同理
      tournaments: raw && raw.tournaments && typeof raw.tournaments === 'object' ? raw.tournaments : {},
      // 🔴 v26 历届锦标赛冠军
      champList: Array.isArray(raw && raw.champList) ? raw.champList : [],
    };
  } catch (e) {
    return { guilds: {}, banners: [], notices: '', reports: [], events: [], hall: [], lastSettledSeason: '', mail: {}, tournaments: {}, champList: [] };
  }
}

// ================= v17 名人堂（赛季结算归档） =================

/** 归档一个赛季的前三名（DUP 保护：同赛季只归档一次，防重复发奖） */
function addHallSeason(season, champions) {
  ensureFresh();
  if (!Array.isArray(data.hall)) data.hall = [];
  if (data.hall.some((h) => h.season === season)) return { ok: false, error: 'ALREADY_SETTLED' };
  data.hall.unshift({ season, champions, at: Date.now() });
  data.hall = data.hall.slice(0, 24); // 只留最近两年
  save();
  return { ok: true };
}

function getHall() {
  ensureFresh();
  return Array.isArray(data.hall) ? data.hall : [];
}

function getLastSettled() {
  ensureFresh();
  return data.lastSettledSeason || '';
}

function setLastSettled(season) {
  ensureFresh();
  data.lastSettledSeason = String(season || '');
  save();
}

// ================= v18 站内信（战报中心） =================
// 每局结束给参战真人落一条战报（昵称分箱，每人最多 30 条，新的在前）。
// 战报是公开对局结果的私有视图，读取不做凭证校验；标记已读同理（无害操作）。

function pushMail(nick, entry) {
  return pushMailRaw(nick, entry, true);
}

function pushMailRaw(nick, entry, persist) {
  const key = normalizeNick(nick);
  if (!key) return false;
  ensureFresh();
  if (!data.mail[key]) data.mail[key] = [];
  data.mail[key].unshift(Object.assign(
    { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), read: false },
    entry || {}
  ));
  data.mail[key] = data.mail[key].slice(0, 30);
  if (persist) save();
  return true;
}

/**
 * v33 批量投信：一局 4 人结束时若逐条 pushMail 会触发 4 次全量 meta.json 写盘
 * （同步阻塞事件循环），这里合并成一次落盘。
 * @param {Array} items [{ nick, entry }]
 */
function pushMailBatch(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  ensureFresh();
  let n = 0;
  list.forEach((it) => { if (pushMailRaw(it && it.nick, it && it.entry, false)) n += 1; });
  if (n) save();
  return n;
}

function listMail(nick) {
  ensureFresh();
  const list = (data.mail[normalizeNick(nick)] || []).slice();
  return { list, unread: list.filter((m) => !m.read).length };
}

// ================= v21 锦标赛进度（每人一条，覆盖式保存） =================

function getTournament(nick) {
  ensureFresh();
  return data.tournaments[normalizeNick(nick)] || null;
}

function setTournament(nick, t) {
  ensureFresh();
  data.tournaments[normalizeNick(nick)] = t || null;
  save();
}

// ================= v23 数据卫生（防长期膨胀） =================
// 锦标赛完成态 30 天、站内信 90 天、举报 90 天；公会/玩家资料是用户资产永不清理。

function pruneOld(now) {
  now = now || Date.now();
  ensureFresh();
  const removed = { tournaments: 0, mails: 0, reports: 0 };
  const TH_TOUR = 30 * 86400000, TH_LONG = 90 * 86400000;
  for (const k of Object.keys(data.tournaments)) {
    const t = data.tournaments[k];
    if (t && t.stage === 'done' && now - (t.updatedAt || 0) > TH_TOUR) { delete data.tournaments[k]; removed.tournaments += 1; }
  }
  for (const k of Object.keys(data.mail)) {
    const before = data.mail[k].length;
    data.mail[k] = data.mail[k].filter((m) => now - (m.at || 0) <= TH_LONG);
    removed.mails += before - data.mail[k].length;
    if (!data.mail[k].length) delete data.mail[k];
  }
  const rb = data.reports.length;
  data.reports = data.reports.filter((r) => now - (r.at || 0) <= TH_LONG);
  removed.reports = rb - data.reports.length;
  save();
  return removed;
}

// ================= v26 历届锦标赛冠军 =================

function addTournamentChampion(nick, reward) {
  ensureFresh();
  if (!Array.isArray(data.champList)) data.champList = [];
  const key = normalizeNick(nick);
  const prev = data.champList.find((c) => c.nick === key);
  if (prev) prev.count += 1;
  else data.champList.unshift({ nick: key, count: 1, at: Date.now(), reward: reward || 0 });
  data.champList = data.champList.slice(0, 50);
  save();
  return { ok: true };
}

function championList() {
  ensureFresh();
  return (Array.isArray(data.champList) ? data.champList : []).slice().sort((a, b) => (b.count - a.count) || (b.at - a.at));
}

function markMailRead(nick) {
  ensureFresh();
  const list = data.mail[normalizeNick(nick)] || [];
  let changed = false;
  list.forEach((m) => { if (!m.read) { m.read = true; changed = true; } });
  if (changed) save();
  return { ok: true, unread: 0 };
}

/** 文件被外部改动时自动重载，保证内存与磁盘一致（与 stats.js 一致） */
function ensureFresh() {
  const m = statMtime();
  if (m !== diskMtime) {
    data = load();
    diskMtime = m;
  }
}

/** 原子写：写临时文件后 rename；失败回退直接写 */
function save() {
  const str = JSON.stringify(data);
  const tmp = META_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, str);
    fs.renameSync(tmp, META_FILE);
  } catch (e) {
    try { fs.writeFileSync(META_FILE, str); } catch (e2) {
      console.error('[meta] save failed:', e2.message);
    }
  }
  diskMtime = statMtime();
}

// ================= 公会（guilds） =================

const normalizeNick = (n) => String(n || '').trim().slice(0, 16);

// v33 公会上限：防止单个公会无限加人撑大 meta.json
const GUILD_MAX_MEMBERS = 50;

function createGuild(name, owner) {
  name = String(name || '').trim().slice(0, 16);
  owner = normalizeNick(owner);
  if (!name || !owner) return { ok: false, error: 'NAME_OR_OWNER_REQUIRED' };
  ensureFresh();
  const gid = 'G' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
  data.guilds[gid] = {
    gid, name, owner, members: [owner], score: 0, createdAt: Date.now(),
  };
  save();
  return { ok: true, guild: data.guilds[gid] };
}

function getGuild(gid) {
  ensureFresh();
  return data.guilds[gid] || null;
}

function joinGuild(gid, nick) {
  nick = normalizeNick(nick);
  if (!nick) return { ok: false, error: 'NICK_REQUIRED' };
  ensureFresh();
  const g = data.guilds[gid];
  if (!g) return { ok: false, error: 'GUILD_NOT_FOUND' };
  if (!g.members.includes(nick)) {
    // v33：成员数上限，避免 meta.json 被无限撑大（公会战按成员累计分，50 人已足够）
    if (g.members.length >= GUILD_MAX_MEMBERS) return { ok: false, error: 'GUILD_FULL', max: GUILD_MAX_MEMBERS };
    g.members.push(nick);
  }
  save();
  return { ok: true, guild: g };
}

function leaveGuild(gid, nick) {
  nick = normalizeNick(nick);
  ensureFresh();
  const g = data.guilds[gid];
  if (!g) return { ok: false, error: 'GUILD_NOT_FOUND' };
  g.members = g.members.filter((m) => m !== nick);
  if (g.owner === nick) {
    // 会长退出：转移给剩余成员，无成员则解散
    if (g.members.length) g.owner = g.members[0];
    else { delete data.guilds[gid]; save(); return { ok: true, dissolved: true }; }
  }
  save();
  return { ok: true, guild: g };
}

function addGuildScore(gid, delta) {
  ensureFresh();
  const g = data.guilds[gid];
  if (!g) return { ok: false, error: 'GUILD_NOT_FOUND' };
  g.score = (g.score || 0) + (delta || 0); // 终身积分
  g.weekScore = (g.weekScore || 0) + (delta || 0); // v13 公会战（周积分，每周一清零）
  save();
  return { ok: true, guild: g };
}

/** v13 公会战：按自然周（周一）key 标记，跨周自动清零周积分 */
function guildWeekKey() {
  const d = new Date(Date.now() + 8 * 3600000);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
let _guildWeekKey = null;
function resetGuildWeekIfNeeded() {
  const wk = guildWeekKey();
  if (_guildWeekKey === wk) return;
  _guildWeekKey = wk;
  ensureFresh();
  Object.values(data.guilds).forEach((g) => { g.weekScore = 0; });
  save();
}

/** 公会排行：按 score 降序，取前 N */
function guildRank(n) {
  ensureFresh();
  return Object.values(data.guilds)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, Math.max(1, n || 10))
    .map((g, i) => ({ rank: i + 1, gid: g.gid, name: g.name, owner: g.owner, members: g.members.length, score: g.score || 0 }));
}

/** v13 公会战周榜：按 weekScore 降序 */
function guildWarRank(n) {
  resetGuildWeekIfNeeded();
  return Object.values(data.guilds)
    .sort((a, b) => (b.weekScore || 0) - (a.weekScore || 0))
    .slice(0, Math.max(1, n || 20))
    .map((g, i) => ({ rank: i + 1, gid: g.gid, name: g.name, members: g.members.length, weekScore: g.weekScore || 0 }));
}

/** 按成员昵称反查所属公会（一个昵称只属一个公会） */
function findGuildByMember(nick) {
  ensureFresh();
  nick = normalizeNick(nick);
  for (const g of Object.values(data.guilds)) if (g.members.includes(nick)) return g;
  return null;
}

/** 举报记录（轻量，存储最近 500 条，后台可查） */
function addReport(nick, target, reason) {
  ensureFresh();
  data.reports = data.reports || [];
  data.reports.push({ nick: normalizeNick(nick), target: normalizeNick(target), reason: String(reason || '').slice(0, 80), at: Date.now() });
  if (data.reports.length > 500) data.reports = data.reports.slice(-500);
  save();
  return { ok: true };
}

/** 后台查看举报：按被举报人聚合次数，最近的排前面 */
function listReports(n) {
  ensureFresh();
  const list = (data.reports || []).slice(-(n || 50)).reverse();
  const agg = {};
  (data.reports || []).forEach((r) => { agg[r.target] = (agg[r.target] || 0) + 1; });
  return list.map((r) => Object.assign({}, r, { totalOnTarget: agg[r.target] || 1 }));
}

// ================= 活动 banner / 公告 =================

function listBanners() {
  ensureFresh();
  return (data.banners || []).filter((b) => b.active !== false);
}

/**
 * v33 后台 banner 落库前净化：banner 的 url/color 会直插前端 innerHTML，
 * 这里统一限制 url 只许 http(s)，color 只许 #hex / 预置色名，堵住存储型 XSS 与 CSS 注入。
 */
function sanitizeBanner(b) {
  const rawUrl = String((b && b.url) || '').trim();
  let url = '';
  if (/^https?:\/\//i.test(rawUrl)) url = rawUrl.slice(0, 200);
  const rawColor = String((b && b.color) || '').trim();
  const color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : '#6a5cff';
  return {
    id: String((b && b.id) || Date.now().toString(36)).slice(0, 32),
    title: String((b && b.title) || '').slice(0, 30),
    sub: String((b && b.sub) || '').slice(0, 60),
    color,
    url,
    active: !b || b.active !== false,
  };
}

function setBanners(banners, notices) {
  ensureFresh();
  // 落库即净化：即便调用方（HTTP 路由）漏校验，存储层也不会留下可执行内容
  if (Array.isArray(banners)) data.banners = banners.slice(0, 20).map(sanitizeBanner);
  if (typeof notices === 'string') data.notices = notices.slice(0, 200);
  save();
  return { ok: true, banners: data.banners, notices: data.notices };
}

// ================= v13 限时活动 =================
// event: { id, title, type:'lottery'|'accumulate'|'share', desc, start, end, config }
function listEvents(activeOnly) {
  ensureFresh();
  const now = Date.now();
  let list = data.events || [];
  if (activeOnly) {
    list = list.filter((e) => {
      const s = e.start ? new Date(e.start).getTime() : 0;
      const en = e.end ? new Date(e.end).getTime() : Infinity;
      return now >= s && now <= en;
    });
  }
  return list;
}
function setEvents(events) {
  ensureFresh();
  if (!Array.isArray(events)) return { ok: false, error: 'BAD_EVENTS' };
  data.events = events;
  save();
  return { ok: true, events: data.events };
}

module.exports = {
  createGuild, getGuild, joinGuild, leaveGuild, addGuildScore, guildRank, findGuildByMember, guildWarRank,
  addReport, listReports, listBanners, setBanners,
  listEvents, setEvents,
  addHallSeason, getHall, getLastSettled, setLastSettled, // v17 名人堂
  pushMail, pushMailBatch, listMail, markMailRead, // v18 站内信 / v33 批量投信
  flush: save, // v33 优雅退出时强制落盘
  getTournament, setTournament, // v21 锦标赛
  pruneOld, addTournamentChampion, championList, // v23 数据卫生 / v26 冠军榜
};
