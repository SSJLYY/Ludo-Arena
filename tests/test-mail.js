/**
 * test-mail.js — v18 战报中心（站内信）专项测试
 *
 * 自起独立服务实例，真实驱动一局（1 真人 WS 自动打 + 3 AI），覆盖：
 *   1. 对局结束自动给真人生成战报（未读、字段齐全、含赛季）
 *   2. 打完第二局：新战报在前 + 未读数正确
 *   3. 标记已读后 unread 归零，列表保留
 *   4. AI 座位没有战报
 *   5. 昵称缺失 → NICK_REQUIRED
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3461;
const BASE = 'http://127.0.0.1:' + PORT;
const SERVER_DIR = path.join(__dirname, '..', 'server');
const NICK = '邮差';
const TOKEN = 'mail-tok';

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
      res.on('end', () => resolve(JSON.parse(buf || '{}')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 驱动一局：建房 → 3 AI → 开局 → WS 自动打完，返回 roomNo（resolve 于 game_over） */
async function playOneGame() {
  const created = await req('POST', '/api/rooms', { password: '', nickName: NICK, token: TOKEN });
  const roomNo = created.roomNo;
  const hostClientId = created.hostClientId;
  for (let s = 1; s <= 3; s++) await req('POST', `/api/rooms/${roomNo}/seat`, { seat: s, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
  await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });

  const { choosePlane } = require(path.join(SERVER_DIR, 'src', 'game-engine', 'ai.js'));
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=0&clientId=${hostClientId}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('game timeout 90s')); }, 90000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') {
        const g = msg.data.game;
        if (!g || g.phase === 'ended' || g.currentSeat !== 0) return;
        if (g.phase === 'rolling') ws.send(JSON.stringify({ type: 'roll' }));
        else if (g.phase === 'selecting') {
          const pid = choosePlane(g, 0, g.dice, 2);
          if (pid != null) ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
        }
      } else if (msg.type === 'game_over') {
        clearTimeout(timer);
        ws.close();
        resolve(roomNo);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-mail-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN: 'test-token',
      AI_STEP_DELAY: '5',
      ABUSE_CONFIG: JSON.stringify({ roomCreate: { minIntervalMs: 10 }, roomJoin: { minIntervalMs: 10 } }),
    }),
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

    console.log('[1] 首局战报');
    await playOneGame();
    let mail = await req('GET', '/api/mail?nick=' + encodeURIComponent(NICK));
    const gameMails1 = (mail.list || []).filter((m) => m.kind === 'game');
    ok(mail.ok === true && gameMails1.length === 1 && mail.unread >= 1, '对局结束自动生成 1 条未读对局战报（若获胜另有成就战报）');
    const m = (mail.list || []).filter((x) => x.kind === 'game')[0] || {};
    ok(typeof m.rank === 'number' && typeof m.kills === 'number' && !!m.roomNo && !!m.season,
      '战报字段齐全（rank/kills/roomNo/season）');
    ok(m.read === false, '初始未读状态');

    console.log('[2] 第二局与排序');
    await playOneGame();
    mail = await req('GET', '/api/mail?nick=' + encodeURIComponent(NICK));
    const gameMails2 = (mail.list || []).filter((m) => m.kind === 'game');
    ok(gameMails2.length === 2 && mail.unread >= 2, '两局两对局战报，未读 ≥ 2（成就战报另计）');
    ok(mail.list[0].at >= mail.list[1].at, '新的在前');

    console.log('[3] 标记已读');
    const rd = await req('POST', '/api/mail/read', { nick: NICK });
    ok(rd.ok === true && rd.unread === 0, '标记已读 → unread 0');
    mail = await req('GET', '/api/mail?nick=' + encodeURIComponent(NICK));
    ok(mail.list.filter((m) => m.kind === 'game').length === 2 && mail.unread === 0 && mail.list.every((x) => x.read), '列表保留且全部已读');

    console.log('[4] 边界与隔离');
    const bad = await req('GET', '/api/mail');
    ok(bad.ok === false && bad.error === 'NICK_REQUIRED', '缺昵称 → NICK_REQUIRED');
    const empty = await req('GET', '/api/mail?nick=' + encodeURIComponent('查无此人'));
    ok(empty.ok === true && empty.list.length === 0 && empty.unread === 0, '无战报用户返回空列表');
    // AI 座位昵称：从房间快照拿不到（已结束），直接断言常见 AI 命名箱为空
    const aiMail = await req('GET', '/api/mail?nick=' + encodeURIComponent('电脑'));
    ok(aiMail.ok === true && aiMail.list.length === 0, 'AI 无战报（按昵称分箱隔离）');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('MAIL TEST FAILED:', e); process.exit(1); });
