/**
 * test-tournament.js — v21 全服锦标赛 专项测试
 *
 * A. 单元（进程内，STATS_DIR 指向临时目录，确定性断言）：
 *    - 报名 bracket 结构（8 人、玩家在 A 半区）
 *    - B 半区引擎模拟产出 2 位晋级者
 *    - 半区赛结算三路径：晋级 / 止步（奖励+战报）
 *    - 决赛结算：冠军 200 / 第 3 名 40，金币到账，冠军战报
 *    - applyResult 无钩子房安全
 * B. E2E（自起实例）：报名 → 真实驱动半区赛 → 状态机合法迁移（final 或 done），
 *    止步则金币+10；断线重连幂等（join 返回同进度）。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ ' + label); }
}

function unit() {
  console.log('[A1] 单元：报名与 bracket');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-tour-'));
  process.env.STATS_DIR = dataDir;
  const stats = require(path.join(__dirname, '..', 'server', 'src', 'stats'));
  const meta = require(path.join(__dirname, '..', 'server', 'src', 'meta'));
  const tournament = require(path.join(__dirname, '..', 'server', 'src', 'tournament'));

  const j = tournament.join('棋王');
  ok(j.ok === true && j.resumed === false, '首次报名成功');
  const t = j.t;
  ok(t.stage === 'semi' && t.semi.groupA.length === 4 && t.semi.groupB.length === 4, '8 人分两半区各 4 人');
  ok(t.semi.groupA.includes('棋王'), '玩家在 A 半区');
  ok(Object.keys(t.players).length === 7, '7 位虚拟棋手带强度');

  const j2 = tournament.join('棋王');
  ok(j2.ok === true && j2.resumed === true && j2.t.stage === 'semi', '进行中重复报名幂等续赛');

  console.log('[A2] B 半区模拟');
  const qb = tournament.runOtherSemi(t);
  ok(qb.length === 2 && t.semi.groupB.includes(qb[0]) && t.semi.groupB.includes(qb[1]), '模拟产出 2 位晋级者（来自 B 半区）');

  console.log('[A3] 半区赛结算三路径');
  const mkOrder = (ranks) => ranks.map(([seat, nick, rank]) => ({ seat, nick, rank, isWinner: rank === 1 }));
  // 晋级路径：玩家第 1
  const t1 = tournament.join('选手甲').t;
  tournament.runOtherSemi(t1);
  const r1 = tournament.applyResult({ tournament: { nick: '选手甲', stage: 'semi', seatNicks: { 1: t1.semi.groupA[1], 2: t1.semi.groupA[2], 3: t1.semi.groupA[3] } } },
    { order: mkOrder([[0, '选手甲', 1], [1, 'x', 2], [2, 'y', 3], [3, 'z', 4]]) });
  ok(r1 && r1.advanced === true && t1.stage === 'final', '半区赛第 1 名 → 晋级决赛');
  ok(t1.semi.qualifiedA.length === 2, '晋级名单 2 人（含虚拟棋手映射）');
  const m1 = meta.listMail('选手甲');
  ok(m1.list.some((m) => m.kind === 'tournament' && m.advanced === true), '晋级战报已发');

  // 止步路径：玩家第 4
  const t2 = tournament.join('选手乙').t;
  tournament.runOtherSemi(t2);
  const r2 = tournament.applyResult({ tournament: { nick: '选手乙', stage: 'semi', seatNicks: { 1: t2.semi.groupA[1] } } },
    { order: mkOrder([[0, '选手乙', 4], [1, 'x', 1], [2, 'y', 2], [3, 'z', 3]]) });
  ok(r2 && r2.advanced === false && r2.reward === 10 && t2.stage === 'done' && t2.reward === 10, '止步半区赛 → 安慰奖 10 金币');
  ok((stats.playerStats('选手乙') || { coins: 0 }).coins === 10, '止步金币到账');

  // 决赛路径：冠军
  const t3 = tournament.join('选手丙').t;
  tournament.runOtherSemi(t3);
  tournament.applyResult({ tournament: { nick: '选手丙', stage: 'semi', seatNicks: { 1: t3.semi.groupA[1] } } },
    { order: mkOrder([[0, '选手丙', 1], [1, 'x', 2], [2, 'y', 3], [3, 'z', 4]]) });
  const r3 = tournament.applyResult({ tournament: { nick: '选手丙', stage: 'final', seatNicks: { 1: 'q1', 2: 'q2', 3: 'q3' } } },
    { order: mkOrder([[0, '选手丙', 1], [1, 'q1', 2], [2, 'q2', 3], [3, 'q3', 4]]) });
  ok(r3 && r3.champion === true && r3.reward === 200 && t3.champion === true, '决赛夺冠 → 200 金币');
  ok((stats.playerStats('选手丙') || { coins: 0 }).coins === 200, '冠军金币到账');
  const m3 = meta.listMail('选手丙');
  ok(m3.list.some((m) => m.kind === 'tournament' && m.champion === true), '冠军战报已发');
  ok((stats.playerStats('选手丙') || { achievements: [] }).achievements.includes('tournament_champ'), '夺冠解锁「锦标赛冠军」成就（v22）');
  const champs = meta.championList();
  ok(champs.length === 1 && champs[0].nick === '选手丙' && champs[0].count === 1, '夺冠入历届冠军榜（v26）');
  // 再次夺冠应累计次数
  stats.unlockAchievements('选手丙', []); // no-op 保持状态
  const t3b = tournament.getState('选手丙');
  if (t3b && t3b.stage === 'done') {
    meta.addTournamentChampion('选手丙', 200);
    ok(meta.championList()[0].count === 2, '两次夺冠累计 ×2（v26）');
  }

  console.log('[A5] PVE 全通关成就（v22）');
  for (let lv = 1; lv <= 10; lv++) stats.pvePass('选手甲', lv);
  ok((stats.playerStats('选手甲') || { achievements: [] }).achievements.includes('conqueror'), '通关 10 关解锁「全图制霸」成就（v22）');

  console.log('[A7] 每日任务联动锦标赛（v28）');
  const ds = stats.dailyState('选手丙');
  ok(ds.tour >= 1, '锦标赛对局计入每日任务计数（tour=' + ds.tour + '）');
  const tourTask = ds.tasks.find((t2) => t2.id === 'tour1');
  ok(!!tourTask && tourTask.done === true, '「锦标赛之旅」任务点亮');
  const claim = stats.claimDaily('选手丙');
  ok(claim.ok === true && claim.coins >= 10, '领取每日奖励含锦标赛任务 10 金币（共 ' + claim.coins + '）');

  console.log('[A6] 成就进度字段（v26）');
  const w = (stats.playerStats('选手甲') || { wall: [] }).wall;
  const cent = w.find((x) => x.id === 'centurion');
  ok(cent && cent.progress && cent.progress.goal === 50 && cent.progress.cur === 0, '可计数成就带进度（百战沙场 0/50，未曾对局）');
  const conq = w.find((x) => x.id === 'conqueror');
  ok(conq && conq.progress === null, '事件型成就无进度（progress=null）');
  const conqUnlocked = w.find((x) => x.id === 'conqueror').unlocked;
  ok(conqUnlocked === true, '全图制霸已解锁状态正确');

  // 决赛第 3 名
  const t4 = tournament.join('选手丁').t;
  tournament.runOtherSemi(t4);
  tournament.applyResult({ tournament: { nick: '选手丁', stage: 'semi', seatNicks: { 1: t4.semi.groupA[1] } } },
    { order: mkOrder([[0, '选手丁', 2], [1, 'x', 1], [2, 'y', 3], [3, 'z', 4]]) });
  const r4 = tournament.applyResult({ tournament: { nick: '选手丁', stage: 'final', seatNicks: { 1: 'q1', 2: 'q2', 3: 'q3' } } },
    { order: mkOrder([[0, '选手丁', 3], [1, 'q1', 1], [2, 'q2', 2], [3, 'q3', 4]]) });
  ok(r4 && r4.reward === 40 && r4.champion === false, '决赛第 3 名 → 40 金币（非冠军）');

  // 安全：无钩子房
  ok(tournament.applyResult({}, { order: [] }) === null, '无锦标赛房 applyResult 安全返回 null');

  console.log('[A6] 荣誉徽标透出（v24）');
  const roomManager = require(path.join(__dirname, '..', 'server', 'src', 'room-manager'));
  const newRoom = roomManager.createRoom({ nickName: '选手丙' });
  const pub = roomManager.publicRoom(newRoom);
  const b = pub.seats[0].badges;
  ok(!!b && b.tournamentChamp === true && b.seasonKing === false, '冠军房主座位透出徽标（👑 1 / 🌟 0）');
  ok(pub.seats[1].badges === null, '空位/无成就座位徽标为 null');

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function req(BASE, method, p, body) {
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

async function e2e() {
  console.log('[B1] E2E：报名 → 驱动半区赛 → 状态迁移');
  const PORT = 3462;
  const BASE = 'http://127.0.0.1:' + PORT;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychess-tour2-'));
  const SERVER_DIR = path.join(__dirname, '..', 'server');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_DIR,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), STATS_DIR: dataDir, ADMIN_TOKEN: 'test-token',
      AI_STEP_DELAY: '5',
      ABUSE_CONFIG: JSON.stringify({ tournamentJoin: { minIntervalMs: 10, dailyMax: 10 }, roomCreate: { minIntervalMs: 10 } }),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => process.stderr.write('[server] ' + c));
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      try { up = (await req(BASE, 'GET', '/health')).ok; } catch (e) { /* not yet */ }
    }
    ok(up, '测试服务实例启动');

    const NICK = '冲锋', TOKEN = 'tour-tok';
    const j = await req(BASE, 'POST', '/api/tournament/join', { nick: NICK, token: TOKEN });
    ok(j.ok === true && j.stage === 'semi' && !!j.roomNo && !!j.hostClientId, '报名即开半区赛房（' + j.roomNo + '）');

    // 驱动半区赛（人类 level 4 对 AI 2-3）
    const { choosePlane } = require(path.join(SERVER_DIR, 'src', 'game-engine', 'ai.js'));
    const over = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?roomNo=${j.roomNo}&seat=0&clientId=${j.hostClientId}`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('game timeout 90s')); }, 90000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state') {
          const g = msg.data.game;
          if (!g || g.phase === 'ended' || g.currentSeat !== 0) return;
          if (g.phase === 'rolling') ws.send(JSON.stringify({ type: 'roll' }));
          else if (g.phase === 'selecting') {
            const pid = choosePlane(g, 0, g.dice, 4);
            if (pid != null) ws.send(JSON.stringify({ type: 'select', payload: { planeId: pid } }));
          }
        } else if (msg.type === 'game_over') {
          clearTimeout(timer);
          ws.close();
          resolve(msg.data);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    ok(!!over, '半区赛正常打完');
    const myRank = (over.order || []).find((p) => p.seat === 0);
    ok(!!over.tournament, 'game_over 携带锦标赛结算信息');
    ok((over.tournament.stage === 'semi' && over.tournament.advanced) || over.tournament.stage === 'done',
      '结算信息合法（advanced=' + !!over.tournament.advanced + '）');

    const st = await req(BASE, 'GET', '/api/tournament?nick=' + encodeURIComponent(NICK));
    ok(st.t && ((st.t.stage === 'final' && myRank.rank <= 2) || (st.t.stage === 'done' && myRank.rank > 2)),
      '服务端状态机与名次一致（我的名次 ' + myRank.rank + ' → ' + st.t.stage + '）');

    // 断线重连幂等：done 状态下再 join 会开新 bracket（stage semi）；final 则重建决赛房
    const j2 = await req(BASE, 'POST', '/api/tournament/join', { nick: NICK, token: TOKEN });
    ok(j2.ok === true && (j2.stage === 'semi' || j2.stage === 'final') && !!j2.roomNo, '续赛/再战返回可加入房间');
    const mail = await req(BASE, 'GET', '/api/mail?nick=' + encodeURIComponent(NICK));
    ok((mail.list || []).some((m) => m.kind === 'tournament'), '锦标赛战报已入箱');
    process.exitCode = failed ? 1 : 0;
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

unit();
e2e().then(() => {
  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error('TOURNAMENT TEST FAILED:', e); process.exit(1); });
