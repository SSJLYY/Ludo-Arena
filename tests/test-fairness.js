/**
 * test-fairness.js — v16 昵称占用保护 + 房间防洪水 + 观战实时推送 专项测试
 *
 * 自起独立服务实例。覆盖：
 *   1. 已认领昵称：错凭证建房 → NICK_TAKEN；对凭证 → 通过；冒名进他人房间 → NICK_TAKEN
 *   2. 未占用昵称：无凭证放行（旧客户端兼容）；有凭证顺手认领
 *   3. 房间创建按 IP 频率限制（连续建房第二次 RATE_LIMITED）
 *   4. 观战者加入 → 房内玩家实时收到 spectatorCount 变化的 state
 *   5. 审计含 blocked_nick
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3459;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_TOKEN = 'test-token';
const SERVER_DIR = path.join(__dirname, '..', 'server');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`);
    const box = { ws, states: 0, lastRoom: null };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') { box.states++; box.lastRoom = msg.data.room; }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(box));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-fair-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STATS_DIR: dataDir,
      ADMIN_TOKEN,
      ABUSE_CONFIG: JSON.stringify({ roomCreate: { minIntervalMs: 400 }, roomJoin: { minIntervalMs: 100 } }),
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

    console.log('[1] 昵称占用保护');
    const TA = 'owner-' + Math.random().toString(36).slice(2);
    const c1 = await req('POST', '/api/rooms', { nickName: '大明星', token: TA });
    ok(c1.body.ok === true, '「大明星」首次建房并认领昵称');
    await sleep(500);
    const c2 = await req('POST', '/api/rooms', { nickName: '大明星', token: 'hacker-token' });
    ok(c2.status === 400 && c2.body.error === 'NICK_TAKEN', '错凭证冒名建房 → 400 NICK_TAKEN');
    await sleep(500);
    const c3 = await req('POST', '/api/rooms', { nickName: '大明星', token: TA });
    ok(c3.body.ok === true, '本人凭证建房 → 通过');
    await sleep(500);
    const c4 = await req('POST', '/api/rooms', { nickName: '路人' });
    ok(c4.body.ok === true, '未占用昵称无凭证建房 → 放行（旧客户端兼容）');
    await sleep(500); // 越过建房最小间隔
    const c5 = await req('POST', '/api/rooms', { nickName: '新秀', token: 'tb-' + Math.random().toString(36).slice(2) });
    ok(c5.body.ok === true, '未占用昵称有凭证建房 → 放行并认领');
    // 冒名加入 c3 的房间
    const j1 = await req('POST', `/api/rooms/${c3.body.roomNo}/join`, { clientId: 'evil1', nickName: '大明星', token: 'hacker-token' });
    ok(j1.status === 400 && j1.body.error === 'NICK_TAKEN', '错凭证冒名进房 → 400 NICK_TAKEN');
    await sleep(150); // 越过加入最小间隔
    const j2 = await req('POST', `/api/rooms/${c3.body.roomNo}/join`, { clientId: 'good1', nickName: '大明星', token: TA });
    ok(j2.body.ok === true && j2.body.seat === 1, '本人凭证进房 → 通过（seat 1）');
    // 默认昵称不参与占用
    await sleep(150);
    const j3 = await req('POST', `/api/rooms/${c3.body.roomNo}/join`, { clientId: 'guest1' });
    ok(j3.body.ok === true, '默认昵称（不传 nickName）不受占用校验限制');

    console.log('[2] 房间防洪水（按 IP）');
    await sleep(500);
    const f1 = await req('POST', '/api/rooms', { nickName: '洪水侠' });
    ok(f1.body.ok === true, '间隔后首次建房正常');
    const f2 = await req('POST', '/api/rooms', { nickName: '洪水侠2' });
    ok(f2.status === 429 && f2.body.error === 'RATE_LIMITED', '连续建房立即 429 RATE_LIMITED');
    ok(f2.body.retryAfter > 0, '限流响应带 retryAfter');

    console.log('[3] 观战人数实时推送');
    const spec = await wsConnect(`roomNo=${c3.body.roomNo}&seat=-1&clientId=spec-f1`);
    const before = spec.states;
    await sleep(1200); // 观战延迟 2.5s 内看不到自己的 state 也收不到新广播——等待一次广播窗口
    const host = await wsConnect(`roomNo=${c3.body.roomNo}&seat=0&clientId=${c3.body.hostClientId}`);
    const hostStatesBefore = host.states;
    const spec2 = await wsConnect(`roomNo=${c3.body.roomNo}&seat=-1&clientId=spec-f2`);
    await sleep(3200); // 等待延迟下发：房主应收到观战人数 +1 的广播
    const withTwo = host.lastRoom && Array.isArray(host.lastRoom.spectators) ? host.lastRoom.spectators.length : 0;
    ok(host.states > hostStatesBefore, '观战加入触发实时 state 广播');
    ok(withTwo >= 2, '房主视角观战人数 ≥ 2（实测 ' + withTwo + '）');
    // v35 观战者昵称编号区分
    const names = (host.lastRoom.spectators || []).map((sp) => sp.nickName);
    ok(new Set(names).size === names.length && names.every((n) => n.startsWith('观战者')), '观战者昵称自动编号且不重名（' + names.join('/') + '）');
    spec.ws.close(); spec2.ws.close(); host.ws.close();

    console.log('[4] 审计');
    const au = await req('GET', '/api/admin/audit?token=' + ADMIN_TOKEN + '&n=50');
    const kinds = new Set(au.body.list.map((x) => x.kind));
    ok(kinds.has('blocked_nick'), '审计含 blocked_nick 留痕');
    ok(kinds.has('blocked_roomCreate'), '审计含房间防洪水拦截留痕');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('FAIRNESS TEST FAILED:', e); process.exit(1); });
