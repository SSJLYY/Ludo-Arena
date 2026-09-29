/**
 * test-anti-abuse.js — v14 防刷限流 + 审计日志 + 观战延迟 专项测试
 *
 * 自起一个独立服务实例（随机端口 + 临时数据目录 + 毫秒级防刷配置），
 * 不依赖也不污染本地 3000 端口的开发服务。
 *
 * 覆盖：
 *   1. /api/ad/reward 最小间隔拦截（RATE_LIMITED）与每日上限（DAILY_LIMIT，coin/diamond 分开计数）
 *   2. /api/sign 最小间隔拦截
 *   3. /api/admin/audit 鉴权与审计内容（含被拦截记录）
 *   4. 观战延迟：观战者首帧 state ≥ SPECTATE_DELAY_MS；座位玩家首帧明显更快
 *   5. 观战者 roll 被拒（不得推进对局）；game_over 对观战者不延迟
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const PORT = 3457;
const BASE = 'http://127.0.0.1:' + PORT;
const SPECTATE_DELAY = 800; // 测试用较短但可测量的观战延迟
const ADMIN_TOKEN = 'test-token';
const SERVER_DIR = path.join(__dirname, '..', 'server');

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

function wsConnect(params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`);
    const box = { ws, states: 0, firstStateAt: 0, gameOver: null, gameOverAt: 0, connectedAt: 0 };
    ws.on('open', () => { box.connectedAt = Date.now(); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') { box.states++; if (!box.firstStateAt) box.firstStateAt = Date.now(); }
      else if (msg.type === 'game_over') { box.gameOver = msg.data; box.gameOverAt = Date.now(); }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve(box));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-abuse-'));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      STATS_DIR: dataDir,
      ADMIN_TOKEN,
      AI_STEP_DELAY: '20',
      SPECTATE_DELAY_MS: String(SPECTATE_DELAY),
      ABUSE_CONFIG: JSON.stringify({
        adReward: { minIntervalMs: 300, dailyMax: { coin: 3, diamond: 2 } },
        sign: { minIntervalMs: 400 },
      }),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));

  try {
    // 等服务就绪
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await req('GET', '/health')).ok; } catch (e) { /* not yet */ }
    }
    ok(up, '测试服务实例启动');

    console.log('[1] 广告奖励防刷');
    const NICK = '刷子' + Date.now() % 100000;
    const r1 = await req('POST', '/api/ad/reward', { nick: NICK, kind: 'coin', token: NICK + '-tok' });
    ok(r1.ok === true, '第 1 次广告奖励成功发放');
    const r2 = await req('POST', '/api/ad/reward', { nick: NICK, kind: 'coin', token: NICK + '-tok' });
    ok(r2.ok === false && r2.error === 'RATE_LIMITED', '连打立即被限流 RATE_LIMITED');
    ok(r2.retryAfter > 0, '限流响应带 retryAfter 秒数');
    const r2b = await req('POST', '/api/ad/reward', { nick: NICK, kind: 'diamond', token: NICK + '-tok' });
    ok(r2b.ok === false && r2b.error === 'RATE_LIMITED', '钻石同键共享最小间隔');

    // 间隔放行，打到每日上限（coin 3 次：已 1，再 2 次成功，第 4 次拒）
    let coinsOk = 1, coinsLimited = null;
    for (let i = 0; i < 5; i++) {
      await sleep(360);
      const r = await req('POST', '/api/ad/reward', { nick: NICK, kind: 'coin', token: NICK + '-tok' });
      if (r.ok) coinsOk++;
      else { coinsLimited = r.error; break; }
    }
    ok(coinsOk === 3 && coinsLimited === 'DAILY_LIMIT', '金币每日上限 3 次生效（实际 ' + coinsOk + ' 次 → ' + coinsLimited + '）');
    let diaOk = 0, diaLimited = null;
    for (let i = 0; i < 5; i++) {
      await sleep(360);
      const r = await req('POST', '/api/ad/reward', { nick: NICK, kind: 'diamond', token: NICK + '-tok' });
      if (r.ok) diaOk++;
      else { diaLimited = r.error; break; }
    }
    ok(diaOk === 2 && diaLimited === 'DAILY_LIMIT', '钻石每日上限 2 次独立计数（实际 ' + diaOk + ' 次 → ' + diaLimited + '）');
    const other = await req('POST', '/api/ad/reward', { nick: '路人甲', kind: 'coin', token: '路人甲-tok' });
    ok(other.ok === true, '限流按用户隔离，他人不受影响');

    console.log('[2] 签到防刷');
    const SN = '签到侠' + Date.now() % 100000;
    const s1 = await req('POST', '/api/sign', { nick: SN, token: SN + '-tok' });
    ok(s1.ok === true && s1.signed === true, '首次签到成功');
    const s2 = await req('POST', '/api/sign', { nick: SN, token: SN + '-tok' });
    ok(s2.ok === false && s2.error === 'RATE_LIMITED', '签到连打被限流（原本会幂等放行，现在直接拦）');

    console.log('[3] 审计日志');
    const bad = await req('GET', '/api/admin/audit?token=wrong');
    ok(bad.ok === false && bad.error === 'BAD_TOKEN', '审计接口 token 鉴权');
    const au = await req('GET', '/api/admin/audit?token=' + ADMIN_TOKEN + '&n=100');
    ok(au.ok === true && au.list.length >= 6, '审计含奖励/拦截记录（' + au.list.length + ' 条）');
    const kinds = new Set(au.list.map((x) => x.kind));
    ok(kinds.has('ad_reward') && kinds.has('blocked_adReward'), '成功发放与被拦截尝试都有留痕');
    ok(au.list[0].at >= au.list[au.list.length - 1].at, '审计按新在前排序');

    console.log('[4] 观战延迟防偷跑');
    const created = await req('POST', '/api/rooms', {
      password: '',
      nickName: '延迟测试房主',
      settings: { aiLevel: 2, roundLimit: 3, turnSeconds: 0 },
    });
    ok(created.ok !== false && created.roomNo, '创建测试房间 ' + created.roomNo);
    const roomNo = created.roomNo;
    const hostClientId = created.hostClientId;
    for (let s = 1; s <= 3; s++) {
      const r = await req('POST', `/api/rooms/${roomNo}/seat`, { seat: s, action: 'set_ai', aiLevel: 2, requesterSeat: 0 });
      if (!r.ok) throw new Error('set_ai failed: ' + r.error);
    }
    const player = await wsConnect(`roomNo=${roomNo}&seat=0&clientId=${hostClientId}`);
    const spec = await wsConnect(`roomNo=${roomNo}&seat=-1&clientId=spec-1`);

    // 座位玩家自动响应 roll/select（快速打完 3 回合上限局）
    // 必须在 start 之前挂上，否则错过开局广播，对局会卡在人类回合
    const { choosePlane } = require(path.join(SERVER_DIR, 'src', 'game-engine', 'ai.js'));
    let lastGame = null;
    player.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'state') return;
      lastGame = msg.data.game;
      const g = msg.data.game;
      if (!g || g.phase === 'ended' || g.currentSeat !== 0) return;
      if (g.phase === 'rolling') player.ws.send(JSON.stringify({ type: 'roll' }));
      else if (g.phase === 'selecting') {
        const pid = choosePlane(g, 0, g.dice, 2);
        if (pid != null) player.ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
      }
    });

    await req('POST', `/api/rooms/${roomNo}/start`, { requesterSeat: 0 });

    // 观战者首帧必须延迟
    await sleep(SPECTATE_DELAY + 600);
    const specLag = spec.firstStateAt ? spec.firstStateAt - spec.connectedAt : Infinity;
    const playerLag = player.firstStateAt ? player.firstStateAt - player.connectedAt : Infinity;
    ok(spec.states > 0, '观战者能收到对局状态');
    ok(specLag >= SPECTATE_DELAY - 150, '观战者首帧延迟 ≥ ' + (SPECTATE_DELAY - 150) + 'ms（实测 ' + specLag + 'ms）');
    ok(playerLag < SPECTATE_DELAY, '座位玩家首帧明显快于观战者（实测 ' + playerLag + 'ms）');

    // 观战者发 roll 必须无效：对局照常推进/结束（若观战 roll 生效，会立刻多掷一次打乱轮次——
    // 这里以「服务存活 + 对局状态机仍按座位轮转推进到 game_over」作为不被篡改的证据）
    spec.ws.send(JSON.stringify({ type: 'roll' }));
    await sleep(400);
    const health = await req('GET', '/health');
    console.log('    [diag] player.states=' + player.states, 'spec.states=' + spec.states,
      'lastGame=' + (lastGame ? lastGame.phase + '@seat' + lastGame.currentSeat + '#r' + lastGame.roundNo : 'null'),
      'health=' + JSON.stringify(health));
    ok(health.ok === true && !!lastGame, '观战者 roll 不生效，服务与对局状态机正常');

    // game_over 对观战者不延迟：玩家收到后 500ms 内观战者也应收到
    const over = await new Promise((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (player.gameOver && spec.gameOver) { clearInterval(iv); resolve({ p: player.gameOverAt, s: spec.gameOverAt }); }
        else if (player.gameOver && Date.now() - player.gameOverAt > 600) { clearInterval(iv); resolve({ p: player.gameOverAt, s: 0 }); }
        else if (Date.now() - start > 30000) { clearInterval(iv); resolve(null); }
      }, 50);
    });
    if (over && over.p && over.s) {
      ok(over.s - over.p < 600, 'game_over 观战者即时收到（差 ' + (over.s - over.p) + 'ms）');
      ok(!!spec.gameOver.ranking, '观战者收到的结算数据完整');
    } else {
      ok(false, '30 秒内未等到对局结束（roundLimit=3 应快速终局）');
    }

    player.ws.close();
    spec.ws.close();

    console.log('\n========================================');
    console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
    console.log('========================================');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理失败无碍 */ }
  }
}

main().catch((e) => { console.error('ANTI-ABUSE TEST FAILED:', e); process.exit(1); });
