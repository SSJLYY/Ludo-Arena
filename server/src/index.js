/**
 * index.js — HTTP + WebSocket 服务入口
 */

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const roomsRouter = require('./routes/rooms');
const { attachWebSocket, onlineNickSet } = require('./websocket');
const {
  serverStats, startJanitor, startMatchmaker, getRoom, notifyRoomUpdate, rooms,
  loadRooms, recoverPlayingRooms, startSnapshotter, closeRoom, snapshotRooms,
} = require('./room-manager');

const DATA_DIR = process.env.STATS_DIR || path.join(__dirname, '..', 'data');
const APP_VERSION = require('./version'); // v39 版本单一事实源（health/metrics/WS pong 共用）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'flychess-admin';
// v41：后台凭证优先取 x-admin-token 头（避免 token 落在 URL/访问日志），body/query 旧方式保持兼容
// v42 后台统一门卫：鉴权失败留审计 + 计入 adminTry 限流（防在线爆破）
function adminGuard(res, req) {
  if (isAdmin(req)) return false;
  const ip = (req && req.ip) || 'unknown';
  audit.log('admin_auth_fail', ip, { via: String((req && req.url) || '').split('?')[0].slice(0, 40) });
  const g = ratelimit.guard('adminTry', ip);
  res.json(g.ok ? { ok: false, error: 'BAD_TOKEN' } : g);
  return true;
}
function isAdmin(req) {
  const h = req.headers && req.headers['x-admin-token'];
  return (h !== undefined && h === ADMIN_TOKEN)
    || ((req.body && req.body.token) === ADMIN_TOKEN)
    || ((req.query && req.query.token) === ADMIN_TOKEN);
}
const ANNOUNCE_FILE = path.join(DATA_DIR, 'announce.json');

// v14 防刷限流 + 审计日志
const ratelimit = require('./ratelimit');
const audit = require('./audit');
ratelimit.initFromEnv();
audit.init(DATA_DIR);
/** 防刷守卫：被拦则直接响应并记审计，返回 true 表示已拦截 */
function abuseGuard(res, name, nick, kind, extraDetail) {
  const g = ratelimit.guard(name, nick, kind);
  if (g.ok) return false;
  audit.log('blocked_' + name, nick, Object.assign({ rule: name, kind, error: g.error }, extraDetail || {}));
  res.json(g);
  return true;
}

// v15 账号凭证守卫：财富/社交变更操作必须出示与档案匹配的凭证（防冒名转账/盗刷）
function authGuard(res, name, nick, token) {
  const v = stats.verifySecret(nick, token);
  if (v.ok) {
    if (v.claimed) audit.log('secret_claim', nick, { via: name });
    return false;
  }
  audit.log('auth_fail', nick, { rule: name, error: v.error });
  res.json(v);
  return true;
}

const app = express();
app.set('query parser', 'simple'); // v37 扁平解析，杜绝 ?a[b]=c 原型污染面
// v37 安全响应头：nosniff 防 MIME 嗅探，DENY 防点击劫持（页面无第三方嵌入需求）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json());
app.use(require('compression')()); // v15 gzip：app.js/index.html 等静态资源体积降约 70%
app.use('/api/rooms', roomsRouter);
app.use('/api/tournament', require('./routes/tournament')); // v21 锦标赛

// v26 历届锦标赛冠军榜（按夺冠次数排序）
app.get('/api/tournament/champions', (req, res) => {
  res.json({ ok: true, list: meta.championList() });
});

// 战绩查询
const stats = require('./stats');
const meta = require('./meta');
// v20 赛季结算抽为独立模块（含赛季荣誉战报推送），便于单元测试
const season = require('./season');

app.get('/api/stats/top', (req, res) => {
  res.json({ ok: true, list: stats.topList(Number(req.query.n) || 10) });
});

// v17 多维榜单：一次返回四榜（胜率/击杀/连胜/签到）
app.get('/api/stats/boards', (req, res) => {
  const n = Math.min(Math.max(Number(req.query.n) || 10, 1), 50);
  res.json({
    ok: true,
    boards: {
      winRate: stats.topList(n),
      kills: stats.topListBy(n, 'kills'),
      streak: stats.topListBy(n, 'streak'),
      sign: stats.topListBy(n, 'sign'),
    },
  });
});

// v17 名人堂（往月赛季冠军）
app.get('/api/stats/hall', (req, res) => {
  res.json({ ok: true, hall: meta.getHall() });
});

// v18 站内信（战报中心）：对局结果离线可查，未读计数驱动红点
app.get('/api/mail', (req, res) => {
  const nick = String(req.query.nick || '').trim().slice(0, 16);
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  res.json(Object.assign({ ok: true }, meta.listMail(nick)));
});
app.post('/api/mail/read', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  res.json(meta.markMailRead(nick));
});

// ================= v23 运营触达与可观测性 =================
// 后台系统邮件：补偿/活动通知直达玩家战报中心，可选附带金币（立即发放并留审计）。
// v32 前端异常上报：玩家浏览器里的 JS 错误直达审计，后台审计页可见（每 IP 2 秒 1 条防滥用）
app.post('/api/client-error', (req, res) => {
  const msg = String((req.body && req.body.msg) || '').trim().slice(0, 200);
  if (!msg) return res.json({ ok: false, error: 'MSG_REQUIRED' }); // 参数校验在前：空请求不占限流额度
  const g = ratelimit.guard('clientError', (req && req.ip) || 'unknown');
  if (!g.ok) return res.json(g);
  const stack = String((req.body && req.body.stack) || '').slice(0, 600);
  const page = String((req.body && req.body.page) || '').slice(0, 100);
  const ua = String((req.headers && req.headers['user-agent']) || '').slice(0, 120);
  audit.log('client_error', String((req.body && req.body.nick) || '').slice(0, 16) || 'anonymous', { msg, stack, page, ua });
  res.json({ ok: true });
});

