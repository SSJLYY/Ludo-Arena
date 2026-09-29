'use strict';

// ============================================================
// 回放状态重建（v1.9）—— 从 moves 事件流逐帧重建对局状态，
// 云函数存档的事件流与这里共享同一套规则语义（engine 产生事件）。
// 一致性由 tests/run-tests.js 的逐帧比对测试锁定：重建状态必须
// 与引擎真实状态完全一致，事件形状变化若未同步此处会当场失败。
// ============================================================

var move = require('./move.js');
var rules = require('./rules.js');

// 轻量事件结算：把一批事件应用到状态（不经过引擎 advance）
function applyEvents(st, events) {
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.type === 'gain_item') {
      // 道具获得：计数 +1，护盾同步挂载
      if (st.items && st.items[ev.seat]) st.items[ev.seat][ev.item] = 1;
      if (ev.item === 'shield' && ev.planeId !== undefined) {
        st.players[ev.seat].planes[ev.planeId].shield = true;
      }
      continue;
    }
    if (ev.type === 'reroll') {
      st.dice = ev.dice;
      if (st.items && st.items[ev.seat] && st.items[ev.seat].reroll > 0) {
        st.items[ev.seat].reroll -= 1;
      }
      continue;
    }
    if (ev.type !== 'move') continue;
    var p = st.players[ev.seat];
    var pl = p.planes[ev.planeId];
    pl.state = ev.to.state;
    pl.rp = ev.to.rp;
    if (ev.finished) p.finishedCount += 1;
    var kills = ev.kills || [];
    for (var k = 0; k < kills.length; k++) {
      if (kills[k].blocked) {
        // 护盾反震：进攻方（移动者）回基地，盾机原地消耗护盾
        pl.state = 'base';
        pl.rp = rules.BASE_RP;
        st.players[kills[k].seat].planes[kills[k].planeId].shield = false;
        continue;
      }
      var vp = st.players[kills[k].seat].planes[kills[k].planeId];
      vp.state = 'base';
      vp.rp = -1;
    }
  }
}

/**
 * 由 games 快照 + moves 流水构建回放帧序列。
 * @param game 对局文档（需 players/needExactFinish/allowJump/allowFly/allowItems/winner）
 * @param moves 按 seq 升序的操作流水（每条 {events}）
 * @return [{ seq, events, dice, state }]，state 为该帧后的完整引擎状态
 */
function buildFrames(game, moves) {
  var seats = game.players.map(function (p) {
    return { type: p.type, openId: p.openId, nickName: p.nickName, avatarUrl: p.avatarUrl };
  });
  var st = move.createGame({
    seats: seats,
    needExactFinish: game.needExactFinish !== false,
    allowJump: game.allowJump !== false,
    allowFly: game.allowFly !== false,
    allowItems: game.allowItems !== false
  });
  var frames = [];
  for (var i = 0; i < moves.length; i++) {
    var events = moves[i].events || [];
    applyEvents(st, events);
    var rollEv = null;
    for (var e = 0; e < events.length; e++) {
      if (events[e].type === 'roll' || events[e].type === 'reroll') { rollEv = events[e]; break; }
    }
    frames.push({
      seq: frames.length,
      events: events,
      dice: rollEv ? rollEv.dice : st.dice,
      state: move.cloneState(st)
    });
  }
  return frames;
}

module.exports = {
  applyEvents: applyEvents,
  buildFrames: buildFrames
};
