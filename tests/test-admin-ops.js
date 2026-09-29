/**
 * test-admin-ops.js — v23 运营触达与可观测性 专项测试
 *
 * A. 单元（进程内）：meta.pruneOld 数据卫生（过期赛程/旧邮件/旧举报清理，30/90 天阈值）
 * B. E2E（自起实例）：admin 系统邮件（个人/全体/附金币/鉴权）+ /api/admin/metrics 指标
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unit() {
  console.log('[A] 数据卫生单元');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-prune-'));
  process.env.STATS_DIR = dataDir;
  const meta = require(path.join(__dirname, '..', 'server', 'src', 'meta'));
  const now = Date.now();
  const day = 86400000;
  // 构造：新旧混杂数据
  meta.pushMail('老玩家', { kind: 'game', rank: 1 });
  meta.setTournament('老玩家', { nick: '老玩家', stage: 'done', updatedAt: now - 40 * day });
  meta.setTournament('进行中', { nick: '进行中', stage: 'semi', updatedAt: now - 40 * day });
  // 旧邮件：pushMail 的 entry 可覆盖默认 at 时间戳
  meta.pushMail('老玩家', { kind: 'game', rank: 2, at: now - 100 * day });

  const removed = meta.pruneOld(now);
  ok(removed.tournaments === 1, '完成态 40 天锦标赛被清理（进行中保留）');
  ok(meta.getTournament('进行中') !== null, '进行中锦标赛不受影响');
  ok(meta.getTournament('老玩家') === null, '完成态锦标赛已删除');
  const after = meta.listMail('老玩家');
  ok(after.list.length === 1 && after.list[0].kind === 'game', '100 天前旧邮件被清理、新邮件保留');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function req(BASE, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      // v43 /admin 返回 HTML，非 JSON 时原样返回字符串
      res.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve(buf); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function e2e() {
  console.log('[B] E2E：系统邮件与指标');
  const PORT = 3463;
  const BASE = 'http://127.0.0.1:' + PORT;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-ops-'));
  const SERVER_DIR = path.join(__dirname, '..', 'server');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, { PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN: 'test-token' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await req(BASE, 'GET', '/health')).ok; } catch (e) { /* not yet */ }
    }
    ok(up, '测试服务实例启动');

    // 先造两个有档案的玩家（签到即可建档）
    await req(BASE, 'POST', '/api/sign', { nick: '阿一', token: 't1' });
    await sleep(100);
    await req(BASE, 'POST', '/api/sign', { nick: '阿二', token: 't2' });

    // 个人邮件 + 附金币
    const bad = await req(BASE, 'POST', '/api/admin/mail-send', { token: 'wrong', nick: '阿一', title: 'x' });
    ok(bad.ok === false && bad.error === 'BAD_TOKEN', '邮件发送 token 鉴权');
    const single = await req(BASE, 'POST', '/api/admin/mail-send', { token: 'test-token', nick: '阿一', title: '补偿发放', text: '服务器波动补偿', coins: 50 });
    ok(single.ok === true && single.sent === 1 && single.coins === 50, '个人系统邮件发送成功');
    const p1 = await req(BASE, 'GET', '/api/stats/player?nick=' + encodeURIComponent('阿一'));
    ok(p1.player.coins === 60, '附金币到账（10 签到 + 50 = 60）');
    const m1 = await req(BASE, 'GET', '/api/mail?nick=' + encodeURIComponent('阿一'));
    const sys1 = (m1.list || []).find((m) => m.kind === 'system');
    ok(!!sys1 && sys1.title === '补偿发放' && sys1.coins === 50, '战报中心收到系统邮件（含金币标注）');

    // 全体邮件
    const all = await req(BASE, 'POST', '/api/admin/mail-send', { token: 'test-token', title: '周末双倍', text: '活动通知' });
    ok(all.ok === true && all.sent >= 2, '全体邮件送达所有玩家（' + all.sent + ' 人）');
    const m2 = await req(BASE, 'GET', '/api/mail?nick=' + encodeURIComponent('阿二'));
    ok((m2.list || []).some((m) => m.kind === 'system' && m.title === '周末双倍'), '阿二收到全体邮件');

    // 指标
    await sleep(600); // v42 adminTry 最小间隔 500ms，越过再试错 token
    const mbad = await req(BASE, 'GET', '/api/admin/metrics?token=wrong');
    ok(mbad.ok === false && mbad.error === 'BAD_TOKEN', '指标接口 token 鉴权');
    const mt = await req(BASE, 'GET', '/api/admin/metrics?token=test-token');
    const M = mt.metrics || {};
    ok(!!M.version && typeof M.eventLoopLagMs === 'number' && M.memory && typeof M.memory.rssMB === 'number',
      '指标含版本/内存/事件循环滞后（滞后 ' + M.eventLoopLagMs + 'ms / RSS ' + (M.memory || {}).rssMB + 'MB）');
    ok(M.rooms && typeof M.rooms.total === 'number' && M.players && M.replays && typeof M.replays.files === 'number',
      '指标含房间/玩家/回放磁盘占用');

    // v43 玩家总览接口 + 后台页新面板
    await sleep(600); // 越过上一条错 token 的 adminTry 最小间隔
    const nicksBad = await req(BASE, 'GET', '/api/admin/nicks?token=wrong');
    ok(nicksBad.ok === false && nicksBad.error === 'BAD_TOKEN', '玩家总览接口 token 鉴权');
    await sleep(600); // 越过 adminTry 最小间隔
    const nicks = await req(BASE, 'GET', '/api/admin/nicks?token=test-token');
    ok(nicks.ok === true && Array.isArray(nicks.list),
      '玩家总览接口返回列表（' + (nicks.list || []).length + ' 人）');
    ok((nicks.list || []).every((p) => typeof p.nick === 'string' && typeof p.games === 'number' && typeof p.hasSecret === 'boolean' && !('secret' in p)),
      '玩家总览含 nick/games/hasSecret 且不泄露 secret');
    const page = await req(BASE, 'GET', '/admin');
    ok(String(page || '').includes('loadNicks') && String(page || '').includes('renderAudit'),
      '后台页含玩家总览与审计过滤面板');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

unit();
e2e().then(() => {
  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error('ADMIN OPS TEST FAILED:', e); process.exit(1); });
