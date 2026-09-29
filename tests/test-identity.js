/**
 * test-identity.js — v15 账号凭证（防冒名）+ health/gzip 专项测试
 *
 * 自起独立服务实例（随机端口 + 临时数据目录），预置一个无凭证的"老玩家"档案
 * 模拟存量数据迁移。覆盖：
 *   1. 新玩家首次财富操作凭 token 认领；无 token → AUTH_REQUIRED
 *   2. 已认领后：错 token → AUTH_FAILED；无 token → AUTH_FAILED；对 token → 通过
 *   3. 存量老玩家（档案无 secret）首次操作平滑认领
 *   4. 建房出示 token 认领（createIfMissing 路径）
 *   5. 冒名转账被拒且余额无损；admin 重置凭证后可重新认领
 *   6. playerStats/topList 不泄露 secret 字段
 *   7. /health 带 version/uptime；静态资源 gzip 生效
 *   8. 审计含 auth_fail
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3458;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_TOKEN = 'test-token';
const SERVER_DIR = path.join(__dirname, '..', 'server');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    const r = http.request(BASE + p, { method, headers: h }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ headers: res.headers, body: JSON.parse(buf || '{}') }); }
        catch (e) { resolve({ headers: res.headers, body: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-id-'));
  // 预置存量玩家（无 secret 字段）——模拟 v15 上线前的真实数据
  fs.writeFileSync(path.join(dataDir, 'stats.json'), JSON.stringify({
    players: {
      '老玩家': {
        nick: '老玩家', games: 3, wins: 1, kills: 5, beenKilled: 2, lastPlay: Date.now(),
        streak: 0, bestStreak: 1, sixes: 3, bestKills: 2, achievements: [],
        coins: 100, signDate: '', signStreak: 0, skins: ['classic'], equipped: 'classic', props: [],
        diamonds: 0, sub: null, subGrantDate: '', weekly: null, transferDate: '', transferToday: 0,
      },
    },
    games: [], friendships: {},
  }));

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STATS_DIR: dataDir,
      ADMIN_TOKEN,
      // 本测试验证的是身份凭证，限流间隔调到毫秒级避免干扰断言节奏
      ABUSE_CONFIG: JSON.stringify({ sign: { minIntervalMs: 10 }, transfer: { minIntervalMs: 10 }, adReward: { minIntervalMs: 10 } }),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await req('GET', '/health')).body.ok; } catch (e) { /* not yet */ }
    }
    ok(up, '测试服务实例启动');

    console.log('[1] 新玩家认领与校验');
    const T1 = 'tok-' + Math.random().toString(36).slice(2);
    const noTok = await req('POST', '/api/sign', { nick: '新人甲' });
    ok(noTok.body.ok === false && noTok.body.error === 'AUTH_REQUIRED', '无 token 首次操作 → AUTH_REQUIRED（不认领）');
    const s1 = await req('POST', '/api/sign', { nick: '新人甲', token: T1 });
    ok(s1.body.ok === true && s1.body.signed === true, '出示 token 首次操作 → 认领并成功');
    const s2 = await req('POST', '/api/sign', { nick: '新人甲' });
    ok(s2.body.ok === false && s2.body.error === 'AUTH_FAILED', '认领后无 token → AUTH_FAILED');
    const s3 = await req('POST', '/api/sign', { nick: '新人甲', token: 'wrong' });
    ok(s3.body.ok === false && s3.body.error === 'AUTH_FAILED', '认领后错 token → AUTH_FAILED');
    await sleep(60); // 越过 10ms 最小间隔（本测试不测限流，只测身份）
    const s4 = await req('POST', '/api/sign', { nick: '新人甲', token: T1 });
    ok(s4.body.ok === true, '认领后对 token → 通过');

    console.log('[2] 存量老玩家平滑迁移');
    const TA = 'old-' + Math.random().toString(36).slice(2);
    const tb = await req('POST', '/api/ad/reward', { nick: '老玩家', kind: 'coin', token: TA });
    ok(tb.body.ok === true, '老玩家首次操作即认领（金币 +10）');
    const ps = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('老玩家'));
    ok(ps.body.player && ps.body.player.coins === 110, '老玩家金币 100 → 110（' + ps.body.player.coins + '）');
    const tr = await req('POST', '/api/coins/transfer', { from: '老玩家', to: '新人甲', amount: 10, token: TA });
    ok(tr.body.ok === true, '老玩家凭凭证转账成功');
    const trBad = await req('POST', '/api/coins/transfer', { from: '老玩家', to: '新人甲', amount: 10, token: 'hacker' });
    ok(trBad.body.ok === false && trBad.body.error === 'AUTH_FAILED', '冒名凭证转账被拒');
    const ps2 = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('老玩家'));
    ok(ps2.body.player.coins === 100, '被拒后余额无损（100）');

    console.log('[3] 建房认领 + admin 重置');
    const TC = 'host-' + Math.random().toString(36).slice(2);
    const created = await req('POST', '/api/rooms', { password: '', nickName: '建房者', token: TC });
    ok(created.body.ok === true && created.body.roomNo, '建房成功（' + created.body.roomNo + '）');
    const ad = await req('POST', '/api/ad/reward', { nick: '建房者', kind: 'coin', token: TC });
    ok(ad.body.ok === true, '建房认领的凭证可直接用于财富操作');
    const adBad = await req('POST', '/api/ad/reward', { nick: '建房者', kind: 'coin', token: 'other' });
    ok(adBad.body.ok === false && adBad.body.error === 'AUTH_FAILED', '建房者档案对错 token 拒绝');
    const reset = await req('POST', '/api/admin/secret-reset', { token: ADMIN_TOKEN, nick: '老玩家' });
    ok(reset.body.ok === true, 'admin 凭证重置成功');
    const TC2 = 'new-' + Math.random().toString(36).slice(2);
    const re = await req('POST', '/api/coins/transfer', { from: '老玩家', to: '新人甲', amount: 5, token: TC2 });
    ok(re.body.ok === true, '重置后新凭证可重新认领并操作');
    const resetBad = await req('POST', '/api/admin/secret-reset', { token: 'bad', nick: '老玩家' });
    ok(resetBad.body.ok === false && resetBad.body.error === 'BAD_TOKEN', '重置接口 token 鉴权');

    console.log('[4] 信息泄露与基础设施');
    const leak = await req('GET', '/api/stats/player?nick=' + encodeURIComponent('老玩家'));
    ok(!('secret' in (leak.body.player || {})), 'playerStats 不含 secret 字段');
    const top = await req('GET', '/api/stats/top?n=10');
    ok(top.body.list.every((p) => !('secret' in p)), '排行榜不含 secret 字段');
    const health = await req('GET', '/health');
    ok(health.body.ok === true && health.body.version === 'v44' && typeof health.body.uptimeSec === 'number' && typeof health.body.rooms === 'number',
      '/health 带 version/uptimeSec/rooms');
    const gz = await req('GET', '/js/app.js', null, { 'Accept-Encoding': 'gzip' });
    ok(String(gz.headers['content-encoding'] || '') === 'gzip', 'app.js 已 gzip 压缩（' + (gz.headers['content-length'] || '?') + ' bytes）');
    const au = await req('GET', '/api/admin/audit?token=' + ADMIN_TOKEN + '&n=50');
    const kinds = new Set(au.body.list.map((x) => x.kind));
    ok(kinds.has('auth_fail') && kinds.has('secret_claim'), '审计含 auth_fail 与 secret_claim 留痕');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('IDENTITY TEST FAILED:', e); process.exit(1); });
