/* board.js — 棋盘坐标与 Canvas 绘制（与后端 rp 规则严格对应）
 *
 * v6 视觉（v3 几何保持不变）：
 *   - 几何：网格 14x14（col,row ∈ 0..13），cell = size/14，中心 = (7,7)*cell。
 *     主环 52 格走外框回字环；旋转 90° ≡ index + 13 (mod 52)。
 *     基地在四边中央（下/左/上/右，风车式旋转对称），四色起飞点正对自己基地。
 *     归航道走四个对角区，终点在画布正中的四格。
 *   - 视觉：连贯跑道带 / 四色循环彩格（abs%4，与跳格规则一致）/ 起飞点金星安全标 /
 *           飞行格虚线航线弧 / 实色归航道 / 实心机库基地 + 白色停机位 /
 *           四色风车终点区 + 金星徽章 / 立体渐变飞机（机身·机翼·舱盖·尾焰）
 *
 * 对外 API：
 *   Board.setMyView(color)              设置视角（自己的基地转到屏幕正下方）
 *   Board.setRotation(n)
 *   Board.computePositions(game, cell)  -> { "seat-id": {x,y,color,state} }
 *   Board.computeHitboxes(game, ui, cell) -> [{seat,planeId,x,y,r}]
 *   Board.drawScene(canvas, game, ui, posOverride, fx) -> hitboxes[]
 */
