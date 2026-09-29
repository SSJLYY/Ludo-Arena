/**
 * test-pwd-lock.js — v27 房间密码防爆破 + 观战上限 专项测试
 *
 * 自起实例（SPECTATOR_MAX=3）：
 *   1. 带密码建房 → 错密码 5 次 → PWD_LOCKED（429），锁定中继续错密码仍被拦
 *   2. 正确密码本人可进入（并清零计数）
 *   3. 观战上限：并发保持 3 个观战连接时，第 4 个被 4029 拒绝
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3464;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 建立观战连接并保持打开（返回 {ws, opened, closeCode}） */
function wsJoin(roomNo, clientId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=-1&clientId=${clientId}`);
    const box = { ws, opened: false, closeCode: null };
    ws.on('open', () => { box.opened = true; resolve(box); });
    ws.on('close', (code) => { box.closeCode = code; if (!box.opened) resolve(box); });
    ws.on('error', () => { if (!box.opened) resolve(box); });
    setTimeout(() => resolve(box), 4000);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-pwd-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: Object.assign({}, process.env, {
      PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN: 'test-token',
      SPECTATOR_MAX: '3',
      ABUSE_CONFIG: JSON.stringify({ roomJoin: { minIntervalMs: 10 }, roomCreate: { minIntervalMs: 10 } }),
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

    const c = await req('POST', '/api/rooms', { password: '654321', nickName: '锁匠' });
    const roomNo = c.body.roomNo;
    ok(!!roomNo, '带密码建房成功');

    console.log('[1] 密码爆破锁定');
    let sawWrong = 0, sawLocked = false, lockedRepeat = false;
    for (let i = 1; i <= 6; i++) {
      const r = await req('POST', `/api/rooms/${roomNo}/join`, { password: 'wrong-' + i, clientId: 'brute' + i });
      if (r.body.error === 'WRONG_PASSWORD') sawWrong++;
      if (r.body.error === 'PWD_LOCKED') { sawLocked = true; lockedRepeat = true; }
      await sleep(30);
    }
    ok(sawWrong >= 4, '前几次报 WRONG_PASSWORD（' + sawWrong + ' 次）');
    ok(sawLocked, '连续错误触发 PWD_LOCKED');

    // 锁定期间继续错密码仍被拦（爆破无法继续）
    const again = await req('POST', `/api/rooms/${roomNo}/join`, { password: 'wrong-again', clientId: 'brute-more' });
    ok(again.body.error === 'PWD_LOCKED', '锁定期间继续爆破仍被拦');

    // 正密码本人可进（清零计数）——语义：密码对=不是爆破
    await sleep(60); // 越过加入最小间隔
    const right = await req('POST', `/api/rooms/${roomNo}/join`, { password: '654321', clientId: 'owner-self', nickName: '锁匠' });
    ok(right.body.ok === true && right.body.seat === 1, '正密码本人正常进入（seat 1）');

    console.log('[2] 观战上限（SPECTATOR_MAX=3）');
    const created3 = await req('POST', '/api/rooms', { nickName: '围观房主', token: 'zz' });
    const rn3 = created3.body.roomNo;
    const socks = [];
    for (let i = 1; i <= 4; i++) {
      socks.push(await wsJoin(rn3, 'spec-' + i));
      await sleep(80);
    }
    // WS 协议 open 事件先于服务端 close，判定以 closeCode 为准
    const kept = socks.filter((b) => b.opened && b.closeCode === null).length;
    const limited = socks.filter((b) => b.closeCode === 4029).length;
    ok(kept === 3, '前 3 个观战者保持连接（实测 ' + kept + '）');
    ok(limited === 1, '第 4 个观战者被 4029 拒绝（上限生效）');
    socks.forEach((b) => { try { b.ws.close(); } catch (e) { /* ignore */ } });

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('PWD LOCK TEST FAILED:', e); process.exit(1); });