app.post('/api/admin/mail-send', (req, res) => {
  if (adminGuard(res, req)) return;
  const title = String((req.body && req.body.title) || '').trim().slice(0, 40) || '系统通知';
  const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
  const coins = Math.min(Math.max(Number(req.body && req.body.coins) || 0, 0), 1000);
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const targets = (nick && nick !== 'all') ? [nick] : stats.allNicks();
  if (!targets.length) return res.json({ ok: false, error: 'NO_TARGETS' });
  let sent = 0;
  targets.forEach((n) => {
    meta.pushMail(n, { kind: 'system', title, text, coins });
    if (coins) stats.awardCoins(n, coins);
    sent += 1;
  });
  audit.log('admin_mail_send', 'admin', { title, coins, to: nick || 'all', sent });
  res.json({ ok: true, sent, coins });
});

// 服务器运行时指标：内存/事件循环滞后/房间/玩家/回放磁盘占用（2G 小机的拨测与容量预警）
app.get('/api/admin/metrics', (req, res) => {
  if (adminGuard(res, req)) return;
  const mu = process.memoryUsage();
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const lagMs = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
    let replayBytes = 0, replayFiles = 0;
    try {
      const rp = path.join(DATA_DIR, 'replays');
      fs.readdirSync(rp).forEach((f) => { try { replayBytes += fs.statSync(path.join(rp, f)).size; replayFiles += 1; } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
    const top = stats.topList(10000);
    let playing = 0;
    for (const [, r] of rooms) { if (r.status === 'playing') playing += 1; }
    res.json({ ok: true, metrics: {
      ts: Date.now(),
      version: APP_VERSION,
      uptimeSec: Math.floor(process.uptime()),
      memory: { rssMB: Math.round(mu.rss / 1048576), heapUsedMB: Math.round(mu.heapUsed / 1048576), heapTotalMB: Math.round(mu.heapTotal / 1048576) },
      eventLoopLagMs: lagMs,
      rooms: { total: rooms.size, playing },
      players: { total: top.length },
      gamesTotal: top.reduce((s0, p) => s0 + (p.games || 0), 0),
      replays: { files: replayFiles, mb: Math.round(replayBytes / 104857.6) / 10 },
    } });
  });
});
app.get('/api/stats/player', (req, res) => {
  const nick = String(req.query.nick || '').trim();
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  res.json({ ok: true, player: stats.playerStats(nick) });
});

// 对局回放（v2.0）
const replays = require('./replays');
app.get('/api/replays', (req, res) => {
  res.json({ ok: true, list: replays.listReplays() });
});
app.get('/api/replays/:roomNo', (req, res) => {
  const rp = replays.getReplay(req.params.roomNo);
  if (!rp) return res.status(404).json({ ok: false, error: 'NO_REPLAY' });
  res.json({ ok: true, replay: rp });
});

// 静态文件：前端（public/ 提供）。v37 分级缓存：入口/SW 必须每次回源校验（保证部署即时生效），
// js/css 短缓存 10 分钟，图标类长缓存一天
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    const base = path.basename(filePath);
    if (base === 'index.html' || base === 'sw.js' || base === 'manifest.webmanifest' || base === 'board-preview.html') {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(svg|png|ico|jpg|jpeg)$/.test(base)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=600');
    }
  },
}));

// 健康检查（v15：带版本/运行时长/房间与在线规模，便于监控告警）
app.get('/health', (req, res) => {
  let roomsNow = 0, playing = 0, online = 0;
  try {
    for (const [, r] of rooms) {
      roomsNow++;
      if (r.status === 'playing') playing++;
      online += r.clients ? r.clients.size : 0;
    }
  } catch (e) { /* rooms 未就绪时忽略 */ }
  res.json({
    ok: true, version: APP_VERSION, ts: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    rooms: roomsNow, playing, online,
  });
});

// v9 服务器在线统计（大厅顶栏展示）
app.get('/api/stats/server', (req, res) => {
  res.json({ ok: true, stats: serverStats() });
});

// ================= v8 社交留存 + 后台 =================
// 赛季榜
app.get('/api/stats/season', (req, res) => {
  const season = String(req.query.season || stats.currentSeason());
  res.json({ ok: true, season, list: stats.seasonTop(season, Number(req.query.n) || 10) });
});

// 每日签到（v14 加最小间隔防脚本暴力打点；v15 需凭证，防冒名刷连签）
app.post('/api/sign', (req, res) => {
  const nick = String((req.body && req.body.nick) || req.query.nick || '').trim();
  const token = (req.body && req.body.token) || '';
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  if (authGuard(res, 'sign', nick, token)) return;
  if (abuseGuard(res, 'sign', nick)) return;
  const r = stats.sign(nick);
  if (r.signed) audit.log('sign', nick, { reward: r.reward, streak: r.streak });
  res.json(Object.assign({ ok: true }, r));
});

// 皮肤商店
app.get('/api/shop/skins', (req, res) => {
  res.json({ ok: true, skins: stats.SHOP_SKINS });
});
app.post('/api/shop/buy', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  const id = String((req.body && req.body.id) || '');
  if (authGuard(res, 'shopBuy', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'shopBuy', nick, id)) return;
  const r = stats.buySkin(nick, id);
  if (r.ok) audit.log('shop_buy', nick, { id, kind: 'skin', coins: r.coins });
  res.json(Object.assign({ ok: true }, r));
});
app.post('/api/shop/equip', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  const id = String((req.body && req.body.id) || '');
  res.json(Object.assign({ ok: true }, stats.equipSkin(nick, id)));
});
// v12 道具卡商店
app.get('/api/shop/props', (req, res) => res.json({ ok: true, props: stats.SHOP_PROPS }));
app.post('/api/shop/buy-prop', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  const id = String((req.body && req.body.id) || '');
  if (authGuard(res, 'shopBuyProp', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'shopBuyProp', nick, id)) return;
  const r = stats.buyProp(nick, id);
  if (r.ok) audit.log('shop_buy', nick, { id, kind: 'prop' });
  res.json(Object.assign({ ok: true }, r));
});

