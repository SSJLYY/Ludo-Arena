/**
 * move.js — 飞行棋单步结算（纯逻辑，前后端共用）
 *
 * v2.0 移植小程序版玩法：
 *   - v1.1 飞行箭头：落 rp 36 己色格 → 飞跃 12 格至 rp 48
 *   - v1.6 道具卡：命中敌机随机得卡（护盾/重掷，各上限 1）
 *                  护盾自动挂最靠前轨道机；撞带盾目标 → 护盾抵消 + 进攻方反震回基地
 *   - 弹回模式：needExactFinish=false 时，超出终点往回弹
 *
 * 纯函数约定：不修改入参，返回新的 game 对象。
 */

const {
  PLANES_PER_PLAYER, FINISH_RP, MAIN_RING, absCell, isSafeCell, planHop,
  isItemCell, ITEM_TYPES,
} = require('./rules');

// 注：v1.6 的「击杀给卡」逻辑已废弃，改为 v3 的「落道具格随机拾取」（见 applyMove）。

/**
 * 计算合法可动飞机。
 *   - 基地飞机（rp=-1）只有 dice===6 才能起飞到起飞点 rp=0
 *   - 精确到达模式（needExactFinish）：target > 57 不可动
 *   - 弹回模式：target > 57 可动，落点 = 114 - target
 *   - 已到终点（rp=57）不可动
 * 返回的 to 已含跃迁（跳格/飞行箭头）后的最终落点。
 */
function computeLegalMoves(game, seat, dice) {
  const p = game.players[seat];
  if (!p) return [];
  const moves = [];
  for (const plane of p.planes) {
    if (plane.rp === FINISH_RP) continue;            // 已完成
    if (plane.rp === -1) {
      // v13 任意点数起飞：takeoffAny=true 时任意骰子都能起飞；否则仅掷 6
      if (dice === 6 || game.takeoffAny) {
        const hop0 = planHop(game, p.color, 0);
        moves.push({ planeId: plane.id, from: -1, to: hop0 ? hop0.target : 0 });
      }
      continue;
    }
    const raw = plane.rp + dice;
    if (raw > FINISH_RP) {
      if (game.needExactFinish !== false) continue;  // 精确到达：超出不可动
      const bounced = 2 * FINISH_RP - raw;           // 弹回模式
      moves.push({ planeId: plane.id, from: plane.rp, to: bounced, bounce: true });
      continue;
    }
    const hop = planHop(game, p.color, raw);
    moves.push({ planeId: plane.id, from: plane.rp, to: hop ? hop.target : raw });
  }
  return moves;
}

/**
 * 执行一次移动（给定 planeId）。返回 { game, events, extraRoll }。
 * extraRoll：掷 6 / 起飞 / 真实撞子 后获得的额外掷骰权（重掷出的点数不触发掷 6 奖励）。
 * @param {object} opts { rng, noDiceExtra }  noDiceExtra=true 表示本手是重掷点数，不再奖励连掷
 */
