/**
 * test-leave-host.js — v33「对局中主动离开不再卡死回合」回归测试
 *
 * 场景：1 真人（seat0）+ 3 AI 开局，真人在对局进行中发送 leave。
 * 修复前：leaveRoom 把座位设成 empty，switchPlayer 不跳过空座 → 轮到该座无人行动，整局永久卡死。
 * 修复后：playing 状态下离座与掉线同口径转 AI 托管，AI 继续接管，对局能推进到结束。
 *
 * 依赖：本机 3000 端口已启动服务（AI_STEP_DELAY 建议设小，跑得快）
 * 运行：node tests/test-leave-host.js
 */

const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const { choosePlane } = require('../server/src/game-engine/ai');

const BASE = 'http://127.0.0.1:3000';
const WS_BASE = 'ws://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✅ ' + name); } else { fail += 1; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
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

async function main() {
  const health = await req('GET', '/health');
  if (!health.body.ok) throw new Error('server not healthy (3000)');

  const nick = 'leavehost' + Math.floor(Math.random() * 100000);
  const created = await req('POST', '/api/rooms', { password: '', settings: { aiLevel: 2 }, nickName: nick, token: 'lh-token' });
  const roomNo = created.body.roomNo;
  const hostClientId = created.body.hostClientId;
  ok('建房成功', !!roomNo, JSON.stringify(created.body));

  for (let i = 1; i <= 3; i++) {
    await sleep(350); // 按 IP 300ms 防洪间隔
    await req('POST', `/api/rooms/${roomNo}/join`, { password: '', clientId: 'lh-c' + i, nickName: 'P' + i });
    await req('POST', `/api/rooms/${roomNo}/seat`, { seat: i, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
  }
  const st = await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });
  ok('开局成功', st.body.ok === true, JSON.stringify(st.body));

  const ws = new WebSocket(`${WS_BASE}/ws?roomNo=${roomNo}&seat=0&clientId=${hostClientId}`);
  let lastRoom = null, lastGame = null, gameOver = false;
  let seatSeq = [];       // leave 之后观察到的 currentSeat 序列
  let left = false;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') {
      lastRoom = msg.data.room; lastGame = msg.data.game;
      const g = lastGame;
      if (left && g) seatSeq.push(g.currentSeat);
      if (g && g.phase === 'rolling' && g.currentSeat === 0) {
        ws.send(JSON.stringify({ type: 'roll' }));
      } else if (g && g.phase === 'selecting' && g.currentSeat === 0) {
        const pid = choosePlane(g, 0, g.dice, 2);
        if (pid != null) ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
      }
    } else if (msg.type === 'game_over') {
      gameOver = true;
    }
  });

  await new Promise((resolve) => ws.on('open', resolve));
  await sleep(1500); // 让对局跑起来

  ok('对局已开始', !!lastGame && (lastGame.phase === 'rolling' || lastGame.phase === 'selecting'),
    lastGame ? lastGame.phase : 'no game');

  // 发送 leave：修复前会把座位置空导致整局卡死；修复后转 AI 托管继续推进
  ws.send(JSON.stringify({ type: 'leave' }));
  left = true;
  await sleep(800);

  ok('离座后座位转 AI 托管', lastRoom && lastRoom.seats[0].type === 'ai',
    lastRoom ? lastRoom.seats[0].type : 'no room');
  ok('昵称保留（战绩不丢）', lastRoom && String(lastRoom.seats[0].nickName || '').indexOf(nick) === 0,
    lastRoom ? String(lastRoom.seats[0].nickName) : '');

  await sleep(2500);
  const rotated = new Set(seatSeq).size >= 2; // 座位发生轮转 = 托管 AI 真的在落子
  ok('离座后对局仍在推进（未卡死）', rotated || gameOver,
    'seatSeq=' + JSON.stringify(seatSeq.slice(0, 12)) + ' over=' + gameOver);
  ok('离座玩家不再被当作真人等待操作', !!lastGame
    && (lastGame.phase === 'ended' || lastGame.currentSeat !== 0 || new Set(seatSeq).size >= 2),
    'phase=' + (lastGame && lastGame.phase));

  try { ws.close(); } catch (e) { /* ignore */ }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