// v9 好友系统（v15：变更操作需凭证，防冒名加/删好友）
app.post('/api/friend/add', (req, res) => {
  const { nick, friend, token } = (req.body || {});
  if (!nick || !friend) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'friendAdd', nick, token)) return;
  res.json(stats.addFriend(nick, friend));
});
app.post('/api/friend/remove', (req, res) => {
  const { nick, friend, token } = (req.body || {});
  if (!nick || !friend) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'friendRemove', nick, token)) return;
  res.json(stats.removeFriend(nick, friend));
});
app.get('/api/friend/list', (req, res) => {
  const nick = String(req.query.nick || '').trim();
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  // v13 好友在线状态：online 集合来自 WS 层实时维护
  res.json({ ok: true, friends: stats.friendListWithOnline(nick, onlineNickSet()) });
});

// 公告（大厅滚动条）
function readAnnounce() {
  try { return JSON.parse(fs.readFileSync(ANNOUNCE_FILE, 'utf8')); } catch (e) { return { text: '' }; }
}
function writeAnnounce(obj) {
  try { fs.writeFileSync(ANNOUNCE_FILE, JSON.stringify(obj)); } catch (e) { /* ignore */ }
}
/** 活动 banner 轮播（P0 meta 存储，后台可配） */
app.get('/api/banners', (req, res) => res.json({ ok: true, banners: meta.listBanners() }));

app.get('/api/announce', (req, res) => res.json({ ok: true, text: readAnnounce().text || '' }));

// C2 后台管理（ADMIN_TOKEN 鉴权）
app.post('/api/admin/announce', (req, res) => {
  if (adminGuard(res, req)) return;
  const text = String(req.body.text || '').slice(0, 200);
  writeAnnounce({ text });
  audit.log('admin_announce', 'admin', { text });
  res.json({ ok: true });
});
// 活动 banner 配置（P0 meta 存储；banners:[{title,sub,color,url}], notices:string）
app.post('/api/admin/banners', (req, res) => {
  if (adminGuard(res, req)) return;
  const banners = Array.isArray(req.body.banners) ? req.body.banners.map((b) => ({
    id: String(b.id || Date.now().toString(36)),
    title: String(b.title || '').slice(0, 30),
    sub: String(b.sub || '').slice(0, 60),
    color: String(b.color || '#6a5cff').slice(0, 20),
    url: String(b.url || '').slice(0, 200),
    active: b.active !== false,
  })) : undefined;
  res.json(Object.assign({ ok: true }, meta.setBanners(banners, typeof req.body.notices === 'string' ? req.body.notices.slice(0, 200) : undefined)));
});
app.get('/api/admin/rooms', (req, res) => {
  if (adminGuard(res, req)) return;
  const list = [];
  for (const [no, r] of rooms) {
    if (req.query.active === '1' && r.status !== 'playing') continue;
    list.push({
      roomNo: no, status: r.status, ranked: !!r.ranked,
      mode: r.settings && r.settings.teamMode ? 'team' : 'solo',
      seats: r.seats.map((s) => ({ seat: s.seat, type: s.type, nick: s.nickName })),
      updatedAt: r.updatedAt,
    });
  }
  res.json({ ok: true, rooms: list });
});
app.post('/api/admin/kick', (req, res) => {
  if (adminGuard(res, req)) return;
  const room = getRoom(String(req.body.roomNo || ''));
  if (!room) return res.json({ ok: false, error: 'ROOM_NOT_FOUND' });
  const seat = Number(req.body.seat);
  if (!room.seats[seat]) return res.json({ ok: false, error: 'SEAT_INVALID' });
  room.seats[seat].type = 'empty';
  room.seats[seat].clientId = null;
  room.seats[seat].nickName = null;
  room.seats[seat].online = false;
  notifyRoomUpdate(room.roomNo);
  res.json({ ok: true });
});

// v12 每日任务
app.get('/api/daily', (req, res) => {
  const nick = String((req.query.nick || '')).slice(0, 16);
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  res.json({ ok: true, daily: stats.dailyState(nick) });
});
app.post('/api/daily/claim', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').slice(0, 16);
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  if (authGuard(res, 'dailyClaim', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'dailyClaim', nick)) return;
  const r = stats.claimDaily(nick);
  if (r.ok && !r.already) audit.log('daily_claim', nick, { coins: r.coins });
  res.json(r);
});

// v12 后台强制关房（P4 运维可控）
app.post('/api/admin/close', (req, res) => {
  if (adminGuard(res, req)) return;
  const roomNo = String((req.body && req.body.roomNo) || '');
  const ok = closeRoom(roomNo);
  if (ok) audit.log('admin_close_room', 'admin', { roomNo });
  res.json({ ok, roomNo });
});

// v12 公会系统（v15：以 nick 身份的变更操作需凭证）
app.post('/api/guild/create', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const name = String((req.body && req.body.name) || '').trim().slice(0, 16);
  if (authGuard(res, 'guildCreate', nick, (req.body && req.body.token) || '')) return;
  res.json(meta.createGuild(name, nick));
});
app.post('/api/guild/join', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const gid = String((req.body && req.body.gid) || '').trim();
  if (authGuard(res, 'guildJoin', nick, (req.body && req.body.token) || '')) return;
  res.json(meta.joinGuild(gid, nick));
});
app.post('/api/guild/leave', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const gid = String((req.body && req.body.gid) || '').trim();
  if (authGuard(res, 'guildLeave', nick, (req.body && req.body.token) || '')) return;
  res.json(meta.leaveGuild(gid, nick));
});
app.get('/api/guild/mine', (req, res) => res.json({ ok: true, guild: meta.findGuildByMember(String((req.query.nick || '')).trim().slice(0, 16)) }));
app.get('/api/guild/rank', (req, res) => res.json({ ok: true, list: meta.guildRank(20) }));
// v13 公会战周榜
app.get('/api/guild/war', (req, res) => res.json({ ok: true, list: meta.guildWarRank(20) }));