function applyMove(game, seat, planeId, dice, opts = {}) {
  const rng = opts.rng || Math.random;
  const next = JSON.parse(JSON.stringify(game));
  const p = next.players[seat];
  const plane = p.planes.find((x) => x.id === planeId);
  const events = [];
  if (!plane) throw new Error('PLANE_NOT_FOUND');
  if (!next.items) next.items = [0, 1, 2, 3].map(() => ({ bomb: 0, shield: 0, accel: 0, swap: 0 }));
  if (!next.itemCells) next.itemCells = {};

  const fromRp = plane.rp;
  const isTakeoff = fromRp === -1;

  // —— 落点：起飞 / 前进（含弹回） ——
  let landedRp;
  if (isTakeoff) {
    landedRp = 0;
    events.push({ type: 'takeoff', seat, planeId });
  } else {
    const raw = fromRp + dice;
    if (raw > FINISH_RP) {
      if (next.needExactFinish !== false) throw new Error('MOVE_EXCEEDS_HOME');
      landedRp = 2 * FINISH_RP - raw;
      events.push({ type: 'bounce', seat, planeId, from: fromRp, to: landedRp });
    } else {
      landedRp = raw;
    }
  }

  // —— 跃迁：飞行箭头（rp36 → +12）或跳格（+4），不连锁 ——
  if (landedRp >= 0 && landedRp <= MAIN_RING - 1) {
    const hop = planHop(next, p.color, landedRp);
    if (hop) {
      events.push({ type: hop.type, seat, planeId, from: landedRp, to: hop.target });
      landedRp = hop.target;
    }
  }

  plane.rp = landedRp;
  plane.state = landedRp === FINISH_RP ? 'home' : (landedRp >= 52 ? 'lane' : 'track');
  events.push({ type: 'move', seat, planeId, from: fromRp, to: landedRp });

  // 到达终点
  if (landedRp === FINISH_RP) {
    p.finishedCount += 1;
    events.push({ type: 'home', seat, planeId });
    if (p.finishedCount === PLANES_PER_PLAYER && p.finishRank === null) {
      const rank = next.players.filter((x) => x.finishRank !== null).length + 1;
      p.finishRank = rank;
      next.ranking.push(seat);
      events.push({ type: 'finish', seat, rank });
    }
  }
  p.stats.rolls += 1;

  // —— 撞子判定（仅主环，且非安全格）——
  let realKills = 0;
  let anyBlocked = false;
  // v13 和平模式（crashBack=false）：落敌方头顶不再将其撞回基地，双方共存
  if (landedRp >= 0 && landedRp <= MAIN_RING - 1 && next.crashBack !== false) {
    const abs = absCell(p.color, landedRp);
    if (!isSafeCell(abs)) {
      for (const other of next.players) {
        if (other.seat === seat) continue;
        for (const op of other.planes) {
          if (op.rp >= 0 && op.rp <= MAIN_RING - 1 && absCell(other.color, op.rp) === abs) {
            if (op.shield) {
              // 护盾反震：护盾消耗挡下击杀，进攻方反而被撞回基地
              op.shield = false;
              other.items && (other.items.shield = 0);
              anyBlocked = true;
              events.push({
                type: 'shield_block', seat, planeId,
                victimSeat: other.seat, victimPlaneId: op.id,
              });
            } else {
              op.rp = -1;
              op.state = 'base';
              other.stats.beenKilled += 1;
              p.stats.kills += 1;
              realKills += 1;
              events.push({ type: 'kill', seat, planeId, victimSeat: other.seat, victimPlaneId: op.id });
            }
          }
        }
      }
    }
  }

  // 反震：进攻方本架飞机回基地
  if (anyBlocked) {
    plane.rp = -1;
    plane.state = 'base';
    p.stats.beenKilled += 1;
    events.push({ type: 'counter', seat, planeId });
  }

  // v3 道具格拾取：落点恰好是道具格（且不在冷却中）→ 随机发一张道具（各上限 3）
  if (landedRp >= 0 && landedRp <= MAIN_RING - 1 && isItemCell(absCell(p.color, landedRp))) {
    const abs = absCell(p.color, landedRp);
    if (!next.itemCells[abs]) {
      const type = ITEM_TYPES[Math.floor(rng() * ITEM_TYPES.length)];
      const inv = next.items[seat];
      if (inv[type] < 3) {
        inv[type] += 1;
        next.itemCells[abs] = 4; // 冷却 4 个回合（switchPlayer 递减）
        events.push({ type: 'gain_item', seat, item: type });
      }
    }
  }

  const noDiceExtra = !!opts.noDiceExtra;
  // v13 任意点数起飞模式下：非 6 起飞不再奖励额外掷骰（避免滥用），仅「掷 6 起飞」仍奖励
  const extraRoll = (dice === 6 && !noDiceExtra) || (isTakeoff && dice === 6) || realKills > 0;
  return { game: next, events, extraRoll };
}

/**
 * 校验 game 状态内部一致性（测试用）。
 */
function validate(game) {
  const errs = [];
  if (game.players.length !== 4) errs.push('player count != 4');
  for (const p of game.players) {
    if (p.planes.length !== PLANES_PER_PLAYER) errs.push(`seat ${p.seat} plane count != 4`);
    for (const pl of p.planes) {
      if (pl.rp < -1 || pl.rp > FINISH_RP) errs.push(`seat ${p.seat} plane ${pl.id} rp out of range: ${pl.rp}`);
    }
  }
  return errs;
}

module.exports = { computeLegalMoves, applyMove, validate };
