'use strict';

// ============================================================
// 棋盘几何（15×15 网格）：主环 52 格沿十字外圈顺时针排布，每臂 13 格。
// 归航道 5 格由臂根伸入中心，4 角为停机坪，中心 3×3 为终点区。
// 该布局与 rules.js 的 START_OFFSET=[51,12,25,38] 严格互推：
//   每色起飞点与归航道入口相邻（abs start-1），主环每 4 格一色。
// ============================================================

var rules = require('./rules.js');

// 主环 52 格 [col, row]，顺序即行进方向（顺时针）
var TRACK = (function () {
  var cells = [];
  var i;
  for (i = 1; i <= 5; i++) cells.push([i, 6]);       // 0-4   左臂上沿向右
  for (i = 5; i >= 0; i--) cells.push([6, i]);       // 5-10  顶臂左列向上
  cells.push([7, 0]);                                 // 11    顶臂中（黄归航道口）
  for (i = 0; i <= 5; i++) cells.push([8, i]);       // 12-17 顶臂右列向下
  for (i = 9; i <= 14; i++) cells.push([i, 6]);      // 18-23 右臂上沿向右
  cells.push([14, 7]);                                // 24    右臂中（蓝归航道口）
  for (i = 14; i >= 9; i--) cells.push([i, 8]);      // 25-30 右臂下沿向左
  for (i = 9; i <= 14; i++) cells.push([8, i]);      // 31-36 底臂右列向下
  cells.push([7, 14]);                                // 37    底臂中（绿归航道口）
  for (i = 14; i >= 9; i--) cells.push([6, i]);      // 38-43 底臂左列向上
  for (i = 5; i >= 0; i--) cells.push([i, 8]);       // 44-49 左臂下沿向左
  cells.push([0, 7]);                                 // 50    左臂中（红归航道口）
  cells.push([0, 6]);                                 // 51    红起飞点
  return cells;
})();

// 各座位归航道 5 格（入口格 → 中心）
var LANES = [
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],           // 红：左臂
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],           // 黄：顶臂
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],       // 蓝：右臂
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]]        // 绿：底臂
];

// 停机坪（4×4 角区）内 4 个停机位（可用小数格坐标）
var BASE_SPOTS = [
  [[1.6, 1.6], [3.4, 1.6], [1.6, 3.4], [3.4, 3.4]],           // 红 左上
  [[10.6, 1.6], [12.4, 1.6], [10.6, 3.4], [12.4, 3.4]],       // 黄 右上
  [[10.6, 10.6], [12.4, 10.6], [10.6, 12.4], [12.4, 12.4]],   // 蓝 右下
  [[1.6, 10.6], [3.4, 10.6], [1.6, 12.4], [3.4, 12.4]]        // 绿 左下
];

// 停机坪 6×6 区域左上角格坐标
var BASE_AREAS = [[0, 0], [9, 0], [9, 9], [0, 9]];

// 已到达终点区时 4 架飞机的小偏移（避免完全重叠）
var HOME_OFFSETS = [
  [-0.22, -0.1], [0.22, -0.18], [-0.18, 0.2], [0.2, 0.22]
];

// 由棋盘边长（px）生成全部像素坐标
function layout(size) {
  var cs = size / 15;
  function px(c, r) {
    return { x: (c + 0.5) * cs, y: (r + 0.5) * cs };
  }
  var track = TRACK.map(function (t) { return px(t[0], t[1]); });
  var lanes = LANES.map(function (lane) {
    return lane.map(function (t) { return px(t[0], t[1]); });
  });
  var bases = BASE_SPOTS.map(function (group) {
    return group.map(function (t) { return px(t[0], t[1]); });
  });
  var home = [
    px(6.05, 7.5), px(7.5, 6.05), px(8.95, 7.5), px(7.5, 8.95)
  ];
  return {
    size: size,
    cs: cs,
    track: track,
    lanes: lanes,
    bases: bases,
    baseAreas: BASE_AREAS,
    home: home,
    homeOffsets: HOME_OFFSETS,
    center: px(7.5, 7.5),
    trackCells: TRACK,
    laneCells: LANES
  };
}

// 一架飞机的像素位置。plane: {id, state, rp}
function pointFor(seat, plane, L) {
  if (plane.state === 'base') return L.bases[seat][plane.id];
  if (plane.state === 'home') {
    var base = L.home[seat];
    var off = L.homeOffsets[plane.id] || [0, 0];
    return { x: base.x + off[0] * L.cs, y: base.y + off[1] * L.cs };
  }
  if (plane.state === 'lane') return L.lanes[seat][plane.rp - rules.LANE_START];
  return L.track[rules.absOfRp(seat, plane.rp)];
}

module.exports = {
  TRACK: TRACK,
  LANES: LANES,
  BASE_SPOTS: BASE_SPOTS,
  BASE_AREAS: BASE_AREAS,
  layout: layout,
  pointFor: pointFor
};
