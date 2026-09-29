/**
 * load-test.js — v27 服务器容量实测
 *
 * 用法：node tests/load-test.js [并发观战数=30] [持续秒数=45] [服务器=http://129.211.29.228]
 *
 * 场景：创建 1 间 AI 对局房（AI_STEP_DELAY 由服务器环境决定），
 * N 个模拟客户端以观战身份接入 WS 接收全部对局广播，
 * 同时 M 个轮询器以 2s 间隔刷大厅列表/排行榜（读放大模拟）。
 * 输出：消息吞吐、单客户端延迟统计、服务器内存与事件循环滞后（需 ADMIN_TOKEN）。
 *
 * ⚠️ 对生产服务器请用小并发（≤50），测试完自动关闭测试房。
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const N = parseInt(process.argv[2], 10) || 30;
const DURATION = parseInt(process.argv[3], 10) || 45;
const HOST = process.argv[4] || 'http://129.211.29.228';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'flychess-admin'; // 服务器改过令牌时须 export ADMIN_TOKEN
const WS_BASE = HOST.replace('http', 'ws');
const POLLERS = Math.max(2, Math.round(N / 10));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(HOST + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        const t1 = Date.now();
        try { resolve({ body: JSON.parse(buf || '{}'), t1 }); } catch (e) { resolve({ body: {}, t1 }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`[load] 目标 ${HOST} ｜ 观战客户端 ${N} ｜ 轮询器 ${POLLERS} ｜ 时长 ${DURATION}s`);

  // 1. 建一桌 4 AI 对局
  const created = await req('POST', '/api/rooms', { nickName: '负载测试', settings: { aiLevel: 2, turnSeconds: 15 } });
  if (!created.body.ok) { console.error('建房间失败:', created.body.error); process.exit(1); }
  const roomNo = created.body.roomNo;
  const hostClientId = created.body.hostClientId;
  for (let s = 1; s <= 3; s++) {
    await req('POST', `/api/rooms/${roomNo}/seat`, { seat: s, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
  }
  await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });
  console.log(`[load] 对局房 ${roomNo} 已开局`);

  // 2. N 个 WS 观战客户端
  let connected = 0, msgs = 0, latencies = [];
  const clients = [];
  for (let i = 0; i < N; i++) {
    await new Promise((resolve) => {
      const ws = new WebSocket(`${WS_BASE}/ws?roomNo=${roomNo}&seat=-1&clientId=load-${i}`);
      let lastAt = Date.now();
      ws.on('open', () => { connected++; resolve(); });
      ws.on('message', () => { msgs++; latencies.push(Date.now() - lastAt); lastAt = Date.now(); });
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
      clients.push(ws);
      setTimeout(resolve, 3000);
    });
  }
  console.log(`[load] ${connected}/${N} 客户端已接入，采样 ${DURATION}s …`);

  // 3. 读轮询器
  let polls = 0;
  const pollerTimer = setInterval(async () => {
    for (let p = 0; p < POLLERS; p++) {
      req('GET', p % 2 ? '/api/stats/top?n=10' : '/api/rooms/list').then(() => polls++);
      await sleep(50);
    }
  }, 2000);

  const t0 = Date.now();
  await sleep(DURATION * 1000);
  clearInterval(pollerTimer);
  const elapsed = (Date.now() - t0) / 1000;

  // 4. 服务器指标
  let metrics = null;
  try {
    const m = await req('GET', '/api/admin/metrics?token=' + ADMIN_TOKEN);
    metrics = m.body.metrics;
  } catch (e) { /* 本地无 token 时跳过 */ }

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies.length ? latencies[Math.floor(latencies.length * p)] : 0;
  console.log('\n========== 容量报告 ==========');
  console.log(`WS 客户端在线:      ${connected}/${N}`);
  console.log(`广播消息总接收:     ${msgs}  (${Math.round(msgs / elapsed)}/s)`);
  console.log(`HTTP 轮询完成:      ${polls}  (${Math.round(polls / elapsed)}/s)`);
  if (latencies.length) {
    console.log(`广播间隔 p50/p95/max: ${pct(0.5)}ms / ${pct(0.95)}ms / ${latencies[latencies.length - 1]}ms`);
  }
  if (metrics) {
    console.log(`服务器内存 RSS:     ${metrics.memory.rssMB}MB (堆 ${metrics.memory.heapUsedMB}MB)`);
    console.log(`事件循环滞后:       ${metrics.eventLoopLagMs}ms`);
    console.log(`房间/玩家/总局数:   ${metrics.rooms.total}(${metrics.rooms.playing} 进行) / ${metrics.players.total} / ${metrics.gamesTotal}`);
    console.log(`回放磁盘:           ${metrics.replays.files} 个 / ${metrics.replays.mb}MB`);
  }
  console.log('==============================');
  const healthy = connected >= N * 0.9 && (!metrics || metrics.eventLoopLagMs < 50);
  console.log(healthy ? '✅ 容量评估：该并发下服务健康' : '⚠️ 容量评估：接近或超过建议负载');

  // 5. 清理：观战退出 + 关测试房
  clients.forEach((ws) => { try { ws.close(); } catch (e) {} });
  await req('POST', '/api/admin/close', { token: ADMIN_TOKEN, roomNo });
  console.log('[load] 测试房已关闭');
  process.exit(0);
}

main().catch((e) => { console.error('LOAD TEST FAILED:', e); process.exit(1); });