(function (global) {
  'use strict';

  const GRID = 14;                  // 14x14 网格，cell = size / GRID
  const COLORS = ['red', 'yellow', 'blue', 'green'];
  const COLOR_OFFSET = { red: 0, yellow: 13, blue: 26, green: 39 };
  const COLOR_HEX = { red: '#ff5f6d', yellow: '#ffc93c', blue: '#4aa8ff', green: '#3ddc84' };
  const COLOR_NAME = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };
  // 棋盘格子用色（比 UI 色更饱和，亮底辨识度更高）
  const TILE_HEX = { red: '#f4495d', yellow: '#f2a41c', blue: '#2f96f0', green: '#27bf68' };
  // v8 皮肤：换肤时 mutate 这两个调色板对象（drawScene 实时读取），保留原始值可复位
  const _origColorHex = Object.assign({}, COLOR_HEX);
  const _origTileHex = Object.assign({}, TILE_HEX);
  function setSkin(id) {
    Object.assign(COLOR_HEX, _origColorHex);
    Object.assign(TILE_HEX, _origTileHex);
    const map = (typeof window !== 'undefined' && window.__SKIN_COLORS__) || {};
    if (id && map[id]) {
      if (map[id].colorHex) Object.assign(COLOR_HEX, map[id].colorHex);
      if (map[id].tileHex) Object.assign(TILE_HEX, map[id].tileHex);
    }
  }
  // abs % 4 → 格子归属色（与后端 rules.js isSameColorCell 一致：abs ≡ offset (mod 4)）
  const ABS_COLOR = ['red', 'yellow', 'blue', 'green'];
  const SAFE_CELLS = [0, 13, 26, 39];
  // v3 道具格（与后端 rules.js ITEM_CELLS 保持一致）：主环每 13 格一处
  const ITEM_CELLS = [6, 19, 32, 45];

  // v2.0 飞行箭头：每色 rp36 的己色格为箭头格，落上飞跃 12 格（→ rp48）
  const FLY_RP = 36;
  const FLY_DIST = 12;
  const FLY_ABS = COLORS.reduce((m, c) => {
    m[(COLOR_OFFSET[c] + FLY_RP) % 52] = c;
    return m;
  }, {});

  /* 主环 52 格（顺时针，index = 绝对格位 abs ∈ 0..51）
   * 编号起点选在「底边中央」[7,13]，使 red(offset 0) 的起飞点位于屏幕正下方。
   * 性质：rot90(MAIN_PATH[i]) === MAIN_PATH[(i + 13) % 52]
   */
  const MAIN_PATH = [
    [7,13],[6,13],[5,13],[4,13],[3,13],[2,13],[1,13],          //  0.. 6 底行 col 7→1
    [0,13],                                                      //  7     左下角
    [0,12],[0,11],[0,10],[0,9],[0,8],[0,7],[0,6],[0,5],        //  8..15 左列 row 12→5
    [0,4],[0,3],[0,2],[0,1],                                     // 16..19 左列 row 4→1
    [0,0],                                                       // 20     左上角
    [1,0],[2,0],[3,0],[4,0],[5,0],[6,0],[7,0],[8,0],            // 21..28 顶行 col 1→8
    [9,0],[10,0],[11,0],[12,0],                                  // 29..32 顶行 col 9→12
    [13,0],                                                      // 33     右上角
    [13,1],[13,2],[13,3],[13,4],[13,5],[13,6],[13,7],[13,8],   // 34..41 右列 row 1→8
    [13,9],[13,10],[13,11],[13,12],                              // 42..45 右列 row 9→12
    [13,13],                                                     // 46     右下角
    [12,13],[11,13],[10,13],[9,13],[8,13],                      // 47..51 底行 col 12→8
  ];

  /* 归航道（rotN=0 基准：red 在下方）每色 5 格，沿对角区收进中心 */
  const LANES = {
    red:    { lane: [[8,12],[8,11],[8,10],[8,9],[8,8]],    home: [7,7] },
    yellow: { lane: [[1,8],[2,8],[3,8],[4,8],[5,8]],       home: [6,7] },
    blue:   { lane: [[5,1],[5,2],[5,3],[5,4],[5,5]],       home: [6,6] },
    green:  { lane: [[12,5],[11,5],[10,5],[9,5],[8,5]],    home: [7,6] },
  };

  /* 基地（贴合各自那条边）+ 停机位 2x2（跨在网格中轴上） */
  const BASE_SLOTS = {
    red:    [[6,10],[7,10],[6,11],[7,11]],
    yellow: [[2,5],[3,5],[2,6],[3,6]],
    blue:   [[7,2],[8,2],[7,3],[8,3]],
    green:  [[10,7],[11,7],[10,8],[11,8]],
  };
  const BASE_BOX = {
    red:    [5, 9, 3, 4],
    yellow: [1, 5, 4, 3],
    blue:   [6, 1, 3, 4],
    green:  [9, 6, 4, 3],
  };

  // 到家后 4 架飞机在 home 格内 2x2 排开
  const HOME_OFF = [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]];

  /* ================= 颜色工具 ================= */
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // 注意：必须返回 #hex 字符串——下游 rgba() 只解析 hex，
  // 若返回 rgb() 字符串会导致 rgba() 解析出 NaN→黑色（格子全黑事故的根因）
  function mixHex(hex, targetHex, t) {
    const a = hexToRgb(hex), b = hexToRgb(targetHex);
    let out = '#';
    for (let i = 0; i < 3; i++) {
      const v = Math.max(0, Math.min(255, Math.round(a[i] + (b[i] - a[i]) * t)));
      out += v.toString(16).padStart(2, '0');
    }
    return out;
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }
  const light = (hex, t) => mixHex(hex, '#ffffff', t);
  const dark = (hex, t) => mixHex(hex, '#000000', t);

  /* ================= 视角旋转 ================= */
  let rotN = 0;
  function setRotation(n) { rotN = ((n % 4) + 4) % 4; }
  function setMyView(color) {
    const map = { red: 0, yellow: 3, blue: 2, green: 1 };
    setRotation(map[color] === undefined ? 0 : map[color]);
  }
  /** 格索引旋转（顺时针 90°）：(c,r) -> (GRID-1-r, c) */
  function rot([c, r]) {
    for (let i = 0; i < rotN; i++) { const t = c; c = (GRID - 1) - r; r = t; }
    return [c, r];
  }
  /** 像素矩形（格边界坐标）旋转：(c,r,w,h) -> (GRID-r-h, c, h, w) */
  function rotBox([c, r, w, h]) {
    for (let i = 0; i < rotN; i++) {
      const nc = GRID - r - h, nr = c, nw = h, nh = w;
      c = nc; r = nr; w = nw; h = nh;
    }
    return [c, r, w, h];
  }
  function planeGrid(color, state, rp) {
    if (state === 'main' || state === 'track') {
      return MAIN_PATH[(COLOR_OFFSET[color] + rp) % 52];
    }
    if (state === 'lane') return LANES[color].lane[rp - 52];
    if (state === 'finished' || state === 'home') return LANES[color].home;
    return null;
  }

  /* ================= 绘制基元 ================= */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** 玻璃质感格子：底渐变 + 顶部内高光 + 细描边 */
  function glassCell(ctx, x, y, w, h, r, baseHex, alpha) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, rgba(light(baseHex, 0.12), alpha));
    g.addColorStop(0.52, rgba(baseHex, alpha));
    g.addColorStop(1, rgba(dark(baseHex, 0.34), alpha));
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = g;
    ctx.fill();
    // 顶部内高光
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const hl = ctx.createLinearGradient(x, y, x, y + h * 0.5);
    hl.addColorStop(0, 'rgba(255,255,255,0.20)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(x, y, w, h * 0.5);
    ctx.restore();
  }

  /** 小盾牌路径（安全格角标） */
  function shieldPath(ctx, cx, cy, s) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx + s * 0.85, cy - s * 0.55);
    ctx.lineTo(cx + s * 0.85, cy + s * 0.25);
    ctx.quadraticCurveTo(cx + s * 0.85, cy + s * 0.85, cx, cy + s * 1.12);
    ctx.quadraticCurveTo(cx - s * 0.85, cy + s * 0.85, cx - s * 0.85, cy + s * 0.25);
    ctx.lineTo(cx - s * 0.85, cy - s * 0.55);
    ctx.closePath();
  }

  /** 五角星路径 */
  function starPath(ctx, cx, cy, R, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = (i % 2 === 0) ? R : r;
      const a = -Math.PI / 2 + (Math.PI / 5) * i;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 飞机剪影 path（局部坐标，机头朝 -y），用于格子图标 */
  function planeSilhouette(ctx, cx, cy, s) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - s);
    ctx.bezierCurveTo(cx + s * 0.26, cy - s * 0.7, cx + s * 0.38, cy - s * 0.12, cx + s * 0.36, cy + s * 0.28);
    ctx.lineTo(cx + s * 1.0, cy + s * 0.42);
    ctx.lineTo(cx + s * 1.0, cy + s * 0.62);
    ctx.lineTo(cx + s * 0.3, cy + s * 0.42);
    ctx.lineTo(cx + s * 0.3, cy + s * 0.72);
    ctx.lineTo(cx + s * 0.52, cy + s * 0.86);
    ctx.lineTo(cx + s * 0.52, cy + s * 1.0);
    ctx.lineTo(cx, cy + s * 0.8);
    ctx.lineTo(cx - s * 0.52, cy + s * 1.0);
    ctx.lineTo(cx - s * 0.52, cy + s * 0.86);
    ctx.lineTo(cx - s * 0.3, cy + s * 0.72);
    ctx.lineTo(cx - s * 0.3, cy + s * 0.42);
    ctx.lineTo(cx - s * 1.0, cy + s * 0.62);
    ctx.lineTo(cx - s * 1.0, cy + s * 0.42);
    ctx.lineTo(cx - s * 0.36, cy + s * 0.28);
    ctx.bezierCurveTo(cx - s * 0.38, cy - s * 0.12, cx - s * 0.26, cy - s * 0.7, cx, cy - s);
    ctx.closePath();
  }

  /* ================= 飞机主绘制 ================= */
  function drawPlane(ctx, x, y, r, color, isMine, isMovable, pulse, shield) {
    const base = TILE_HEX[color] || COLOR_HEX[color] || color;

    // 可走：金色「圆台」垫底 —— 画在飞机之前，绝不会被机身盖住
    // 之所以改成实心圆台：原来的细光环被机身压掉大半，在浅色棋盘上几乎看不见
    if (isMovable) {
      const br = r * (1.18 + 0.08 * pulse);
      ctx.save();
      // 外圈深色描边：保证在亮白棋盘上也有轮廓（浅底高对比的关键）
      ctx.beginPath(); ctx.arc(x, y, br, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(122,62,0,${0.5 + 0.2 * pulse})`;
      ctx.fill();
      // 亮金实心圆台
      const bg = ctx.createRadialGradient(x, y - br * 0.25, br * 0.1, x, y, br * 0.92);
      bg.addColorStop(0, '#fff0b8');
      bg.addColorStop(0.55, '#ffc93c');
      bg.addColorStop(1, '#f59f0b');
      ctx.beginPath(); ctx.arc(x, y, br * 0.92, 0, Math.PI * 2);
      ctx.fillStyle = bg; ctx.fill();
      ctx.lineWidth = Math.max(1.2, br * 0.07);
      ctx.strokeStyle = `rgba(255,252,235,${0.75 + 0.25 * pulse})`;
      ctx.stroke();
      ctx.restore();
    }

    // 地面投影
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(x + r * 0.1, y + r * 0.34, r * 0.62, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(35,45,100,0.28)';
    ctx.fill();
    ctx.restore();

    // 自己的飞机：白色光晕底
    if (isMine) {
      const hg = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.35);
      hg.addColorStop(0, 'rgba(255,255,255,0.30)');
      hg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(x, y, r * 1.35, 0, Math.PI * 2); ctx.fill();
    }

    ctx.save();
    ctx.translate(x, y);
    // 朝向：机头指向棋盘中心
    const ang = Math.atan2(_size / 2 - y, _size / 2 - x) + Math.PI / 2;
    ctx.rotate(ang);

    const bodyG = ctx.createLinearGradient(-r * 0.35, -r * 0.8, r * 0.35, r * 0.8);
    bodyG.addColorStop(0, light(base, 0.42));
    bodyG.addColorStop(0.42, base);
    bodyG.addColorStop(1, dark(base, 0.42));

    // 可走机在金台上，用深褐描边勾机身（金边会和圆台糊在一起）
    const outline = isMovable ? 'rgba(122,62,0,0.9)'
      : (isMine ? '#ffffff' : 'rgba(22,30,75,0.55)');
    const ow = isMovable ? r * 0.12 : (isMine ? r * 0.13 : r * 0.08);

    // —— 机翼（先画，压在机身下）——
    ctx.fillStyle = dark(base, 0.18);
    ctx.strokeStyle = outline; ctx.lineWidth = ow * 0.75; ctx.lineJoin = 'round';
    // 右主翼
    ctx.beginPath();
    ctx.moveTo(r * 0.05, -r * 0.06);
    ctx.lineTo(r * 1.0, r * 0.34);
    ctx.quadraticCurveTo(r * 1.06, r * 0.46, r * 0.94, r * 0.5);
    ctx.lineTo(r * 0.12, r * 0.34);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 左主翼
    ctx.beginPath();
    ctx.moveTo(-r * 0.05, -r * 0.06);
    ctx.lineTo(-r * 1.0, r * 0.34);
    ctx.quadraticCurveTo(-r * 1.06, r * 0.46, -r * 0.94, r * 0.5);
    ctx.lineTo(-r * 0.12, r * 0.34);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 尾翼
    ctx.beginPath();
    ctx.moveTo(0, r * 0.42);
    ctx.lineTo(r * 0.46, r * 0.78);
    ctx.lineTo(r * 0.46, r * 0.9);
    ctx.lineTo(0, r * 0.66);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, r * 0.42);
    ctx.lineTo(-r * 0.46, r * 0.78);
    ctx.lineTo(-r * 0.46, r * 0.9);
    ctx.lineTo(0, r * 0.66);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    // 机翼前缘高光（金属反光）
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = r * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(r * 0.1, r * 0.02); ctx.lineTo(r * 0.9, r * 0.36);
    ctx.moveTo(-r * 0.1, r * 0.02); ctx.lineTo(-r * 0.9, r * 0.36);
    ctx.stroke();
    ctx.restore();

    // —— 机身 ——
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.98);
    ctx.bezierCurveTo(r * 0.26, -r * 0.68, r * 0.4, -r * 0.1, r * 0.38, r * 0.3);
    ctx.lineTo(r * 0.32, r * 0.66);
    ctx.quadraticCurveTo(r * 0.28, r * 0.86, r * 0.16, r * 0.86);
    ctx.lineTo(-r * 0.16, r * 0.86);
    ctx.quadraticCurveTo(-r * 0.28, r * 0.86, -r * 0.32, r * 0.66);
    ctx.lineTo(-r * 0.38, r * 0.3);
    ctx.bezierCurveTo(-r * 0.4, -r * 0.1, -r * 0.26, -r * 0.68, 0, -r * 0.98);
    ctx.closePath();
    ctx.fillStyle = bodyG; ctx.fill();
    ctx.strokeStyle = outline; ctx.lineWidth = ow; ctx.stroke();

    // 机身顶部高光
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.9);
    ctx.bezierCurveTo(r * 0.2, -r * 0.62, r * 0.3, -r * 0.1, r * 0.28, r * 0.25);
    ctx.lineTo(r * 0.1, r * 0.2);
    ctx.bezierCurveTo(r * 0.1, -r * 0.2, r * 0.06, -r * 0.6, 0, -r * 0.9);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fill();
    ctx.restore();

    // —— 驾驶舱 ——
    ctx.beginPath();
    ctx.ellipse(0, -r * 0.34, r * 0.16, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(16,20,40,0.88)'; ctx.fill();
    ctx.lineWidth = r * 0.05; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-r * 0.05, -r * 0.44, r * 0.06, r * 0.12, -0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();

    // —— 尾喷口 ——
    ctx.fillStyle = 'rgba(10,12,26,0.75)';
    ctx.beginPath(); ctx.ellipse(-r * 0.14, r * 0.84, r * 0.08, r * 0.06, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(r * 0.14, r * 0.84, r * 0.08, r * 0.06, 0, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // —— 护盾：金色能量环 ——
    if (shield) {
      const t = (Math.sin(Date.now() / 300) + 1) / 2;
      ctx.save();
      const sg = ctx.createRadialGradient(x, y, r * 1.1, x, y, r * 1.55);
      sg.addColorStop(0, 'rgba(255,215,0,0)');
      sg.addColorStop(0.6, `rgba(255,215,0,${0.18 + 0.12 * t})`);
      sg.addColorStop(1, 'rgba(255,215,0,0)');
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(x, y, r * 1.55, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r * (1.36 + 0.05 * t), 0, Math.PI * 2);
      ctx.lineWidth = r * 0.16;
      ctx.strokeStyle = `rgba(255,215,0,${0.7 + 0.3 * t})`;
      ctx.stroke();
      // 盾牌小标
      ctx.fillStyle = `rgba(255,216,64,${0.85 + 0.15 * t})`;
      shieldPath(ctx, x + r * 1.05, y - r * 1.05, r * 0.3);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ================= 可走飞机的顶层标记 =================
   * 必须画在所有飞机之上（drawPlane 之后统一调用），否则会被机身盖掉。
   * 四重视觉叠加，总有一款能抓住眼睛：
   *   ① 呼吸双色外环  ② 旋转行进虚线环  ③ 上方跳动的下指箭头  ④ 序号徽章（对应键盘 1-4）
   * 配色统一：亮金 #ffd34d 主体 + 深褐 #7a3e00 描边 —— 深描边是在浅色棋盘上能看清的关键。
   */
  function drawMovableMark(ctx, x, y, r, pulse, idx) {
    const t = Date.now() / 1000;
    ctx.save();

    // ① 呼吸外环：深褐打底（撑轮廓）+ 亮金覆上（提亮）
    const rr = r * (1.52 + 0.1 * pulse);
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.6, r * 0.2);
    ctx.strokeStyle = `rgba(122,62,0,${0.28 + 0.24 * pulse})`;
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.2, r * 0.11);
    ctx.strokeStyle = `rgba(255,214,92,${0.85 + 0.15 * pulse})`;
    ctx.stroke();

    // ② 旋转行进虚线环（marching ants）—— 动感最强，余光也能察觉
    ctx.save();
    ctx.setLineDash([r * 0.30, r * 0.24]);
    ctx.lineDashOffset = -((t * r * 1.6) % (r * 0.54));
    ctx.lineWidth = Math.max(1.4, r * 0.13);
    ctx.strokeStyle = 'rgba(122,62,0,0.85)';
    ctx.beginPath(); ctx.arc(x, y, r * 1.24, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ③ 跳动的下指箭头。上方顶到画布边缘时翻到飞机下方（箭头仍指向飞机），避免被裁掉
    const bob = Math.sin(t * 4) * r * 0.12;
    const below = (y - r * 2.25 < 4) && (y + r * 2.25 < _size - 4);
    const ay = below ? y + r * 1.74 - bob : y - r * 1.74 + bob;
    ctx.save();
    ctx.translate(x, ay);
    if (below) ctx.scale(1, -1);
    ctx.beginPath();
    ctx.moveTo(0, r * 0.44);
    ctx.lineTo(-r * 0.30, -r * 0.02);
    ctx.lineTo(-r * 0.13, -r * 0.02);
    ctx.lineTo(-r * 0.13, -r * 0.44);
    ctx.lineTo(r * 0.13, -r * 0.44);
    ctx.lineTo(r * 0.13, -r * 0.02);
    ctx.lineTo(r * 0.30, -r * 0.02);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,206,64,${0.9 + 0.1 * pulse})`;
    ctx.strokeStyle = 'rgba(122,62,0,0.9)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.lineJoin = 'round';
    ctx.fill(); ctx.stroke();
    ctx.restore();

    // ④ 序号徽章（键盘 1-4 直选），夹在画布内免得出界
    const brr = r * 0.36;
    const pad = brr + 3;
    const bx = Math.min(Math.max(x + r * 1.30, pad), _size - pad);
    const by = Math.min(Math.max(y - r * 1.26, pad), _size - pad);
    ctx.beginPath(); ctx.arc(bx, by, brr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(122,62,0,0.95)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.strokeStyle = `rgba(255,226,140,${0.8 + 0.2 * pulse})`;
    ctx.stroke();
    ctx.fillStyle = '#fff6d8';
    ctx.font = `700 ${Math.round(brr * 1.32)}px ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(idx), bx, by + brr * 0.06);

    ctx.restore();
  }

  let _size = 0;

  /* ================= 棋盘底图 ================= */
  function drawBoardBase(ctx, size, cell, myColor) {
    _size = size;
    ctx.clearRect(0, 0, size, size);

    // 背景：明亮科技渐变 + 中心光晕
    const bg = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.78);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.55, '#eef2fd');
    bg.addColorStop(1, '#dbe3f8');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // 细点阵纹理
    ctx.save();
    ctx.fillStyle = 'rgba(80,100,190,0.10)';
    for (let i = 1; i < GRID; i++) {
      for (let j = 1; j < GRID; j++) {
        ctx.fillRect(i * cell - 0.5, j * cell - 0.5, 1, 1);
      }
    }
    ctx.restore();

    // 四色领地色域（跟随各颜色基地所在的边，一眼分清四方地盘）
    COLORS.forEach((color) => {
      const [bc, br, bw, bh] = rotBox(BASE_BOX[color]);
      const bx = (bc + bw / 2) * cell, by = (br + bh / 2) * cell;
      const g = ctx.createRadialGradient(bx, by, cell * 0.4, bx, by, cell * 4.6);
      g.addColorStop(0, rgba(TILE_HEX[color], 0.30));
      g.addColorStop(0.55, rgba(TILE_HEX[color], 0.13));
      g.addColorStop(1, rgba(TILE_HEX[color], 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    });

    const pad = cell * 0.07;
    const cs = cell - pad * 2;
    const rad = cell * 0.26;

    // ——— 跑道带：把 52 格连成一条完整环路（先铺底，格子画在上面） ———
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let abs = 0; abs < 52; abs++) {
      const [c, r] = rot(MAIN_PATH[abs]);
      const px = (c + 0.5) * cell, py = (r + 0.5) * cell;
      if (abs === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(58,70,140,0.16)';
    ctx.lineWidth = cell * 1.08;
    ctx.stroke();
    const trackG = ctx.createLinearGradient(0, 0, size, size);
    trackG.addColorStop(0, '#ffffff');
    trackG.addColorStop(1, '#eef2fc');
    ctx.strokeStyle = trackG;
    ctx.lineWidth = cell * 0.98;
    ctx.stroke();
    ctx.restore();

    // ——— 主环 52 格：四色循环（abs%4，与跳格规则一致） ———
    for (let abs = 0; abs < 52; abs++) {
      const [c, r] = rot(MAIN_PATH[abs]);
      const x = c * cell + pad, y = r * cell + pad;
      const ccx = x + cs / 2, ccy = y + cs / 2;
      const cellColor = ABS_COLOR[abs % 4];       // 格子归属色（= 跳格规则里的同色格）
      const cellHex = TILE_HEX[cellColor];
      const isTakeoff = (abs % 13) === 0;         // 起飞点（也是安全格）
      const isFly = !!FLY_ABS[abs];               // 飞行箭头格
      const isItem = ITEM_CELLS.indexOf(abs) >= 0; // v3 道具格
      // 运动方向（指向下一格）
      const [nc, nr] = rot(MAIN_PATH[(abs + 1) % 52]);
      const dirA = Math.atan2((nr + 0.5) * cell - ccy, (nc + 0.5) * cell - ccx);

      if (isTakeoff) {
        // 起飞点：饱和实底 + 跑道环 + 白飞机 + 安全金星
        glassCell(ctx, x, y, cs, cs, rad, cellHex, 1);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.38)';
        ctx.lineWidth = Math.max(1, cell * 0.045);
        ctx.beginPath(); ctx.arc(ccx, ccy, cs * 0.33, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(ccx, ccy, cs * 0.44, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.translate(ccx, ccy);
        ctx.rotate(dirA + Math.PI / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        planeSilhouette(ctx, 0, 0, cs * 0.2);
        ctx.fill();
        ctx.restore();
        // 安全格金星角标
        ctx.save();
        starPath(ctx, x + cs * 0.79, y + cs * 0.22, cs * 0.13, cs * 0.055);
        ctx.fillStyle = '#ffe27a';
        ctx.fill();
        ctx.lineWidth = Math.max(0.8, cell * 0.02);
        ctx.strokeStyle = 'rgba(146,100,0,0.55)';
        ctx.stroke();
        ctx.restore();
      } else if (isFly) {
        // 飞行格：饱和色 + 白飞机（虚线航线见下方统一绘制）
        glassCell(ctx, x, y, cs, cs, rad, light(cellHex, 0.12), 1);
        ctx.save();
        ctx.translate(ccx, ccy);
        ctx.rotate(dirA + Math.PI / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        planeSilhouette(ctx, 0, -cs * 0.02, cs * 0.22);
        ctx.fill();
        ctx.restore();
      } else if (isItem) {
        // v3 道具格：紫罗兰玻璃格 + 白色礼物图标
        glassCell(ctx, x, y, cs, cs, rad, '#9b6cff', 1);
        ctx.save();
        ctx.translate(ccx, ccy);
        const gs = cs * 0.26;
        ctx.fillStyle = 'rgba(255,255,255,0.96)';
        roundRect(ctx, -gs, -gs * 0.18, gs * 2, gs * 1.2, gs * 0.18);
        ctx.fill();
        ctx.fillStyle = 'rgba(155,108,255,0.95)';
        ctx.fillRect(-gs * 0.22, -gs * 0.18, gs * 0.44, gs * 1.2);
        ctx.fillRect(-gs, gs * 0.24, gs * 2, gs * 0.32);
        // 蝴蝶结
        ctx.beginPath();
        ctx.moveTo(0, -gs * 0.18); ctx.lineTo(-gs * 0.5, -gs * 0.66); ctx.lineTo(-gs * 0.12, -gs * 0.26);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, -gs * 0.18); ctx.lineTo(gs * 0.5, -gs * 0.66); ctx.lineTo(gs * 0.12, -gs * 0.26);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        // 普通同色格：整块归属色（中饱和，整圈形成彩色环）+ 跳格方向小箭头
        glassCell(ctx, x, y, cs, cs, rad, light(cellHex, 0.22), 1);
        ctx.save();
        ctx.translate(ccx, ccy);
        ctx.rotate(dirA);
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath();
        ctx.moveTo(cs * 0.16, 0);
        ctx.lineTo(-cs * 0.1, -cs * 0.15);
        ctx.lineTo(-cs * 0.02, 0);
        ctx.lineTo(-cs * 0.1, cs * 0.15);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      // 统一描边
      roundRect(ctx, x, y, cs, cs, rad);
      ctx.lineWidth = Math.max(1, cell * 0.035);
      ctx.strokeStyle = isTakeoff ? rgba(dark(cellHex, 0.3), 0.9)
        : isFly ? 'rgba(20,170,210,0.85)'
        : rgba(dark(cellHex, 0.22), 0.65);
      ctx.stroke();
    }

    // ——— 归航道（实色由浅到饱和，末端画箭头） ———
    COLORS.forEach((color) => {
      const hex = TILE_HEX[color];
      const lane = LANES[color].lane;
      lane.forEach(([c0, r0], i) => {
        const [c, r] = rot([c0, r0]);
        const x = c * cell + pad, y = r * cell + pad;
        const t = i / (lane.length - 1);
        glassCell(ctx, x, y, cs, cs, rad, light(hex, 0.52 - 0.44 * t), 1);
        // 指向下一格的箭头
        const nxt = lane[i + 1] ? rot(lane[i + 1]) : rot(LANES[color].home);
        const dx = (nxt[0] + 0.5) * cell - (c + 0.5) * cell;
        const dy = (nxt[1] + 0.5) * cell - (r + 0.5) * cell;
        const a = Math.atan2(dy, dx);
        ctx.save();
        ctx.translate(x + cs / 2, y + cs / 2);
        ctx.rotate(a);
        ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.45 * t})`;
        ctx.beginPath();
        ctx.moveTo(cs * 0.2, 0);
        ctx.lineTo(-cs * 0.06, -cs * 0.16);
        ctx.lineTo(-cs * 0.02, 0);
        ctx.lineTo(-cs * 0.06, cs * 0.16);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        roundRect(ctx, x, y, cs, cs, rad);
        ctx.lineWidth = Math.max(1, cell * 0.04);
        ctx.strokeStyle = rgba(dark(hex, 0.15), 0.55);
        ctx.stroke();
      });
    });

    // ——— 中心终点区：四色风车 + 徽章 ———
    const cx = (GRID / 2) * cell, cy = (GRID / 2) * cell, R = cell * 1.52;
    ctx.save();
    // 外圈光晕
    const halo = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 1.25);
    halo.addColorStop(0, 'rgba(124,92,255,0.14)');
    halo.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2); ctx.fill();

    for (let i = 0; i < 4; i++) {
      const hex = TILE_HEX[COLORS[i]];
      const a0 = Math.PI / 2 * i - Math.PI / 4, a1 = a0 + Math.PI / 2;
      const sg = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R);
      sg.addColorStop(0, rgba(light(hex, 0.35), 0.95));
      sg.addColorStop(1, rgba(hex, 0.85));
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.lineWidth = Math.max(1, cell * 0.04);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();
    }
    // 中心徽章：白瓷 + 金边 + 金星
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.42, 0, Math.PI * 2);
    const mg = ctx.createLinearGradient(cx, cy - R * 0.42, cx, cy + R * 0.42);
    mg.addColorStop(0, '#ffffff');
    mg.addColorStop(1, '#dde4f8');
    ctx.fillStyle = mg; ctx.fill();
    ctx.lineWidth = Math.max(1.4, cell * 0.06);
    ctx.strokeStyle = 'rgba(230,160,20,0.95)';
    ctx.stroke();
    ctx.save();
    starPath(ctx, cx, cy, R * 0.24, R * 0.1);
    const stG = ctx.createLinearGradient(cx, cy - R * 0.24, cx, cy + R * 0.24);
    stG.addColorStop(0, '#ffd34d');
    stG.addColorStop(1, '#f29b1c');
    ctx.fillStyle = stG;
    ctx.fill();
    ctx.lineWidth = Math.max(0.8, cell * 0.025);
    ctx.strokeStyle = 'rgba(150,95,0,0.6)';
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // ——— 四色 home 停机坪 ———
    COLORS.forEach((color) => {
      const [hc, hr] = rot(LANES[color].home);
      const hx = (hc + 0.5) * cell, hy = (hr + 0.5) * cell;
      ctx.save();
      ctx.beginPath(); ctx.arc(hx, hy, cell * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
      ctx.lineWidth = Math.max(1.4, cell * 0.055);
      ctx.strokeStyle = rgba(TILE_HEX[color], 0.9);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, cell * 0.29, 0, Math.PI * 2);
      ctx.fillStyle = rgba(light(TILE_HEX[color], 0.5), 0.5); ctx.fill();
      ctx.restore();
    });

    // ——— 基地：实心机库 + 白色停机位 ———
    COLORS.forEach((color) => {
      const hex = TILE_HEX[color];
      const [bc, br, bw, bh] = rotBox(BASE_BOX[color]);
      const x = bc * cell, y = br * cell, w = bw * cell, h = bh * cell;

      // 实心底：饱和渐变 + 深描边
      const bgg = ctx.createLinearGradient(x, y, x, y + h);
      bgg.addColorStop(0, light(hex, 0.2));
      bgg.addColorStop(0.52, hex);
      bgg.addColorStop(1, dark(hex, 0.22));
      roundRect(ctx, x + pad, y + pad, w - pad * 2, h - pad * 2, cell * 0.34);
      ctx.fillStyle = bgg; ctx.fill();
      ctx.lineWidth = Math.max(1.8, cell * 0.07);
      ctx.strokeStyle = rgba(dark(hex, 0.42), 0.95);
      ctx.stroke();
      // 顶部高光 + 中央白色水印飞机
      ctx.save();
      roundRect(ctx, x + pad, y + pad, w - pad * 2, h - pad * 2, cell * 0.34);
      ctx.clip();
      const hl = ctx.createLinearGradient(x, y, x, y + h * 0.55);
      hl.addColorStop(0, 'rgba(255,255,255,0.30)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(x, y, w, h * 0.55);
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = '#ffffff';
      planeSilhouette(ctx, x + w / 2, y + h / 2, Math.min(w, h) * 0.34);
      ctx.fill();
      ctx.restore();

      // 4 个白色停机位
      BASE_SLOTS[color].forEach(([c0, r0]) => {
        const [c, r] = rot([c0, r0]);
        const px = (c + 0.5) * cell, py = (r + 0.5) * cell;
        const pr = cell * 0.34;
        const pg = ctx.createRadialGradient(px, py - pr * 0.3, pr * 0.12, px, py, pr);
        pg.addColorStop(0, '#ffffff');
        pg.addColorStop(1, '#e6ebfa');
        ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = pg; ctx.fill();
        ctx.lineWidth = Math.max(1.4, cell * 0.055);
        ctx.strokeStyle = rgba(dark(hex, 0.28), 0.9);
        ctx.stroke();
        // 停机位十字
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = rgba(dark(hex, 0.1), 0.8);
        ctx.lineWidth = Math.max(1, cell * 0.035);
        ctx.beginPath();
        ctx.moveTo(px - pr * 0.4, py); ctx.lineTo(px + pr * 0.4, py);
        ctx.moveTo(px, py - pr * 0.4); ctx.lineTo(px, py + pr * 0.4);
        ctx.stroke();
        ctx.restore();
      });
    });

    // ——— 自己的基地：脉冲高亮光圈（一眼找到「我的颜色在哪」） ———
    if (myColor && BASE_BOX[myColor]) {
      const hex = TILE_HEX[myColor];
      const [bc, br, bw, bh] = rotBox(BASE_BOX[myColor]);
      const x = bc * cell, y = br * cell, w = bw * cell, h = bh * cell;
      const t = (Math.sin(Date.now() / 380) + 1) / 2;
      ctx.save();
      // 外发光
      ctx.shadowColor = rgba(hex, 0.85);
      ctx.shadowBlur = cell * (0.5 + 0.35 * t);
      roundRect(ctx, x - pad * 0.6, y - pad * 0.6, w + pad * 1.2, h + pad * 1.2, cell * 0.42);
      ctx.lineWidth = Math.max(2, cell * 0.075);
      ctx.strokeStyle = rgba('#ffffff', 0.95);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 第二圈彩色呼吸环
      roundRect(ctx, x - pad * 1.6, y - pad * 1.6, w + pad * 3.2, h + pad * 3.2, cell * 0.5);
      ctx.lineWidth = Math.max(1.4, cell * 0.05);
      ctx.strokeStyle = rgba(hex, 0.35 + 0.4 * t);
      ctx.stroke();
      ctx.restore();
    }

    // ——— 飞行航线：连接飞行起点与落点的虚线弧（经典飞行棋棋盘标志元素） ———
    COLORS.forEach((color) => {
      const absS = (COLOR_OFFSET[color] + FLY_RP) % 52;
      const absE = (absS + FLY_DIST) % 52;
      const [sc, sr] = rot(MAIN_PATH[absS]);
      const [ec, er] = rot(MAIN_PATH[absE]);
      const sx = (sc + 0.5) * cell, sy = (sr + 0.5) * cell;
      const ex = (ec + 0.5) * cell, ey = (er + 0.5) * cell;
      // 弧顶向棋盘中心方向弯
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      const qx = mx + (size / 2 - mx) * 0.34;
      const qy = my + (size / 2 - my) * 0.34;
      ctx.save();
      ctx.setLineDash([cell * 0.18, cell * 0.14]);
      ctx.lineWidth = Math.max(1.4, cell * 0.05);
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(TILE_HEX[color], 0.5);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(qx, qy, ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      // 落点箭头（沿弧的切线方向）
      const t = 0.96;
      const bx = (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * qx + t * t * ex;
      const by = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * qy + t * t * ey;
      const a = Math.atan2(ey - by, ex - bx);
      ctx.translate(ex, ey);
      ctx.rotate(a);
      ctx.fillStyle = rgba(TILE_HEX[color], 0.75);
      ctx.beginPath();
      ctx.moveTo(cell * 0.1, 0);
      ctx.lineTo(-cell * 0.14, -cell * 0.11);
      ctx.lineTo(-cell * 0.14, cell * 0.11);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  /* ================= 特效层 ================= */
  function drawFx(ctx, fx, cell) {
    const t = Math.max(0, Math.min(1, fx.t));
    ctx.save();
    if (fx.type === 'kill') {
      // 冲击波双环
      for (let i = 0; i < 2; i++) {
        const tt = Math.max(0, t - i * 0.18);
        ctx.globalAlpha = Math.max(0, (1 - tt) * (1 - i * 0.35));
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, cell * (0.25 + tt * (1.1 + i * 0.5)), 0, Math.PI * 2);
        ctx.lineWidth = cell * 0.13 * (1 - tt);
        ctx.strokeStyle = i ? '#ffd34d' : '#ff9f43';
        ctx.stroke();
      }
      // 中心闪光
      ctx.globalAlpha = Math.max(0, 0.9 - t * 1.8);
      const g = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, cell * 0.62);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.5, 'rgba(255,220,120,0.6)');
      g.addColorStop(1, 'rgba(255,140,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, cell * 0.62, 0, Math.PI * 2); ctx.fill();
      // 碎片
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = '#ffb648';
      for (let i = 0; i < 7; i++) {
        const a = (Math.PI * 2 * i) / 7 + t * 1.5;
        const d = cell * (0.2 + t * 1.1);
        ctx.beginPath();
        ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, cell * 0.07 * (1 - t), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (fx.type === 'takeoff') {
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, cell * 0.3 + t * cell * 1.0, 0, Math.PI * 2);
      ctx.lineWidth = cell * 0.11 * (1 - t);
      ctx.strokeStyle = '#7df9ff';
      ctx.stroke();
      ctx.globalAlpha = Math.max(0, 0.7 - t);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, cell * 0.22 + t * cell * 0.5, 0, Math.PI * 2);
      ctx.lineWidth = cell * 0.07 * (1 - t);
      ctx.strokeStyle = '#c9fbff';
      ctx.stroke();
    } else if (fx.type === 'home') {
      ctx.globalAlpha = Math.max(0, 1 - t * 0.9);
      const g = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, cell * 0.9);
      g.addColorStop(0, 'rgba(255,224,130,0.85)');
      g.addColorStop(1, 'rgba(255,200,60,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, cell * 0.9, 0, Math.PI * 2); ctx.fill();
      // 四角星
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = '#ffe066';
      ctx.save();
      ctx.translate(fx.x, fx.y);
      ctx.rotate(t * 0.6);
      const s = cell * (0.35 + t * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.16, -s * 0.16, s, 0);
      ctx.quadraticCurveTo(s * 0.16, s * 0.16, 0, s);
      ctx.quadraticCurveTo(-s * 0.16, s * 0.16, -s, 0);
      ctx.quadraticCurveTo(-s * 0.16, -s * 0.16, 0, -s);
      ctx.fill();
      ctx.restore();
    } else if (fx.type === 'shield') {
      ctx.globalAlpha = Math.max(0, 1 - t);
      shieldPath(ctx, fx.x, fx.y, cell * (0.3 + t * 0.55));
      ctx.lineWidth = cell * 0.1;
      ctx.strokeStyle = '#ffd700';
      ctx.stroke();
      ctx.fillStyle = `rgba(255,215,0,${0.3 * (1 - t)})`;
      shieldPath(ctx, fx.x, fx.y, cell * (0.3 + t * 0.55));
      ctx.fill();
    }
    ctx.restore();
  }

  /* ================= 对外 ================= */
  function computePositions(game, cell) {
    const map = {};
    if (!game || !game.players) return map;
    game.players.forEach((p) => {
      p.planes.forEach((pl) => {
        const st = pl.state;
        let off = [0, 0];
        let g0;
        if (st === 'base') {
          g0 = BASE_SLOTS[p.color][pl.id];
        } else {
          g0 = planeGrid(p.color, st, pl.rp);
          if (st === 'finished' || st === 'home') off = HOME_OFF[pl.id] || [0, 0];
        }
        if (!g0) return;
        const g = rot(g0);
        map[p.seat + '-' + pl.id] = {
          x: (g[0] + 0.5 + off[0]) * cell,
          y: (g[1] + 0.5 + off[1]) * cell,
          color: p.color, state: st,
        };
      });
    });
    return map;
  }

  function isMovablePlane(ui, seat, pid) {
    return !!(ui && ui.phase === 'selecting' && ui.currentSeat === seat
      && ui.movable && ui.movable.indexOf(pid) >= 0);
  }

  function drawScene(canvas, game, ui, posOverride, fx) {
    ui = ui || {};
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    _size = size;
    const cell = size / GRID;
    const myPlayer = game && game.players && ui.mySeat >= 0 ? game.players[ui.mySeat] : null;
    drawBoardBase(ctx, size, cell, myPlayer ? myPlayer.color : null);

    const real = computePositions(game, cell);
    const r = cell * 0.34;
    const hitboxes = [];
    const marks = [];
    const pulse = (Math.sin(Date.now() / 220) + 1) / 2;
    // 轮到我选机：把不能动的飞机压暗，用对比把可走的「顶」出来
    const dimOthers = !posOverride && ui.phase === 'selecting'
      && ui.mySeat >= 0 && ui.currentSeat === ui.mySeat;
    // 上下跳动幅度（仅静止帧；走子动画期间不跳，免得边飞边抖）
    const bobAmp = Math.abs(Math.sin(Date.now() / 300)) * r * 0.17;

    Object.keys(real).forEach((key) => {
      const info = real[key];
      const pos = (posOverride && posOverride[key]) || info;
      const ids = key.split('-');
      const seat = Number(ids[0]), pid = Number(ids[1]);
      const isMine = ui.mySeat === seat;
      const movable = isMovablePlane(ui, seat, pid);
      const pObj = game && game.players && game.players[seat]
        ? game.players[seat].planes.find((p) => p.id === pid) : null;
      const isHome = info.state === 'home' || info.state === 'finished';
      const bob = (movable && !posOverride) ? -bobAmp : 0;

      ctx.save();
      // 自己的不可走飞机重压（聚焦「我这架能不能走」），对手的轻压（不挡读盘）
      if (dimOthers && !movable) ctx.globalAlpha = isMine ? 0.5 : 0.82;
      drawPlane(ctx, pos.x, pos.y + bob, isHome ? r * 0.66 : r,
        info.color, isMine, movable, pulse, pObj && pObj.shield);
      ctx.restore();

      if (movable && !posOverride) {
        hitboxes.push({ seat, planeId: pid, x: info.x, y: info.y, r: r * 1.4 });
        marks.push({ seat, pid, x: info.x, y: info.y + bob, pr: isHome ? r * 0.66 : r });
      }
    });

    // 顶层标记最后统一画：序号按 planeId 升序，保证编号稳定不乱跳
    marks.sort((a, b) => a.pid - b.pid);
    marks.forEach((m, i) => drawMovableMark(ctx, m.x, m.y, m.pr, pulse, i + 1));

    // v3 道具选目标高亮：红环 + 行进虚线（区别于金色「可走」标记）
    if (ui && ui.highlight && ui.highlight.length) {
      const pulse2 = (Math.sin(Date.now() / 200) + 1) / 2;
      ui.highlight.forEach((h) => {
        const info = real[h.seat + '-' + h.planeId];
        if (!info) return;
        const r = cell * (info.state === 'home' || info.state === 'finished' ? 0.22 : 0.34);
        ctx.save();
        ctx.beginPath(); ctx.arc(info.x, info.y, r * 1.5, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, r * 0.18);
        ctx.strokeStyle = `rgba(255,72,72,${0.55 + 0.4 * pulse2})`;
        ctx.setLineDash([r * 0.28, r * 0.22]);
        ctx.lineDashOffset = -((Date.now() / 100) % 100);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      });
    }

    if (fx) drawFx(ctx, fx, cell);
    return hitboxes;
  }

  function computeHitboxes(game, ui, cell) {
    const real = computePositions(game, cell || 0);
    const r = (cell || 0) * 0.34;
    const out = [];
    Object.keys(real).forEach((key) => {
      const ids = key.split('-');
      const seat = Number(ids[0]), pid = Number(ids[1]);
      if (isMovablePlane(ui, seat, pid)) {
        out.push({ seat, planeId: pid, x: real[key].x, y: real[key].y, r: r * 1.4 });
      }
    });
    // 与棋盘徽章编号保持一致（按 planeId 升序），键盘 1-4 才能对得上
    out.sort((a, b) => a.planeId - b.planeId);
    return out;
  }

  global.Board = {
    GRID, COLORS, COLOR_OFFSET, COLOR_HEX, COLOR_NAME, TILE_HEX,
    MAIN_PATH, LANES, BASE_SLOTS, BASE_BOX, SAFE_CELLS, FLY_ABS, ITEM_CELLS,
    setRotation, setMyView, rot, rotBox, setSkin,
    computePositions, computeHitboxes, drawScene,
  };
})(window);
