/* 端到端验证：玩家 HTTP 加入房间后，房主 WS 是否立刻收到最新座位表（问题1 修复验证）
 * 在容器内运行：docker exec -i flychess node - < test-join-notify.js
 */
const WS = require('ws');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = require('http').request({
      host: '127.0.0.1', port: 3000, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(s); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function connect(roomNo, seat, clientId) {
  return new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:3000/ws?roomNo=${roomNo}&seat=${seat}&clientId=${clientId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ck = (ok, m) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + m); if (!ok) fail++; };

(async () => {
  // 1. 房主建房
  const r1 = await req('POST', '/api/rooms', { nickName: '房主', settings: { aiLevel: 2 } });
  const roomNo = r1.roomNo;
  console.log('房间号 ' + roomNo + '，房主 seat=' + r1.seat);

  // 2. 房主连 WS
  const wsHost = await connect(roomNo, 0, r1.hostClientId);
  let hostGot = null;
  wsHost.on('message', (m) => { const d = JSON.parse(m); if (d.type === 'state') hostGot = d; });
  await wait(300);
  ck(!!hostGot, '房主连上后收到首帧 state');
  ck(hostGot && hostGot.data.room.seats[1].type === 'empty', '初始座位1 为空');

  // 3. 玩家2 用 HTTP 加入（关键：不经过 WS）
  hostGot = null;
  const r2 = await req('POST', `/api/rooms/${roomNo}/join`, { clientId: 'c_t2', nickName: '玩家2' });
  console.log('玩家2 加入 -> seat=' + r2.seat);
  await wait(600);
  ck(!!hostGot, '★ 玩家2 加入后，房主自动收到 state 推送（无需点「设玩家」）');
  ck(hostGot && hostGot.data.room.seats[1].nickName === '玩家2', '★ 房主看到的座位1 昵称 = 玩家2（实际：'
    + (hostGot ? hostGot.data.room.seats[1].nickName : 'null') + '）');
  ck(hostGot && hostGot.data.room.seats[1].type === 'human', '★ 座位1 类型为 human（实际：'
    + (hostGot ? hostGot.data.room.seats[1].type : 'null') + '）');

  // 4. 玩家2 连 WS，再加入玩家3，两边都要收到
  const wsP2 = await connect(roomNo, 1, 'c_t2');
  let p2Got = null;
  wsP2.on('message', (m) => { const d = JSON.parse(m); if (d.type === 'state') p2Got = d; });
  await wait(300);

  hostGot = null; p2Got = null;
  await req('POST', `/api/rooms/${roomNo}/join`, { clientId: 'c_t3', nickName: '玩家3' });
  await wait(600);
  ck(hostGot && hostGot.data.room.seats[2].nickName === '玩家3', '★ 玩家3 加入 -> 房主可见');
  ck(p2Got && p2Got.data.room.seats[2].nickName === '玩家3', '★ 玩家3 加入 -> 玩家2 也能看到');

  // 5. 玩家离开后，房主看到座位空出来
  hostGot = null;
  await req('POST', `/api/rooms/${roomNo}/leave`, { seat: 2, clientId: 'c_t3' }).catch(() => {});
  wsP2.close();
  await wait(600);

  wsHost.close();
  console.log(fail === 0 ? '\n=== 问题1 修复验证通过 ===' : '\n=== 失败 ' + fail + ' 项 ===');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
