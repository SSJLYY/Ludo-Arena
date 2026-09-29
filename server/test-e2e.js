/**
 * test-e2e.js — 云端端到端联调测试
 * 流程：建房间 → 座位1/2/3设AI → 开局 → WS连接房主 → 自动陪跑人类回合 → 直到 game_over
 * 验证：HTTP房间API / WS鉴权 / 实时广播 / AI自动推进 / 人类roll+select / 整局正常结束
 * 退出码：0 通过 / 1 异常 / 2 超时 / 3 结果非法 / 4 WS错误
 */

const http = require('http');
const WebSocket = require('ws');
const { choosePlane } = require('./src/game-engine/ai');

// 端口可用 E2E_PORT 覆盖，方便本地起 3999 冒烟而不撞正式 3000
const E2E_PORT = process.env.E2E_PORT || 3000;
const BASE = `http://127.0.0.1:${E2E_PORT}`;
const WS_BASE = `ws://127.0.0.1:${E2E_PORT}`;
const HUMAN_SEAT = 0;
const HUMAN_LEVEL = 2;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // 1) 创建房间
  const created = await req('POST', '/api/rooms', { settings: { aiLevel: HUMAN_LEVEL }, nickName: '云测房主' });
  if (!created.body.ok) throw new Error('创建房间失败: ' + JSON.stringify(created.body));
  const roomNo = created.body.roomNo;
  const hostClientId = created.body.hostClientId;
  console.log('[1] 创建房间', roomNo, 'host=' + hostClientId);

  // 2) 座位 1/2/3 设为 AI
  for (let s = 1; s <= 3; s++) {
    const r = await req('POST', `/api/rooms/${roomNo}/seat`, { seat: s, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
    if (!r.body.ok) throw new Error('set_ai 座位' + s + ' 失败: ' + r.body.error);
  }
  console.log('[2] 座位1-3 已设为AI');

  // 3) 开局（1人类+3AI 组合）
  const st = await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });
  if (!st.body.ok) throw new Error('开局失败: ' + st.body.error);
  console.log('[3] 对局已开始 (1人类+3AI)');

  // 4) WS 以房主身份接入
  const ws = new WebSocket(`${WS_BASE}/ws?roomNo=${roomNo}&seat=${HUMAN_SEAT}&clientId=${hostClientId}`);
  let done = false;
  const timeout = setTimeout(() => {
    if (!done) { console.error('[X] 超时：180s 内未结束'); process.exit(2); }
  }, 180000);

  ws.on('open', () => console.log('[4] WS 已连接'));
  let lastState = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'state') {
      const g = msg.data.game;
      if (!g) return;
      lastState = msg.data;
      if (g.phase === 'ended') return;
      if (g.currentSeat === HUMAN_SEAT) {
        if (g.phase === 'rolling') {
          ws.send(JSON.stringify({ type: 'roll' }));
        } else if (g.phase === 'selecting') {
          const pid = choosePlane(g, HUMAN_SEAT, g.dice, HUMAN_LEVEL);
          if (pid != null) ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
        }
      }
    } else if (msg.type === 'game_over') {
      done = true; clearTimeout(timeout);
      const { winner, ranking } = msg.data;
      console.log('[5] 对局结束 winner=' + winner + ' ranking=' + JSON.stringify(ranking));
      // 规则：第一个 4 机到齐者获胜，对局立即结束，故 ranking 仅含获胜者 1 人
      const w = lastState && lastState.game ? lastState.game.players[winner] : null;
      const winnerFinished = w ? w.finishedCount : -1;
      if (winner == null || !Array.isArray(ranking) || ranking.length < 1 || ranking[0] !== winner) {
        console.error('[X] 结果非法(ranking)'); process.exit(3);
      }
      if (winnerFinished !== 4) {
        console.error('[X] 获胜方未 4 机到齐: finishedCount=' + winnerFinished); process.exit(3);
      }
      console.log('[6] 获胜方 finishedCount=' + winnerFinished + ' (4机到齐 ✓)');
      console.log('=== E2E PASS ===');
      ws.close();
      process.exit(0);
    } else if (msg.type === 'error') {
      console.error('[server error]', JSON.stringify(msg.data));
    }
  });
  ws.on('error', (e) => { console.error('[X] WS 错误', e.message); process.exit(4); });
})().catch((e) => { console.error('[X] E2E FAIL', e); process.exit(1); });
