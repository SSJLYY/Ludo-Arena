/**
 * test-social.js — v30 好友上线提醒 专项测试
 *
 * 自起实例：两玩家互加好友 → B 保持 notify WS 在线 → A 上线 → B 收到 friend_online 推送。
 * 反向验证：未加好友的第三人上线 → 不收到提醒。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3466;
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
      res.on('end', () => resolve(JSON.parse(buf || '{}')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 建立 notify 连接并收集后续消息（resolve 于服务端确认 joined） */
function notifyBox(nick, clientId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=__notify__&clientId=${clientId}&nick=${encodeURIComponent(nick)}`);
    const box = { ws, joined: false, onlineEvents: [] };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'notify') { box.joined = true; resolve(box); }
      if (msg.type === 'friend_online') box.onlineEvents.push(msg.data && msg.data.nick);
    });
    ws.on('error', () => resolve(box));
    setTimeout(() => resolve(box), 4000);
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-social-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: Object.assign({}, process.env, { PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN: 'test-token' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await req('GET', '/health')).ok; } catch (e) { /* not yet */ }
    }
    ok(up, '测试服务实例启动');

    // 建档 + 互加好友
    await req('POST', '/api/sign', { nick: '阿A', token: 'a-tok' });
    await req('POST', '/api/sign', { nick: '阿B', token: 'b-tok' });
    await req('POST', '/api/friend/add', { nick: '阿A', friend: '阿B', token: 'a-tok' });
    await req('POST', '/api/friend/add', { nick: '阿B', friend: '阿A', token: 'b-tok' });
    await req('POST', '/api/sign', { nick: '路人C', token: 'c-tok' });

    // B 保持 notify 在线（A 的好友）
    const boxB = await notifyBox('阿B', 'nb-1');
    ok(boxB.joined, '阿B notify 通道建立');
    // 路人C 也监听（不应收到阿A上线提醒——C 没加 A）
    const boxC = await notifyBox('路人C', 'nc-1');
    ok(boxC.joined, '路人C notify 通道建立');

    // A 上线 → B 应收到提醒，C 不应收到
    const boxA = await notifyBox('阿A', 'na-1');
    await sleep(800);

    ok(boxB.onlineEvents.includes('阿A'), '好友上线提醒送达（阿B 收到 阿A）');
    ok(!boxC.onlineEvents.includes('阿A'), '非好友不推送（路人C 未收到）');

    // A 短暂下线再上线 → B 再次收到
    boxA.ws.close();
    await sleep(500);
    const boxA2 = await notifyBox('阿A', 'na-2');
    await sleep(800);
    ok(boxB.onlineEvents.filter((n) => n === '阿A').length >= 2, '重连后再次提醒');

    boxA2.ws.close(); boxB.ws.close(); boxC.ws.close();

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('SOCIAL TEST FAILED:', e); process.exit(1); });
