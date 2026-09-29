/**
 * tests/self-play.js — 规则引擎自对战压力测试
 *
 * 跑 N 局 4 AI 全自动对战，校验：
 *   1. 每局都能正常结束（产生 winner）
 *   2. 永不死循环（playTurnAuto 内置 guard + 外层步数上限）
 *   3. 任意时刻 game 状态内部一致（validate）
 *   4. 统计平均回合数、各座位胜率分布（验证 AI 不失衡）
 *
 * 运行：node tests/self-play.js [局数]
 */

const {
  createGame, playTurnAuto, isGameOver,
} = require('../server/src/game-engine/game-controller');
const { validate } = require('../server/src/game-engine/move');

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s % 6) + 1;
  };
}

function runGames(n, seedBase) {
  let ok = 0; let fail = 0;
  const winCount = [0, 0, 0, 0];
  let totalSteps = 0; let maxSteps = 0;
  const colorName = ['红', '黄', '蓝', '绿'];

  for (let i = 0; i < n; i++) {
    const rng = makeRng(seedBase + i * 2654435761);
    const g = createGame([
      { type: 'ai', aiLevel: 2 },
      { type: 'ai', aiLevel: 2 },
      { type: 'ai', aiLevel: 2 },
      { type: 'ai', aiLevel: 2 },
    ]);

    let steps = 0;
    const MAX_STEPS = 200000;
    while (!isGameOver(g) && steps < MAX_STEPS) {
      playTurnAuto(g, g.currentSeat, rng);
      steps += 1;
      const errs = validate(g);
      if (errs.length) {
        console.error(`[game ${i}] 非法状态:`, errs);
        fail += 1;
        break;
      }
    }
    if (isGameOver(g)) {
      ok += 1;
      winCount[g.winner] += 1;
      totalSteps += steps;
      if (steps > maxSteps) maxSteps = steps;
    } else {
      fail += 1;
      console.error(`[game ${i}] 未在 ${MAX_STEPS} 步内结束（疑似死循环或卡死）`);
    }
  }

  console.log('========================================');
  console.log(`局数: ${n}  成功: ${ok}  失败: ${fail}`);
  console.log(`平均回合数: ${(totalSteps / (ok || 1)).toFixed(1)}  最大回合: ${maxSteps}`);
  console.log('胜率分布 (红/黄/蓝/绿):', winCount.map((w, idx) => `${colorName[idx]}=${(w / (ok || 1) * 100).toFixed(1)}%`).join('  '));
  console.log('========================================');
  return fail === 0;
}

const n = parseInt(process.argv[2], 10) || 1000;
const seed = parseInt(process.argv[3], 10) || 12345;
const pass = runGames(n, seed);
process.exit(pass ? 0 : 1);
