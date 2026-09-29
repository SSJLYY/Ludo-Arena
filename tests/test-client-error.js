/**
 * test-client-error.js — v32 前端异常上报 专项测试
 *
 * 自起实例：
 *   1. 合法上报 → ok，审计出现 client_error（msg/stack/page/ua 透传）
 *   2. 缺 msg → MSG_REQUIRED
 *   3. 限流：2 秒内连发 → RATE_LIMITED（每 IP 500ms 间隔）
 *   4. admin 审计接口可见
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3467;
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
    const r = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'cerr-test' } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(JSON.parse(buf || '{}')));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-cerr-'));
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

    const r1 = await req('POST', '/api/client-error', { msg: 'TypeError: cannot read undefined', stack: 'at app.js:1', page: '/' });
    ok(r1.ok === true, '合法上报成功');
    const noMsg = await req('POST', '/api/client-error', {});
    ok(noMsg.ok === false && noMsg.error === 'MSG_REQUIRED', '缺 msg → MSG_REQUIRED');
    const r2 = await req('POST', '/api/client-error', { msg: '第二条错误' });
    ok(r2.ok === false && r2.error === 'RATE_LIMITED', '2 秒内连发被限流（防滥用）');
    await sleep(700);
    const r3 = await req('POST', '/api/client-error', { msg: '间隔后正常', nick: '报错侠' });
    ok(r3.ok === true, '越过后正常上报（带昵称）');

    const au = await req('GET', '/api/admin/audit?token=test-token&n=50');
    const ce = (au.list || []).filter((x) => x.kind === 'client_error');
    ok(ce.length >= 2, '审计含 client_error 记录（' + ce.length + ' 条）');
    const first = ce.find((x) => x.detail && x.detail.msg && x.detail.msg.includes('TypeError'));
    ok(!!first && first.detail.page === '/' && !!first.detail.ua, 'msg/stack/page/ua 详情完整');

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('CLIENT ERROR TEST FAILED:', e); process.exit(1); });
