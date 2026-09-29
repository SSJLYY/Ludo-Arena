/* test-seat.js — 验证「设电脑」后服务端会向房间 WS 客户端广播房间更新 */
const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:3000';
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const created = await req('POST', '/api/rooms', { settings: { aiLevel: 2 }, nickName: '房主' });
  const roomNo = created.roomNo;
  const clientId = created.hostClientId;
  if (!roomNo || !clientId) { console.error('创建房间失败', JSON.stringify(created)); process.exit(1); }
  console.log('[1] 房间', roomNo, 'clientId', clientId);

  const ws = new WebSocket('ws://localhost:3000/ws?roomNo=' + roomNo + '&seat=0&clientId=' + clientId);
  let broadcasted = false;

  ws.on('open', async () => {
    console.log('[2] WS 连接成功');
    await new Promise((r) => setTimeout(r, 300));
    const r = await req('POST', '/api/rooms/' + roomNo + '/seat', { seat: 1, action: 'set_ai', requesterSeat: 0 });
    console.log('[3] 设电脑响应', JSON.stringify(r));
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.type === 'state') {
      const seat1 = msg.data.room.seats[1].type;
      console.log('[4] 收到 state 推送，seat1.type =', seat1);
      if (seat1 === 'ai') {
        broadcasted = true;
        console.log('=== SEAT BROADCAST PASS ===');
        ws.close();
        process.exit(0);
      }
    }
  });

  setTimeout(() => {
    console.error(broadcasted ? '已更新但未捕获到 ai 状态' : 'TIMEOUT：设电脑后未收到房间广播（修复失败）');
    process.exit(3);
  }, 8000);
})();