// ================= v13 社交 2.0 / 留存 / 商业化 =================

// 好友赠币（带每日限额；v14 加最小间隔 + 审计；v15 必须凭证——冒名转账是本轮要堵的头号洞）
app.post('/api/coins/transfer', (req, res) => {
  const { from, to, amount, token } = (req.body || {});
  if (!from || !to || !amount) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'transfer', from, token)) return;
  if (abuseGuard(res, 'transfer', from, '', { to, amount })) return;
  const r = stats.transferCoins(from, to, amount);
  audit.log('transfer', from, { to, amount, ok: !!r.ok, error: r.error || null });
  res.json(r);
});

// 月卡 / 季卡订阅（演示：直接激活，生产走支付回调）
app.post('/api/subscribe', (req, res) => {
  const { nick, type, token } = (req.body || {});
  if (!nick || !type) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'subscribe', nick, token)) return;
  if (abuseGuard(res, 'subscribe', nick, type)) return;
  const r = stats.subscribe(nick, type);
  if (r.ok) audit.log('subscribe', nick, { type, expire: r.sub && r.sub.expire });
  res.json(r);
});
app.get('/api/sub', (req, res) => {
  const nick = String(req.query.nick || '').trim();
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  res.json({ ok: true, sub: stats.subState(nick) });
});

// 周任务
app.get('/api/weekly', (req, res) => {
  const nick = String(req.query.nick || '').trim();
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  res.json({ ok: true, weekly: stats.weeklyState(nick) });
});
app.post('/api/weekly/claim', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'weeklyClaim', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'weeklyClaim', nick)) return;
  const r = stats.claimWeekly(nick);
  if (r.ok && !r.already) audit.log('weekly_claim', nick, { reward: r.reward || null });
  res.json(r);
});

// 订阅每日钻石发放（前端登录时调用；无订阅则 no-op）
app.post('/api/sub/grant', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'subGrant', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'subGrant', nick)) return;
  const r = stats.ensureSubGrant(nick);
  if (r.ok && r.granted) audit.log('sub_grant', nick, { diamonds: r.granted });
  res.json(r);
});

// 限时活动列表（仅进行中的）
app.get('/api/events', (req, res) => res.json({ ok: true, events: meta.listEvents(true) }));

// 激励视频/广告奖励：kind = coin（金币10）| diamond（钻石5）
// ⚠️ 演示版直接发放；接真实广告平台后需在此校验广告回执（防止刷奖励）
// v14：最小间隔 30s + 每日次数上限（coin 10 / diamond 5）；v15：必须凭证
app.post('/api/ad/reward', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const kind = String((req.body && req.body.kind) || 'coin');
  if (!nick) return res.json({ ok: false, error: 'MISSING' });
  if (authGuard(res, 'adReward', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'adReward', nick, kind)) return;
  const r = (kind === 'diamond') ? stats.awardDiamonds(nick, 5) : stats.awardCoins(nick, 10);
  audit.log('ad_reward', nick, { kind, ok: true });
  res.json({ ok: true, reward: kind === 'diamond' ? { diamonds: 5 } : { coins: 10 }, result: r, player: stats.playerStats(nick) });
});

// 后台：限时活动配置（events 数组整体覆盖）
app.post('/api/admin/events', (req, res) => {
  if (adminGuard(res, req)) return;
  const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 20).map((e) => ({
    id: String(e.id || ('E' + Date.now().toString(36))),
    title: String(e.title || '').slice(0, 30),
    type: ['lottery', 'accumulate', 'share', 'info'].includes(e.type) ? e.type : 'info',
    desc: String(e.desc || '').slice(0, 120),
    start: String(e.start || ''),
    end: String(e.end || ''),
    config: (e.config && typeof e.config === 'object') ? e.config : {},
  })) : undefined;
  res.json(Object.assign({ ok: true }, meta.setEvents(events || [])));
});

// 后台数据看板：DAU / 对局数 / 留存 / 道具消耗等运营指标
app.get('/api/admin/dashboard', (req, res) => {
  if (adminGuard(res, req)) return;
  const now = Date.now();
  const dayMs = 86400000;
  // 活跃口径：以 lastPlay 距今时长划分（DAU=24h内，WAU=7天，MAU=30天）
  const top = stats.topList(10000);
  const totalPlayers = top.length;
  let dau = 0, wau = 0, mau = 0;
  top.forEach((p) => {
    if (!p.lastPlay) return;
    const d = now - p.lastPlay;
    if (d <= dayMs) dau += 1;
    if (d <= 7 * dayMs) wau += 1;
    if (d <= 30 * dayMs) mau += 1;
  });
  const roomsList = [];
  for (const [no, r] of rooms) {
    roomsList.push({ roomNo: no, status: r.status, seats: r.seats.filter((s) => s.type !== 'empty').length });
  }
  const server = serverStats();
  res.json({
    ok: true,
    dashboard: {
      dau, wau, mau, totalPlayers,
      gamesTotal: top.reduce((s, p) => s + (p.games || 0), 0),
      killsTotal: top.reduce((s, p) => s + (p.kills || 0), 0),
      rooms: { total: roomsList.length, playing: roomsList.filter((r) => r.status === 'playing').length },
      server,
      generatedAt: now,
    },
  });
});

// ================= 支付（微信支付）脚手架 =================
// ⚠️ 真实接入需要商户号/证书/回调域名，本接口仅做能力占位并明确报错，
//    避免"假支付"造成资金风险。配置好商户信息后在此补全下单逻辑。
app.post('/api/pay/create', (req, res) => {
  const { nick, product } = (req.body || {});
  if (!nick || !product) return res.json({ ok: false, error: 'MISSING' });
  if (!process.env.WXPAY_MCHID) {
    return res.json({
      ok: false,
      error: 'PAY_NOT_CONFIGURED',
      msg: '未配置微信支付商户号（WXPAY_MCHID）。需先在微信商户平台申请商户号并在容器环境变量中配置 WXPAY_MCHID / WXPAY_API_V3_KEY / WXPAY_SERIAL / 证书后启用。',
    });
  }
  res.json({ ok: false, error: 'NOT_IMPLEMENTED', msg: '支付下单待接入（需服务端证书与回调地址）' });
});

