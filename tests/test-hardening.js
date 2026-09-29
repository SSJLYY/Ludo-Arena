/**
 * test-hardening.js — v37 加固专项测试
 *
 * 覆盖：
 *   1. 安全响应头：X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy
 *   2. 静态资源缓存分级：index.html 与 sw.js no-cache，css/js max-age=600，图标 max-age=86400
 *   3. index.html 含 OG 分享 meta
 *   4. query parser simple：括号查询串不再产生嵌套对象，服务正常响应
 *   5. WS maxPayload：>64KB 巨帧触发传输层 1009 断连；正常小帧连接保持
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3465;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_TOKEN = 'test-token';
const SERVER_DIR = path.join(__dirname, '..', 'server');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

/** 返回 { headers, body }，body 仅在 JSON 响应时解析成功 */
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(buf || '{}'); } catch (e) { parsed = { __raw: buf }; }
        resolve({ headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-hard-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STATS_DIR: dataDir,
      ADMIN_TOKEN,
      AI_STEP_DELAY: '20',
      WS_IP_MAX: '8', // v42 测试用小上限
      ABUSE_CONFIG: JSON.stringify({ adminTry: { minIntervalMs: 100, dailyMax: 2 } }),
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

    console.log('[1] 安全响应头');
    const h = await req('GET', '/health');
    ok(h.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    ok(h.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY（防点击劫持）');
    ok(h.headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy 收敛');
    ok(String(h.headers['permissions-policy'] || '').includes('camera=()'), 'Permissions-Policy 关闭摄像头/麦克风/定位');

    console.log('[2] 静态资源缓存分级');
    const html = await req('GET', '/index.html');
    ok(String(html.headers['cache-control'] || '').includes('no-cache'), 'index.html no-cache（部署即时生效）');
    const sw = await req('GET', '/sw.js');
    ok(String(sw.headers['cache-control'] || '').includes('no-cache'), 'sw.js no-cache（SW 更新检查不被缓存卡住）');
    const css = await req('GET', '/css/style.css');
    ok(/max-age=600/.test(String(css.headers['cache-control'] || '')), 'css/js 短缓存 max-age=600');
    const icon = await req('GET', '/icon.svg');
    ok(/max-age=86400/.test(String(icon.headers['cache-control'] || '')), '图标类长缓存 max-age=86400');

    console.log('[2b] PWA PNG 图标（v41）');
    const png = await req('GET', '/icon-192.png');
    ok(String(png.headers['content-type'] || '').includes('image/png'), 'icon-192.png 以 image/png 提供');
    const png512 = await req('GET', '/icon-512.png');
    ok(png512.body.__raw && png512.body.__raw.length > 1000 && String(png512.body.__raw.slice(1, 4)) === 'PNG', 'icon-512.png 是合法 PNG');
    const ati = await req('GET', '/apple-touch-icon.png');
    ok(ati.body.__raw && String(ati.body.__raw.slice(1, 4)) === 'PNG', 'apple-touch-icon.png 存在（iOS 主屏图标）');
    const mf = await req('GET', '/manifest.webmanifest');
    const mfTxt = JSON.stringify(mf.body);
    ok(mfTxt.includes('icon-512.png') && mfTxt.includes('maskable'), 'manifest 含 PNG 与 maskable 图标');

    console.log('[2c] admin 凭证 header 通道（v41）');
    const ah = await new Promise((resolve, reject) => {
      const r = http.request(BASE + '/api/admin/audit?n=1', { method: 'GET', headers: { 'x-admin-token': ADMIN_TOKEN } }, (res) => {
        let buf = ''; res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(JSON.parse(buf || '{}')));
      });
      r.on('error', reject); r.end();
    });
    ok(ah.ok === true, 'x-admin-token 头通过鉴权');
    const aq = await req('GET', '/api/admin/audit?n=1&token=' + ADMIN_TOKEN);
    ok(aq.body.ok === true, '旧 query token 方式保持兼容');

    console.log('[2d] API 错误面（v44）');
    const nf = await req('GET', '/api/notexist');
    ok(nf.body.ok === false && nf.body.error === 'NOT_FOUND', '/api 未匹配路径返回 JSON 404 NOT_FOUND');

    console.log('[3] 分享 meta');
    ok(String((html.body && html.body.__raw) || '').includes('og:title'), 'index.html 含 OG 分享 meta');

    console.log('[4] query parser simple');
    const qb = await req('GET', '/api/stats/boards?n=1&x[y]=2');
    ok(qb.body.ok === true && Array.isArray(qb.body.boards && qb.body.boards.winRate),
      '括号查询串按扁平键处理，接口正常返回');
    const html2 = await req('GET', '/index.html?a[b]=c');
    ok((html2.body && html2.body.__raw || '').includes('<!DOCTYPE'), '静态路径带括号查询串不受影响');

    console.log('[5] WS maxPayload 传输层兜底');
    // 观战者连接：只需房间存在即可入座（seat=-1），不校验 clientId
    const room = await req('POST', '/api/rooms', { nickName: 'hard-' + Math.random().toString(36).slice(2) });
    ok(room.body.ok === true && room.body.roomNo, '建房成功（WS 测试前置）');
    const roomNo = room.body.roomNo;
    const closeCode = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=-1`);
      ws.on('open', () => ws.send('x'.repeat(200 * 1024)));
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => { /* 1009 前可能先报 error，等 close */ });
    });
    ok(closeCode === 1009, '200KB 巨帧触发 1009 Message Too Big 断连（实际 ' + closeCode + '）');
    // 服务端在巨帧攻击后必须存活
    await sleep(300);
    ok((await req('GET', '/health')).body.ok === true, '巨帧攻击后服务存活（无 uncaughtException 污染）');
    const alive = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=-1`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'noop' })));
      ws.on('close', () => resolve(false));
      ws.on('error', () => { /* ignore */ });
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 600);
    });
    ok(alive, '正常小帧连接保持不断');

    console.log('[6] 心跳 heartbeat→pong + 版本握手（v38/v41）');
    const pong = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=-1`);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'heartbeat' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'pong') resolve(m.data && typeof m.data.ts === 'number' ? m.data.v || null : '__bad__');
      });
      ws.on('error', () => resolve(null));
      setTimeout(() => resolve(null), 2500);
    });
    ok(pong && pong !== '__bad__', '客户端 heartbeat 得到带 ts 的 pong 回复');
    ok(pong === 'v44', 'pong 携带服务端版本号 v44（实际 ' + pong + '）');

    console.log('[7] admin 防爆破（v42）');
    for (let i = 0; i < 2; i++) {
      const bad = await req('GET', '/api/admin/audit?n=1&token=wrong-' + i);
      ok(bad.body.ok === false && bad.body.error === 'BAD_TOKEN', '错误 token 返回 BAD_TOKEN（第 ' + (i + 1) + ' 次）');
      await sleep(150); // 越过 minIntervalMs
    }
    const bad3 = await req('GET', '/api/admin/audit?n=1&token=wrong-3');
    ok(bad3.body.ok === false && (bad3.body.error === 'DAILY_LIMIT' || bad3.body.error === 'RATE_LIMITED'), '第 3 次错误 token 被限流（' + bad3.body.error + '）');
    const au2 = await req('GET', '/api/admin/audit?n=30&token=' + ADMIN_TOKEN);
    ok((au2.body.list || []).some((x) => x.kind === 'admin_auth_fail'), '审计含 admin_auth_fail 留痕');

    console.log('[8] WS 单 IP 连接上限（v42）');
    const sockets = [];
    const codes = [];
    // 被拒连接会先触发 open（握手已完成）再收 4008 close，open 后留宽限期等 close 再定性
    await new Promise((resolve) => {
      let settled = 0;
      const done = () => { if (++settled >= 12) resolve(); };
      for (let i = 0; i < 12; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${roomNo}&seat=-1`);
        sockets.push(ws);
        ws.on('close', (c) => { codes.push(c); done(); });
        ws.on('open', () => setTimeout(() => done(), 900));
        ws.on('error', () => { /* close 事件会跟 */ });
      }
      setTimeout(resolve, 9000);
    });
    const rejected = codes.filter((c) => c === 4008).length;
    ok(rejected >= 1 && rejected <= 6, '超出上限的连接被 4008 拒绝（拒绝 ' + rejected + ' 个，含前段遗留连接）');
    sockets.forEach((ws) => { try { ws.close(); } catch (e) { /* ignore */ } });
    await sleep(300);
    ok((await req('GET', '/health')).body.ok === true, '连接洪水测试后服务存活');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('HARDENING TEST FAILED:', e); process.exit(1); });
