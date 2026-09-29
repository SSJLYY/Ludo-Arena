/**
 * 极简二维码生成器（Byte 模式 / 纠错等级 L / 自动选版本 1~10）
 * 只做我们需要的事：把一段短 URL 变成布尔矩阵，交给 Canvas 画。
 * 对外：QR.make(text) -> { size, modules[size][size] }  true = 黑
 */
(function (window) {
  'use strict';

  // ---------- GF(256) 伽罗华域，本原多项式 0x11d ----------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // 生成多项式（度数 = EC 码字数）
  function rsPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsPoly(ecLen);
    const res = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
      }
    }
    return res;
  }

  // ---------- 版本表（仅纠错等级 L）----------
  // [总数据码字, 每块EC码字, 分块 [[块数,每块数据码字], ...]]
  const VER = {
    1: [19, 7, [[1, 19]]],
    2: [34, 10, [[1, 34]]],
    3: [55, 15, [[1, 55]]],
    4: [80, 20, [[1, 80]]],
    5: [108, 26, [[1, 108]]],
    6: [136, 18, [[2, 68]]],
    7: [156, 20, [[2, 78]]],
    8: [194, 24, [[2, 97]]],
    9: [232, 30, [[2, 116]]],
    10: [274, 18, [[2, 68], [2, 69]]],
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }

  // ---------- 位流 ----------
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function buildData(bytes, ver) {
    const [totalData] = VER[ver];
    const buf = new BitBuf();
    buf.put(0b0100, 4);                        // Byte 模式
    buf.put(bytes.length, ver <= 9 ? 8 : 16);  // 字符计数
    for (const b of bytes) buf.put(b, 8);
    const cap = totalData * 8;
    // 结束符 + 补齐到字节
    const term = Math.min(4, cap - buf.bits.length);
    for (let i = 0; i < term; i++) buf.bits.push(0);
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);
    // 填充码字 0xEC / 0x11 交替
    const pads = [0xec, 0x11];
    let pi = 0;
    while (buf.bits.length < cap) { buf.put(pads[pi++ % 2], 8); }
    // 转字节
    const cw = [];
    for (let i = 0; i < buf.bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
      cw.push(v);
    }
    return cw;
  }

  // 分块 + 交织
  function interleave(cw, ver) {
    const [, ecLen, groups] = VER[ver];
    const dataBlocks = [];
    const ecBlocks = [];
    let p = 0;
    for (const [cnt, len] of groups) {
      for (let i = 0; i < cnt; i++) {
        const d = cw.slice(p, p + len); p += len;
        dataBlocks.push(d);
        ecBlocks.push(rsEncode(d, ecLen));
      }
    }
    const out = [];
    const maxD = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxD; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
    return out;
  }

  // ---------- 矩阵 ----------
  function newMatrix(size) {
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(m, r, c) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = inRing || inCore;
      }
    }
  }

  function placeAlign(m, ver) {
    const pos = ALIGN[ver];
    const size = m.length;
    for (const r of pos) {
      for (const c of pos) {
        // 跳过与定位图案重叠的三处
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const ad = Math.max(Math.abs(dr), Math.abs(dc));
            m[r + dr][c + dc] = (ad !== 1);
          }
        }
      }
    }
  }

  function placeTiming(m) {
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      if (m[6][i] === null) m[6][i] = (i % 2 === 0);
      if (m[i][6] === null) m[i][6] = (i % 2 === 0);
    }
  }

  function reserveFormat(m) {
    const size = m.length;
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === null) m[8][i] = false;
      if (m[i][8] === null) m[i][8] = false;
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
    }
    m[size - 8][8] = true; // 固定暗模块
  }

  function reserveVersion(m, ver) {
    if (ver < 7) return;
    const size = m.length;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        if (m[size - 11 + j][i] === null) m[size - 11 + j][i] = false;
        if (m[i][size - 11 + j] === null) m[i][size - 11 + j] = false;
      }
    }
  }

  // 记录哪些位置是功能区（不可放数据）
  function functionMask(ver, size) {
    const m = newMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlign(m, ver);
    placeTiming(m);
    reserveFormat(m);
    reserveVersion(m, ver);
    const fn = [];
    for (let r = 0; r < size; r++) fn.push(m[r].map((v) => v !== null));
    return { base: m, fn };
  }

  function placeData(m, fn, cwBytes) {
    const size = m.length;
    let bitIdx = 0;
    const total = cwBytes.length * 8;
    const getBit = () => {
      if (bitIdx >= total) return false;
      const b = (cwBytes[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1;
      bitIdx++;
      return b === 1;
    };
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // 跳过竖向时序列
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (fn[row][c]) continue;
          m[row][c] = getBit();
        }
      }
      upward = !upward;
    }
  }

  const MASK_FN = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  // BCH(15,5) 格式信息
  function formatBits(mask) {
    const data = (0b01 << 3) | mask; // 纠错等级 L = 01
    let v = data << 10;
    while (bitLen(v) - 11 >= 0) v ^= 0x537 << (bitLen(v) - 11);
    return ((data << 10) | v) ^ 0x5412;
  }
  function bitLen(n) { let l = 0; while (n !== 0) { l++; n >>>= 1; } return l; }

  function versionBits(ver) {
    let v = ver << 12;
    while (bitLen(v) - 13 >= 0) v ^= 0x1f25 << (bitLen(v) - 13);
    return (ver << 12) | v;
  }

  function applyFormat(m, mask, ver) {
    const size = m.length;
    const bits = formatBits(mask);
    // 竖向副本（第 8 列）
    for (let i = 0; i < 15; i++) {
      const b = ((bits >>> i) & 1) === 1;
      if (i < 6) m[i][8] = b;
      else if (i < 8) m[i + 1][8] = b;
      else m[size - 15 + i][8] = b;
    }
    // 横向副本（第 8 行）
    for (let i = 0; i < 15; i++) {
      const b = ((bits >>> i) & 1) === 1;
      if (i < 8) m[8][size - i - 1] = b;
      else if (i < 9) m[8][15 - i - 1 + 1] = b;
      else m[8][15 - i - 1] = b;
    }
    m[size - 8][8] = true;
    if (ver >= 7) {
      const vb = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const b = ((vb >>> i) & 1) === 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
      }
    }
  }

  // 罚分：越低越好
  function penalty(m) {
    const size = m.length;
    let score = 0;
    // 规则1：同色连续 >=5
    for (let r = 0; r < size; r++) {
      for (const dir of [0, 1]) {
        let run = 1;
        for (let i = 1; i < size; i++) {
          const a = dir ? m[i - 1][r] : m[r][i - 1];
          const b = dir ? m[i][r] : m[r][i];
          if (a === b) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
          else run = 1;
        }
      }
    }
    // 规则2：2x2 同色
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // 规则3：1:1:3:1:1 图案
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 11; c++) {
        let okH = true, okV = true, okH2 = true, okV2 = true;
        for (let k = 0; k < 11; k++) {
          if (m[r][c + k] !== pat[k]) okH = false;
          if (m[r][c + k] !== pat2[k]) okH2 = false;
          if (m[c + k][r] !== pat[k]) okV = false;
          if (m[c + k][r] !== pat2[k]) okV2 = false;
        }
        if (okH) score += 40; if (okH2) score += 40;
        if (okV) score += 40; if (okV2) score += 40;
      }
    }
    // 规则4：黑白比例偏离
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function make(text) {
    const bytes = utf8Bytes(String(text));
    // 选最小可用版本
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const cap = VER[v][0] - (v <= 9 ? 2 : 3); // 模式4bit+计数8/16bit 约占 1.5~2.5 字节，保守减
      if (bytes.length <= cap) { ver = v; break; }
    }
    if (!ver) throw new Error('QR: 内容过长');
    const size = 17 + ver * 4;
    const cw = interleave(buildData(bytes, ver), ver);

    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const { base, fn } = functionMask(ver, size);
      const m = base.map((row) => row.slice());
      placeData(m, fn, cw);
      // 应用掩码（只对数据区）
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!fn[r][c] && MASK_FN[mask](r, c)) m[r][c] = !m[r][c];
        }
      }
      applyFormat(m, mask, ver);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === null) m[r][c] = false;
      const sc = penalty(m);
      if (sc < bestScore) { bestScore = sc; best = m; }
    }
    return { size, modules: best, version: ver };
  }

  /** 直接画到 canvas 2d 上下文：QR.draw(ctx, text, x, y, px, dark, light) */
  function draw(ctx, text, x, y, px, dark, light) {
    const q = make(text);
    const quiet = 2;
    const total = (q.size + quiet * 2) * px;
    ctx.fillStyle = light || '#fff';
    ctx.fillRect(x, y, total, total);
    ctx.fillStyle = dark || '#111';
    for (let r = 0; r < q.size; r++) {
      for (let c = 0; c < q.size; c++) {
        if (q.modules[r][c]) {
          ctx.fillRect(x + (c + quiet) * px, y + (r + quiet) * px, px, px);
        }
      }
    }
    return total;
  }

  window.QR = { make, draw };
})(typeof window !== 'undefined' ? window : global);