// v12 举报（v15：举报人需凭证，防冒名诬告）
app.post('/api/report', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const target = String((req.body && req.body.target) || '').trim().slice(0, 16);
  const reason = String((req.body && req.body.reason) || '').slice(0, 80);
  if (!target) return res.json({ ok: false, error: 'TARGET_REQUIRED' });
  if (nick && authGuard(res, 'report', nick, (req.body && req.body.token) || '')) return;
  res.json(meta.addReport(nick, target, reason));
});

// v12 赛季结算（后台手动触发，给上月赛季榜前 3 发币）——v17 起复用共享结算并归档名人堂
app.post('/api/admin/season-settle', (req, res) => {
  if (adminGuard(res, req)) return;
  const cur = stats.currentSeason();
  const r = season.settleSeason(req.body.season ? String(req.body.season) : season.prevSeason(cur));
  if (r.ok) meta.setLastSettled(cur);
  res.json(r);
});

// ================= v12 PVE 闯关 / 每日残局 =================
app.get('/api/pve/levels', (req, res) => {
  const nick = String((req.query.nick || '')).trim().slice(0, 16);
  res.json({ ok: true, pve: stats.pveState(nick) });
});

app.get('/api/puzzle/today', (req, res) => {
  const nick = String((req.query.nick || '')).trim().slice(0, 16);
  res.json({ ok: true, puzzle: stats.puzzleState(nick) });
});
app.post('/api/puzzle/claim', (req, res) => {
  const nick = String((req.body && req.body.nick) || '').trim();
  const moves = (req.body && req.body.moves) || [];
  if (!nick) return res.json({ ok: false, error: 'NICK_REQUIRED' });
  if (authGuard(res, 'puzzleClaim', nick, (req.body && req.body.token) || '')) return;
  if (abuseGuard(res, 'puzzleClaim', nick)) return;
  const r = stats.puzzleClaim(nick, moves);
  if (r.ok && !r.already) audit.log('puzzle_claim', nick, { coins: r.coins });
  res.json(r);
});

// v12 举报列表（后台）
app.get('/api/admin/reports', (req, res) => {
  if (adminGuard(res, req)) return;
  res.json({ ok: true, list: meta.listReports(50) });
});

// v12 数据备份（后台一键，落 /app/data/backups/）
app.post('/api/admin/backup', (req, res) => {
  if (adminGuard(res, req)) return;
  try {
    res.json(Object.assign({ ok: true }, require('./backup').runBackup()));
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
app.get('/api/admin/backups', (req, res) => {
  if (adminGuard(res, req)) return;
  try {
    res.json({ ok: true, list: require('./backup').listBackups() });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// v14 审计日志查询（最近 n 条，新在前）
app.get('/api/admin/audit', (req, res) => {
  if (adminGuard(res, req)) return;
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 100, 1), 500);
  res.json({ ok: true, list: audit.list(n, req.query.all === '1') });
});

// v43 玩家总览：后台面板的全维度简表（按最近对局倒序，含凭证持有标记）
app.get('/api/admin/nicks', (req, res) => {
  if (adminGuard(res, req)) return;
  res.json({ ok: true, list: stats.adminNicks() });
});

// v33 凭证认领信息（老昵称被抢注时追溯用：看认领时间与历史局数，再决定是否 secret-reset）
app.get('/api/admin/secret-info', (req, res) => {
  if (adminGuard(res, req)) return;
  res.json(Object.assign({ ok: true }, stats.secretInfo(String(req.query.nick || '').trim().slice(0, 16))));
});

// v15 账号凭证重置（玩家凭证丢失找回）：清空后其下次出示即重新认领
app.post('/api/admin/secret-reset', (req, res) => {
  if (adminGuard(res, req)) return;
  const nick = String((req.body && req.body.nick) || '').trim().slice(0, 16);
  const ok = stats.resetSecret(nick);
  audit.log('admin_secret_reset', 'admin', { nick, ok });
  res.json({ ok, nick });
});

// 后台管理页面（HTML，操作需 token）
app.get('/admin', (req, res) => {
  res.type('html').send(ADMIN_HTML);
});

// ================= v33 进程级兜底 =================
// 背景：引擎层存在可抛异常的分支（如 MOVE_EXCEEDS_HOME），而这些调用点在 WS/HTTP 回调里，
// 未捕获异常会直接终止进程 → 所有进行中的房间状态丢失（容器虽有 restart 但体验断层）。
// 策略：记录 + 审计 + 继续服务；真正的退出（SIGTERM/SIGINT）先落盘再退。
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', (err && err.stack) || err);
  try { audit.log('uncaught', 'system', { msg: String((err && err.message) || err).slice(0, 200) }); } catch (e) { /* ignore */ }
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  try { audit.log('unhandled_rejection', 'system', { msg: String((reason && reason.message) || reason).slice(0, 200) }); } catch (e) { /* ignore */ }
});
/** 退出前把内存态强制落盘（stats/meta 平时是即时写，这里兜住房间快照与边缘未刷数据） */
function flushAll(reason) {
  try { stats.flush(); } catch (e) { console.error('[shutdown] stats flush failed:', e.message); }
  try { meta.flush(); } catch (e) { console.error('[shutdown] meta flush failed:', e.message); }
  try { snapshotRooms(); } catch (e) { console.error('[shutdown] rooms flush failed:', e.message); }
  console.log('[shutdown] 数据已落盘，reason=' + reason);
}
['SIGTERM', 'SIGINT'].forEach((sig) => {
  process.on(sig, () => { flushAll(sig); process.exit(0); });
});

const PORT = process.env.PORT || 3000;
// v44 API 错误面收口：未匹配的 /api 路径统一返回 JSON 404（此前是 Express 默认 HTML，前端 apiErrMsg 无法识别）
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND' });
});

