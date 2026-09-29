/**
 * tools/gen-icons.js — v41 PWA PNG 图标生成器（零依赖，可反复运行）
 *
 * 背景：apple-touch-icon 与部分 Android/微信内核不支持 SVG 图标，iOS 加到主屏会
 * 显示网页截图。本脚本按 icon.svg 的几何（圆角矩形对角渐变 + 45° 纸飞机 + 圆心）
 * 逐像素栅格化（4x 超采样抗锯齿），输出：
 *   icon-192.png / icon-512.png        —— manifest "any"
 *   icon-maskable-512.png              —— manifest "maskable"（内容缩到 78% 安全区）
 *   apple-touch-icon.png               —— iOS 主屏图标 180x180
 * PNG 编码用 zlib.deflateSync 手写 IHDR/IDAT/IEND。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'server', 'public');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 场景几何 ----------
const S = 512;
const COS45 = Math.SQRT1_2;
const pts = [[0, -150], [46, -34], [150, -34], [150, 34], [46, 34], [0, 150], [-46, 34], [-150, 34], [-150, -34], [-46, -34]]
  .map(([x, y]) => [x * COS45 - y * COS45 + 256, x * COS45 + y * COS45 + 256]);
let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
const lerp = (a, b, t) => a + (b - a) * t;
const grad = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const BG1 = [0x6a, 0x5c, 0xff], BG2 = [0x00, 0xb4, 0xe6];
const PL1 = [255, 255, 255], PL2 = [0xe8, 0xeb, 0xff];
const STROKE = [0x2a, 0x23, 0x70];
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
  const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}
function polyDist(px, py) {
  let d = 1e9;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    d = Math.min(d, segDist(px, py, x1, y1, x2, y2));
  }
  return d;
}
function inPoly(px, py) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 在源 512 场景中采样一点的颜色；maskableFull=true 时圆角外也铺渐变 */
function sample(sx, sy, maskableFull) {
  // 圆角矩形（rx=112）
  let inside = true;
  const rx = 112;
  const cx = Math.max(rx, Math.min(S - rx, sx)), cy = Math.max(rx, Math.min(S - rx, sy));
  if (Math.hypot(sx - cx, sy - cy) > rx) inside = false;
  if (!inside && !maskableFull) return [0, 0, 0, 0];
  // 背景对角渐变
  let t = (sx / S + sy / S) / 2;
  let col = grad(BG1, BG2, Math.max(0, Math.min(1, t)));
  // 纸飞机：填充（pl 渐变按路径包围盒）+ 描边
  if (inPoly(sx, sy)) {
    const t2 = ((sx - minX) / (maxX - minX) + (sy - minY) / (maxY - minY)) / 2;
    col = grad(PL1, PL2, Math.max(0, Math.min(1, t2)));
  } else if (polyDist(sx, sy) <= 5) col = STROKE;
  // 圆心（盖在飞机上）
  const dc = Math.hypot(sx - 256, sy - 256);
  if (dc <= 17) col = BG1;
  else if (dc <= 23) col = STROKE;
  return [col[0], col[1], col[2], 255];
}
/** 生成 size x size 的 RGBA；maskable=true 输出满幅渐变 + 中心 78% 场景 */
function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const N = 4; // 4x 超采样
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const fx = ((x + (sx + 0.5) / N) / size) * S;
          const fy = ((y + (sy + 0.5) / N) / size) * S;
          // maskable：整个场景缩放到中心 78%，圆角外铺满幅渐变
          const sx2 = maskable ? (fx - 256) / 0.78 + 256 : fx;
          const sy2 = maskable ? (fy - 256) / 0.78 + 256 : fy;
          const c = sample(sx2, sy2, maskable);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const o = (y * size + x) * 4;
      buf[o] = r / (N * N); buf[o + 1] = g / (N * N); buf[o + 2] = b / (N * N); buf[o + 3] = a / (N * N);
    }
  }
  return buf;
}

const jobs = [
  ['icon-512.png', 512, false],
  ['icon-192.png', 192, false],
  ['apple-touch-icon.png', 180, false],
  ['icon-maskable-512.png', 512, true],
];
for (const [name, size, maskable] of jobs) {
  const png = encodePNG(size, size, render(size, maskable));
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('✓ ' + name + ' (' + size + 'x' + size + ', ' + png.length + ' bytes)');
}
