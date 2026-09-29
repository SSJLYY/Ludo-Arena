// 二维码编码器回环自测：编码 -> 反解 -> 比对原文
global.window = {};
require('./public/js/qr.js');
const QR = global.window.QR;

const VER = {
  1: [19, 7, [[1, 19]]], 2: [34, 10, [[1, 34]]], 3: [55, 15, [[1, 55]]], 4: [80, 20, [[1, 80]]],
  5: [108, 26, [[1, 108]]], 6: [136, 18, [[2, 68]]], 7: [156, 20, [[2, 78]]], 8: [194, 24, [[2, 97]]],
  9: [232, 30, [[2, 116]]], 10: [274, 18, [[2, 68], [2, 69]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const MASK_FN = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function roundTrip(text) {
  const q = QR.make(text);
  const size = q.size, ver = q.version, m = q.modules;
  const chk = (r, c, want, label) => { if (m[r][c] !== want) throw new Error(label + ' @' + r + ',' + c); };
  for (const box of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    chk(box[0] + 3, box[1] + 3, true, 'finder核心');
    chk(box[0] + 1, box[1] + 1, false, 'finder内白环');
    chk(box[0], box[1], true, 'finder外环');
  }
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] !== (i % 2 === 0)) throw new Error('横时序错 ' + i);
    if (m[i][6] !== (i % 2 === 0)) throw new Error('竖时序错 ' + i);
  }
  chk(size - 8, 8, true, '固定暗模块');

  // 反解格式信息
  let fmt = 0;
  for (let i = 14; i >= 0; i--) {
    let b;
    if (i < 6) b = m[i][8]; else if (i < 8) b = m[i + 1][8]; else b = m[size - 15 + i][8];
    fmt |= (b ? 1 : 0) << i;
  }
  const data5 = (fmt ^ 0x5412) >>> 10;
  const ecl = data5 >> 3, mask = data5 & 7;
  if (ecl !== 1) throw new Error('纠错等级反解错 ' + ecl);

  // 重建功能区
  const fn = [];
  for (let i = 0; i < size; i++) fn.push(new Array(size).fill(false));
  const markBox = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true;
  };
  markBox(0, 0, 7, 7); markBox(0, size - 8, 7, size - 1); markBox(size - 8, 0, size - 1, 7);
  for (let i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }
  for (let i = 0; i < 9; i++) { fn[8][i] = true; fn[i][8] = true; }
  for (let i = 0; i < 8; i++) { fn[8][size - 1 - i] = true; fn[size - 1 - i][8] = true; }
  const pos = ALIGN[ver];
  for (const r of pos) for (const c of pos) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    markBox(r - 2, c - 2, r + 2, c + 2);
  }
  if (ver >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { fn[size - 11 + j][i] = true; fn[i][size - 11 + j] = true; }

  // zigzag 取位 + 去掩码
  const bits = []; let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fn[row][c]) continue;
        let v = m[row][c];
        if (MASK_FN[mask](row, c)) v = !v;
        bits.push(v ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }

  // 去交织
  const groups = VER[ver][2];
  const lens = []; for (const g of groups) for (let i = 0; i < g[0]; i++) lens.push(g[1]);
  const blocks = lens.map((l) => new Array(l));
  const maxD = Math.max.apply(null, lens); let p = 0;
  for (let i = 0; i < maxD; i++) for (let b = 0; b < blocks.length; b++) if (i < lens[b]) blocks[b][i] = cw[p++];
  const flat = [].concat.apply([], blocks);

  let bi = 0;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) { const by = flat[bi >> 3]; v = (v << 1) | ((by >>> (7 - (bi & 7))) & 1); bi++; } return v; };
  const mode = rd(4);
  if (mode !== 4) throw new Error('模式错 ' + mode);
  const cnt = rd(ver <= 9 ? 8 : 16);
  const bytes = []; for (let i = 0; i < cnt; i++) bytes.push(rd(8));
  const out = Buffer.from(bytes).toString('utf8');
  if (out !== text) throw new Error('回读不符\n期望: ' + text + '\n实际: ' + out);
  return { ver: ver, size: size, mask: mask };
}

const cases = [
  'http://129.211.29.228/?r=123456',
  'http://129.211.29.228',
  'A',
  'https://example.com/very/long/path/for/testing?a=1&b=2&c=3&d=44444444',
  '飞行棋来一局',
  new Array(151).join('x'),
];
let ok = 0;
for (const t of cases) {
  const r = roundTrip(t);
  console.log('OK v' + r.ver + ' size=' + r.size + ' mask=' + r.mask + '  <- ' + (t.length > 40 ? t.slice(0, 40) + '...' : t));
  ok++;
}
console.log('\nQR 回环测试全过: ' + ok + '/' + cases.length);
const q = QR.make('http://129.211.29.228/?r=123456');
console.log('\n预览 v' + q.version + ':');
for (let r = 0; r < q.size; r++) console.log(q.modules[r].map((v) => (v ? '##' : '  ')).join(''));