// v44 统一错误兜底：/api 返回 JSON 500 不泄露堆栈，其余纯文本
app.use('/api', (err, req, res, next) => {
  console.error('[api-error]', (err && err.stack) || err);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
});
app.use((err, req, res, next) => {
  console.error('[app-error]', (err && err.stack) || err);
  if (!res.headersSent) res.status(500).type('text').send('服务器内部错误');
});

const server = http.createServer(app);
attachWebSocket(server);

server.listen(PORT, () => {
  console.log(`[flight-chess] server listening on :${PORT}`);
  startJanitor(); // v9 僵尸房定时清理
  startMatchmaker(); // v7 增强 #17：段位天梯匹配队列定时撮合
  // v8 房间持久化：scheduler 已就绪（attachWebSocket 注册），恢复磁盘房间并驱动 AI
  try { loadRooms(); } catch (e) { console.error('[rooms] load failed:', e.message); }
  try { recoverPlayingRooms(); } catch (e) { console.error('[rooms] recover failed:', e.message); }
  startSnapshotter(); // 每 10s 落盘房间快照
  // v12 P4：每天 03:00（东八区）自动备份 JSON 数据，保留最近 14 份
  try { require('./backup').scheduleDaily(); } catch (e) { console.error('[backup] schedule failed:', e.message); }
  // v23 数据卫生：启动清理一次 + 每日巡检（过期赛程/旧邮件/旧举报）
  try {
    const pruned = meta.pruneOld();
    if (pruned.tournaments || pruned.mails || pruned.reports) console.log('[meta] 数据卫生清理:', JSON.stringify(pruned));
    const _prTimer = setInterval(() => { try { meta.pruneOld(); } catch (e) { /* ignore */ } }, 24 * 3600 * 1000);
    if (_prTimer.unref) _prTimer.unref();
  } catch (e) { console.error('[meta] prune failed:', e.message); }
    // v17 赛季自动结算：启动时检查一次 + 每小时巡检（跨月自动给上月前 3 发币并归档名人堂）
  season.autoSeasonSettle('boot');
  const _seasonTimer = setInterval(() => season.autoSeasonSettle('hourly'), 3600 * 1000);
  // v20 回放存储卫生：启动清理孤儿回放文件 + 每天巡检（索引只留 50 局，被裁掉的文件不能永久占盘）
  try {
    const replaysMod = require('./replays');
    replaysMod.cleanOrphanReplays();
    const _rpTimer = setInterval(() => { try { replaysMod.cleanOrphanReplays(); } catch (e) { /* ignore */ } }, 24 * 3600 * 1000);
    if (_rpTimer.unref) _rpTimer.unref();
  } catch (e) { console.error('[replays] clean schedule failed:', e.message); }
  if (_seasonTimer.unref) _seasonTimer.unref();
});

