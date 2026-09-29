/**
 * tests/integration.js — HTTP + WebSocket 端到端联调
 *
 * 模拟：1 真人（seat0 房主）+ 3 AI（seat1/2/3）
 * 自动跑完整局，验证房间创建→加入→开局→实时推送→AI托管→分出胜负 全链路。
 */

const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const { choosePlane } = require('../server/src/game-engine/ai');

const BASE = 'http://127.0.0.1:3000';
const WS_BASE = 'ws://127.0.0.1:3000';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 1. 健康检查
  const health = await req('GET', '/health');
  if (!health.body.ok) throw new Error('server not healthy');
  console.log('[1] health ok');

  // 2. 创建房间
  const created = await req('POST', '/api/rooms', { password: '', settings: { aiLevel: 2 } });
  const roomNo = created.body.roomNo;
  const hostClientId = created.body.hostClientId;
  console.log(`[2] created room ${roomNo}, host seat0 clientId=${hostClientId}`);

  // 3. 加入 3 个真人占位（随后转 AI，模拟"3 个好友没来，改用电脑"）
  // v16 起加入有按 IP 的 300ms 防洪间隔，模拟真实用户点击节奏
  const clients = [hostClientId];
  for (let i = 1; i <= 3; i++) {
    const cid = 'client' + i;
    await new Promise((r) => setTimeout(r, 350));
    const j = await req('POST', `/api/rooms/${roomNo}/join`, { password: '', clientId: cid, nickName: 'P' + i });
    if (!j.body.ok) throw new Error('join failed: ' + j.body.error);
    clients.push(cid);
    console.log(`[3.${i}] joined seat ${j.body.seat} as ${cid}`);
  }

  // 4. 房主把 seat1/2/3 设为 AI（模拟 1 真人 + 3 AI）
  for (let s = 1; s <= 3; s++) {
    const r = await req('POST', `/api/rooms/${roomNo}/seat`, { seat: s, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
    if (!r.body.ok) throw new Error('set_ai failed: ' + r.body.error);
  }
  console.log('[4] seat1/2/3 -> AI');

  // 5. 开局
  const st = await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });
  if (!st.body.ok) throw new Error('start failed: ' + st.body.error);
  console.log('[5] game started');

  // 6. WebSocket 连接真人（seat0），自动响应 roll/select
  const ws = new WebSocket(`${WS_BASE}/ws?roomNo=${roomNo}&seat=0&clientId=${hostClientId}`);
  let lastGame = null;
  let finished = false;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') {
      lastGame = msg.data.game;
      const g = lastGame;
      if (!g || g.phase === 'ended') return;
      if (g.currentSeat !== 0) return; // 等 AI
      if (g.phase === 'rolling') {
        ws.send(JSON.stringify({ type: 'roll' }));
      } else if (g.phase === 'selecting') {
        const pid = choosePlane(g, 0, g.dice, 2);
        if (pid != null) ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
      }
    } else if (msg.type === 'game_over') {
      finished = true;
      console.log(`[6] GAME OVER winner=seat ${msg.data.winner}, ranking=${msg.data.ranking}`);
      ws.close();
    }
  });

  // 超时保护
  const timeout = setTimeout(() => {
    console.error('[timeout] game did not finish in 60s');
    ws.close();
    process.exit(1);
  }, 60000);

  ws.on('open', () => console.log('[6] ws connected as human seat0'));
  ws.on('close', () => {
    clearTimeout(timeout);
    if (finished) { console.log('[done] integration test PASSED'); process.exit(0); }
    else { console.error('[done] closed before finish'); process.exit(1); }
  });
  ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
}

main().catch((e) => { console.error('INTEGRATION FAILED:', e.message); process.exit(1); });
