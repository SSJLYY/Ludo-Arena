'use strict';

// ============================================================
// 对局页视图模型（v1.14）—— 从页面 deriveView 抽取的纯函数，
// 输入对局快照与房间座位，输出全部界面派生数据。可单元测试。
// ============================================================

var COLOR_HEX = ['#e5484d', '#f0a12a', '#3f7bf5', '#27ae60'];
var COLOR_NAMES = ['红方', '黄方', '蓝方', '绿方'];

/**
 * @param game        对局文档快照
 * @param roomSeats   房间座位数组（含 isOnline/isHosted），可为 null
 * @param myOpenId    当前用户 openId（可为 ''）
 * @param hostedOn    本地主动托管开关（boolean）
 * @param ownerOpenId 房主 openId（可为空，用于房主标记）
 * @return { mySeat, hostedMe, playersView, canRoll, canSelect, canReroll, heldItems, hintText }
 */
function deriveViewState(game, roomSeats, myOpenId, hostedOn, ownerOpenId) {
  var mySeat = -1;
  var playersView = [];
  var i;
  for (i = 0; i < game.players.length; i++) {
    var p = game.players[i];
    if (p.type === 'human' && p.openId === myOpenId) mySeat = i;
    var seat = roomSeats ? roomSeats[i] : null;
    var progress = 0;
    for (var j = 0; j < p.planes.length; j++) {
      progress += p.planes[j].state === 'base' ? 0 : p.planes[j].rp;
    }
    var held = '';
    var it = game.items && game.items[i];
    if (it) {
      if (it.shield > 0) held += '🛡';
      if (it.reroll > 0) held += (held ? ' ' : '') + '🔄';
    }
    playersView.push({
      seat: i,
      color: COLOR_HEX[i],
      colorName: COLOR_NAMES[i],
      name: p.nickName || COLOR_NAMES[i],
      avatar: p.avatarUrl || '',
      type: p.type,
      done: p.finishedCount,
      progress: progress,
      rolls: p.stats.rolls,
      sixes: p.stats.sixes,
      kills: p.stats.kills,
      beenKilled: p.stats.beenKilled,
      held: held,
      current: game.currentSeat === i && game.status === 'playing',
      offline: seat ? seat.type === 'human' && !seat.isOnline : false,
      hosted: seat ? seat.type === 'human' && seat.isHosted : false,
      isOwner: !!(ownerOpenId && p.type === 'human' && p.openId === ownerOpenId)
    });
  }

  // v1.18 观战者可接管 AI 座位（对局进行中）
  var meInGame = false;
  for (var m = 0; m < game.players.length; m++) {
    var mp = game.players[m];
    if (mp.type === 'human' && mp.openId === myOpenId) { meInGame = true; break; }
  }
  if (!meInGame && game.status === 'playing') {
    playersView.forEach(function (pv) {
      if (pv.type === 'ai') pv.canTakeover = true;
    });
  }

    var serverHosted = mySeat >= 0 && roomSeats && roomSeats[mySeat] &&
    roomSeats[mySeat].type === 'human' && roomSeats[mySeat].isHosted;
  var hostedMe = serverHosted || !!hostedOn;
  var isMyTurn = game.status === 'playing' && game.currentSeat === mySeat;
  var canRoll = isMyTurn && game.phase === 'rolling' && !hostedMe;
  var canSelect = isMyTurn && game.phase === 'selecting' && !hostedMe;
  var myItems = mySeat >= 0 ? (game.items && game.items[mySeat]) : null;
  var canReroll = canSelect && !!myItems && myItems.reroll > 0 &&
    !game.rerolledThisTurn && game.allowItems !== false;
  var heldItems = '';
  if (myItems) {
    if (myItems.shield > 0) heldItems += '🛡';
    if (myItems.reroll > 0) heldItems += (heldItems ? ' ' : '') + '🔄';
  }

  var hintText;
  if (game.status !== 'playing') {
    hintText = '对局已结束';
  } else if (hostedMe) {
    hintText = hostedOn ? '托管中，AI 代你行动，点「托管」可接管'
      : '你已掉线，AI 正在托管代走，回到本页即自动接管';
  } else if (mySeat < 0) {
    hintText = '观战中（画面延迟 2.5 秒防偷跑）';
  } else if (canRoll) {
    hintText = game.extraRollLeft ? '掷 6 或撞子奖励，再掷一次！' : '轮到你了，点击掷骰子';
  } else if (canSelect) {
    hintText = '掷出 ' + game.dice + ' 点，点击发光的飞机移动' +
      (canReroll ? '（或不满意可重掷）' : '');
  } else {
    var cur = game.players[game.currentSeat];
    var who = cur ? (cur.type === 'ai' ? '电脑' : cur.nickName) : '';
    hintText = '等待 ' + who + ' 行动…';
  }

  return {
    mySeat: mySeat,
    hostedMe: hostedMe,
    playersView: playersView,
    canRoll: canRoll,
    canSelect: canSelect,
    canReroll: canReroll,
    heldItems: heldItems,
    hintText: hintText
  };
}

module.exports = {
  COLOR_HEX: COLOR_HEX,
  COLOR_NAMES: COLOR_NAMES,
  deriveViewState: deriveViewState
};