// C2 后台管理页面（操作需 token）
const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>飞行棋 · 后台管理</title>
<style>body{font-family:-apple-system,system-ui,"Microsoft YaHei",sans-serif;background:#0f1226;color:#e6ebfa;margin:0;padding:20px} h1{font-size:20px} .card{background:#1a1f3a;padding:16px;border-radius:12px;margin-bottom:16px} input,textarea,button{font:inherit;padding:8px;border-radius:8px;border:1px solid #333a66;background:#0f1226;color:#e6ebfa} button{background:#6a5cff;cursor:pointer;border:none;margin-right:4px} table{width:100%;border-collapse:collapse} td,th{padding:6px 8px;border-bottom:1px solid #2a2f55;text-align:left} .err{color:#ff8080}</style>
</head><body>
<h1>✈️ 飞行棋后台管理</h1>
<div class="card"><label>管理令牌：</label> <input id="token" style="width:220px" placeholder="ADMIN_TOKEN"></div>
<div class="card"><h3>公告</h3><textarea id="ann" rows="2" style="width:100%"></textarea><br><button onclick="saveAnn()">发布公告</button> <span id="annMsg"></span></div>
<div class="card"><h3>房间列表</h3><button onclick="loadRooms()">刷新</button><div id="rooms"></div></div>
<div class="card"><h3>举报列表</h3><button onclick="loadReports()">刷新</button><div id="reports"></div></div>
<div class="card"><h3>数据备份</h3><button onclick="doBackup()">立即备份</button> <button onclick="loadBackups()">查看备份</button> <span id="bkMsg"></span><div id="backups"></div><p style="opacity:.6;font-size:12px">每天 03:00（东八区）自动备份，保留最近 14 份。</p></div>
<div class="card"><h3>审计日志（v14）</h3><button onclick="loadAudit()">刷新最近 100 条</button> <select id="auFilter" onchange="renderAudit()"><option value="all">全部类型</option><option value="blocked_">拦截类</option><option value="auth_fail">冒名尝试</option><option value="admin_auth_fail">后台爆破</option><option value="client_error">前端报错</option><option value="secret_claim">凭证认领</option></select> <span id="auMsg"></span><div id="audit"></div><p style="opacity:.6;font-size:12px">记录奖励发放/交易/后台操作与被防刷拦截的尝试，落 audit.jsonl（512KB 自动轮转）。</p></div>
<div class="card"><h3>系统邮件（v23）</h3>
<label>收件人 <input id="msNick" style="width:120px" placeholder="昵称，留空=全体"></label>
标题 <input id="msTitle" style="width:140px" placeholder="系统通知"> 附金币 <input id="msCoins" style="width:60px" value="0"><br>
<textarea id="msText" rows="2" style="width:100%;margin:6px 0" placeholder="正文（最多 200 字）"></textarea>
<button onclick="sendMail()">发送</button> <button onclick="loadMetrics()">服务器指标</button> <span id="msMsg"></span><div id="metricsBox"></div></div>
<div class="card"><h3>账号凭证重置（v15）</h3><input id="rsNick" style="width:180px" placeholder="玩家昵称"> <button onclick="resetSecret()">重置凭证</button> <span id="rsMsg"></span><p style="opacity:.6;font-size:12px">玩家凭证丢失（清了浏览器数据/换设备）时使用：重置后玩家下次任意财富操作即重新认领新凭证。</p></div>
<div class="card"><h3>玩家总览（v43）</h3><button onclick="loadNicks()">刷新玩家列表</button> <input id="pkNick" style="width:140px" placeholder="昵称"> <button onclick="lookupPlayer()">查询详情</button> <span id="pkMsg"></span><div id="nicks"></div><div id="pkDetail"></div></div>
<div class="card"><h3>赛季结算</h3><button onclick="settle()">给上月赛季前 3 发币</button> <span id="ssMsg"></span></div>
<script>
async function api(u,opt){const r=await fetch(u,opt);return r.json();}
function t(){return document.getElementById('token').value;}
function post(u,body){return api(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:t()},body||{}))});}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function loadAnn(){const d=await api('/api/announce');document.getElementById('ann').value=d.text||'';}
async function saveAnn(){const r=await post('/api/admin/announce',{text:document.getElementById('ann').value});document.getElementById('annMsg').textContent=r.ok?'已发布':'失败:'+(r.error||'');}
async function loadRooms(){const r=await api('/api/admin/rooms?token='+encodeURIComponent(t()));const box=document.getElementById('rooms');if(!r.ok){box.innerHTML='<p class="err">'+esc(r.error||'加载失败')+'，请确认令牌</p>';return;}const rows=r.rooms.map(x=>'<tr><td>'+x.roomNo+'</td><td>'+x.status+'</td><td>'+(x.mode||'solo')+'</td><td>'+esc(x.seats.map(s=>s.nick||s.type).join(' / '))+'</td><td><button onclick="kick(\\''+x.roomNo+'\\',0)">踢0</button> <button onclick="kick(\\''+x.roomNo+'\\',1)">踢1</button> <button onclick="kick(\\''+x.roomNo+'\\',2)">踢2</button> <button onclick="kick(\\''+x.roomNo+'\\',3)">踢3</button> <button onclick="closeRoom(\\''+x.roomNo+'\\')" style="background:#c0392b">关房</button></td></tr>').join('');box.innerHTML='<table><tr><th>房号</th><th>状态</th><th>模式</th><th>座位</th><th>操作</th></tr>'+rows+'</table>';}
async function kick(no,seat){await post('/api/admin/kick',{roomNo:no,seat});loadRooms();}
async function closeRoom(no){if(!confirm('强制关闭房间 '+no+'？'))return;await post('/api/admin/close',{roomNo:no});loadRooms();}
async function loadReports(){const r=await api('/api/admin/reports?token='+encodeURIComponent(t()));const box=document.getElementById('reports');if(!r.ok){box.innerHTML='<p class="err">'+esc(r.error||'加载失败')+'</p>';return;}if(!r.list.length){box.innerHTML='<p style="opacity:.6">暂无举报</p>';return;}box.innerHTML='<table><tr><th>被举报</th><th>累计</th><th>举报人</th><th>理由</th><th>时间</th></tr>'+r.list.map(x=>'<tr><td>'+esc(x.target)+'</td><td>'+x.totalOnTarget+'</td><td>'+esc(x.nick||'匿名')+'</td><td>'+esc(x.reason||'-')+'</td><td>'+new Date(x.at).toLocaleString('zh-CN')+'</td></tr>').join('')+'</table>';}
async function doBackup(){const r=await post('/api/admin/backup');document.getElementById('bkMsg').textContent=r.ok?('已备份 '+(r.dir||'')+'（'+((r.files||[]).length)+' 个文件）'):'失败:'+(r.error||'');loadBackups();}
async function loadBackups(){const r=await api('/api/admin/backups?token='+encodeURIComponent(t()));const box=document.getElementById('backups');if(!r.ok){box.innerHTML='<p class="err">'+esc(r.error||'加载失败')+'</p>';return;}box.innerHTML=r.list.length?('<table><tr><th>备份目录</th><th>文件数</th><th>大小</th></tr>'+r.list.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+(x.files||0)+'</td><td>'+(((x.bytes||0)/1024).toFixed(1))+' KB</td></tr>').join('')+'</table>'):'<p style="opacity:.6">暂无备份</p>';}
async function settle(){if(!confirm('给上月赛季榜前 3 发币？'))return;const r=await post('/api/admin/season-settle');document.getElementById('ssMsg').textContent=r.ok?('已结算 '+r.season+'：'+r.awarded.map(a=>a.nick+'+'+a.bonus).join('、')):'失败:'+(r.error||'');}
let _auList=[];
const KIND_NAME={ad_reward:'广告奖励',sign:'签到',transfer:'赠币',subscribe:'订阅',sub_grant:'订阅发钻',daily_claim:'日任务',weekly_claim:'周任务',puzzle_claim:'残局',shop_buy:'商城',admin_announce:'后台公告',admin_close_room:'后台关房',admin_kick:'后台踢人',admin_season_settle:'赛季结算',season_settle:'赛季结算',admin_secret_reset:'凭证重置',secret_claim:'凭证认领',auth_fail:'冒名尝试',admin_auth_fail:'后台爆破',client_error:'前端报错',blocked_nick:'冒名占号',blocked_roomCreate:'刷房拦截',blocked_roomJoin:'刷房拦截',blocked_pveStart:'刷房拦截'};
async function loadAudit(){const r=await api('/api/admin/audit?n=100&token='+encodeURIComponent(t()));const box=document.getElementById('audit');if(!r.ok){box.innerHTML='<p class="err">'+esc(r.error||'加载失败')+'</p>';return;}_auList=r.list||[];renderAudit();}
function renderAudit(){const box=document.getElementById('audit');if(!_auList.length){box.innerHTML='<p style="opacity:.6">暂无记录</p>';return;}const f=document.getElementById('auFilter').value;const list=_auList.filter(x=>f==='all'||(f==='blocked_'?x.kind.indexOf('blocked_')===0:x.kind===f));const agg={};_auList.forEach(x=>{if(x.kind==='client_error'){const m=(x.detail&&x.detail.msg)||'?';agg[m]=(agg[m]||0)+1;}});let aggHtml='';const msgs=Object.keys(agg);if(msgs.length){aggHtml='<p style="opacity:.85;font-size:12px"><b>前端报错聚合：</b><br>'+msgs.map(m=>esc(m)+' × '+agg[m]).join('<br>')+'</p>';}const rows=list.map(x=>'<tr><td>'+new Date(x.at).toLocaleString('zh-CN')+'</td><td>'+(x.kind.indexOf('blocked_')===0?'<span class="err">拦截·'+esc(KIND_NAME[x.kind.slice(8)]||x.kind.slice(8))+'</span>':((x.kind==='auth_fail'||x.kind==='admin_auth_fail')?'<span class="err">'+esc(KIND_NAME[x.kind]||x.kind)+'</span>':esc(KIND_NAME[x.kind]||x.kind)))+'</td><td>'+esc(x.nick)+'</td><td style="opacity:.75">'+esc(JSON.stringify(x.detail)).slice(0,160)+'</td></tr>').join('');box.innerHTML=aggHtml+'<table><tr><th>时间</th><th>类型</th><th>用户</th><th>详情</th></tr>'+rows+'</table>';}
async function sendMail(){const body={title:document.getElementById('msTitle').value,text:document.getElementById('msText').value,coins:Number(document.getElementById('msCoins').value)||0};const n=document.getElementById('msNick').value.trim();if(n)body.nick=n;const r=await post('/api/admin/mail-send',body);document.getElementById('msMsg').textContent=r.ok?('已发送 '+r.sent+' 人'+(r.coins?'（每人 +'+r.coins+' 金币）':'')):'失败:'+(r.error||'');}
async function loadMetrics(){const r=await api('/api/admin/metrics?token='+encodeURIComponent(t()));const box=document.getElementById('metricsBox');if(!r.ok){box.innerHTML='<p class="err">'+esc(r.error||'加载失败')+'</p>';return;}const m=r.metrics;box.innerHTML='<table><tr><th>内存 RSS</th><th>堆使用</th><th>事件循环滞后</th><th>房间(进行中)</th><th>玩家</th><th>总局数</th><th>回放</th></tr><tr><td>'+m.memory.rssMB+'MB</td><td>'+m.memory.heapUsedMB+'MB</td><td>'+m.eventLoopLagMs+'ms</td><td>'+m.rooms.total+'('+m.rooms.playing+')</td><td>'+m.players.total+'</td><td>'+m.gamesTotal+'</td><td>'+m.replays.files+' 个 / '+m.replays.mb+'MB</td></tr></table>';}
async function resetSecret(){const nick=document.getElementById('rsNick').value.trim();if(!nick){document.getElementById('rsMsg').textContent='请输入昵称';return;}const r=await post('/api/admin/secret-reset',{nick});document.getElementById('rsMsg').textContent=r.ok?'已重置（玩家下次操作重新认领）':'失败:'+(r.error||'');}
async function loadNicks(){
  const r = await api('/api/admin/nicks?token=' + encodeURIComponent(t()));
  const box = document.getElementById('nicks');
  if (!r.ok) { box.innerHTML = '<p class="err">' + esc(r.error || '加载失败') + '，请确认令牌</p>'; return; }
  if (!r.list.length) { box.innerHTML = '<p style="opacity:.6">暂无玩家</p>'; return; }
  box.innerHTML = '<table><tr><th>昵称</th><th>局数</th><th>胜</th><th>胜率</th><th>金币</th><th>最近对局</th><th>凭证</th></tr>' + r.list.map(function (p) {
    return '<tr><td><a href="#" onclick="lookupPlayer(\\'' + encodeURIComponent(p.nick) + '\\');return false">' + esc(p.nick) + '</a></td><td>' + p.games + '</td><td>' + p.wins + '</td><td>' + (p.games ? Math.round(p.wins / p.games * 100) + '%' : '-') + '</td><td>' + p.coins + '</td><td>' + (p.lastPlay ? new Date(p.lastPlay).toLocaleString('zh-CN') : '-') + '</td><td>' + (p.hasSecret ? '✓' : '<span class="err">✗</span>') + '</td></tr>';
  }).join('') + '</table>';
}
async function lookupPlayer(nick) {
  if (nick) document.getElementById('pkNick').value = decodeURIComponent(nick);
  nick = document.getElementById('pkNick').value.trim();
  const msg = document.getElementById('pkMsg');
  if (!nick) { msg.textContent = '请输入昵称'; return; }
  msg.textContent = '';
  const r = await api('/api/stats/player?nick=' + encodeURIComponent(nick));
  const box = document.getElementById('pkDetail');
  if (!r.ok || !r.player) { box.innerHTML = '<p class="err">无档案</p>'; return; }
  const p = r.player;
  box.innerHTML = '<table><tr><th>局数</th><th>胜</th><th>胜率</th><th>击落</th><th>被击落</th><th>最佳连胜</th><th>金币</th><th>连签</th><th>成就</th></tr><tr><td>' + p.games + '</td><td>' + p.wins + '</td><td>' + (p.winRate || 0) + '%</td><td>' + p.kills + '</td><td>' + p.beenKilled + '</td><td>' + p.bestStreak + '</td><td>' + p.coins + '</td><td>' + (p.signStreak || 0) + '</td><td>' + ((p.achievements || []).length) + '</td></tr></table>'
    + '<button onclick="useForReset()">填入凭证重置</button> <button onclick="useForMail()">填入邮件收件人</button>';
}
function useForReset(){document.getElementById('rsNick').value = document.getElementById('pkNick').value; resetSecret();}
function useForMail(){document.getElementById('msNick').value = document.getElementById('pkNick').value; document.getElementById('msMsg').textContent = '已填入收件人';}
loadAnn();loadRooms();
</script></body></html>`;
