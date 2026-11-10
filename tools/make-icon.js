/* 生成现代风格应用图标：assets/tractor.ico（16~256 多尺寸）
 *
 * 设计：深绿渐变的圆角方块（牌桌）+ 两张交叠的白牌 + 红心。
 * 交叠的双牌对应「拖拉机 = 连对」，小尺寸下也能一眼看出是牌类游戏。
 *
 * 无第三方依赖：超采样抗锯齿自己画，PNG/ICO 编码手写。
 * 用法：node tools/make-icon.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 每个输出像素 4x4 采样

// 调色板
const BG_TOP = [34, 170, 112];
const BG_BOT = [9, 62, 44];
const BACK_CARD = [212, 233, 220];
const FRONT_CARD = [255, 255, 255];
const HEART = [226, 62, 58];

// 形状参数（归一化坐标 0~1）
const BG_RADIUS = 0.225;
const BACK = { cx: 0.445, cy: 0.515, w: 0.345, h: 0.465, r: 0.045, a: -16 * Math.PI / 180 };
const FRONT = { cx: 0.545, cy: 0.485, w: 0.395, h: 0.535, r: 0.052, a: 9 * Math.PI / 180 };
const SHADOW_DX = 0.016, SHADOW_DY = 0.022, SHADOW_ALPHA = 0.18;
const HEART_S = 0.098;

function rotate(dx, dy, a) {
  const c = Math.cos(-a), s = Math.sin(-a);
  return [dx * c - dy * s, dx * s + dy * c];
}

// 圆角矩形有向距离场，<0 表示在内部
function roundRect(px, py, s) {
  let dx = px - s.cx, dy = py - s.cy;
  if (s.a) { const r = rotate(dx, dy, s.a); dx = r[0]; dy = r[1]; }
  const hw = s.w / 2 - s.r, hh = s.h / 2 - s.r;
  const qx = Math.abs(dx) - hw, qy = Math.abs(dy) - hh;
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - s.r;
}

// 经典心形隐函数：(x²+y²-1)³ - x²y³ ≤ 0（y 轴向上）
function inHeart(px, py, cx, cy, s) {
  const x = (px - cx) / s, y = -(py - cy) / s;
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// 单个采样点的颜色（已做 over 合成），返回 null 表示透明
function shade(px, py) {
  let out = null;
  function over(rgb, alpha) {
    if (alpha <= 0) return;
    if (!out) out = [rgb[0], rgb[1], rgb[2], alpha];
    else {
      const a = alpha + out[3] * (1 - alpha);
      out = [
        (rgb[0] * alpha + out[0] * out[3] * (1 - alpha)) / a,
        (rgb[1] * alpha + out[1] * out[3] * (1 - alpha)) / a,
        (rgb[2] * alpha + out[2] * out[3] * (1 - alpha)) / a,
        a
      ];
    }
  }

  // 1) 圆角底 + 上下渐变
  if (roundRect(px, py, { cx: 0.5, cy: 0.5, w: 1, h: 1, r: BG_RADIUS, a: 0 }) <= 0) {
    over(mix(BG_TOP, BG_BOT, Math.min(1, Math.max(0, (py - 0.08) / 0.84))), 1);
  }
  // 2) 后面那张牌
  if (roundRect(px, py, BACK) <= 0) over(BACK_CARD, 1);
  // 3) 前面那张牌的投影
  if (roundRect(px - SHADOW_DX, py - SHADOW_DY, FRONT) <= 0) over([0, 0, 0], SHADOW_ALPHA);
  // 4) 前面那张牌
  if (roundRect(px, py, FRONT) <= 0) over(FRONT_CARD, 1);
  // 5) 红心
  if (roundRect(px, py, FRONT) <= 0 && inHeart(px, py, FRONT.cx, FRONT.cy, HEART_S)) {
    over(HEART, 1);
  }
  return out;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * inv;
          const py = (y + (sy + 0.5) / SS) * inv;
          const c = shade(px, py);
          if (!c) continue;
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
        buf[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return buf;
}

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // 无过滤
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const p = 6 + i * 16;
    head[p] = f.size >= 256 ? 0 : f.size;
    head[p + 1] = f.size >= 256 ? 0 : f.size;
    head[p + 4] = 1;   // 色平面
    head[p + 6] = 32;  // 位深
    head.writeUInt32LE(f.data.length, p + 8);
    head.writeUInt32LE(offset, p + 12);
    offset += f.data.length;
  });
  return Buffer.concat([head].concat(frames.map(f => f.data)));
}

const frames = SIZES.map(function (size) {
  const rgba = render(size);
  const file = png(rgba, size, size);
  if (size === 256) {
    console.log('256x256 PNG:', file.length, 'bytes');
  }
  return { size: size, data: file };
});

const out = path.join(__dirname, '..', 'assets', 'tractor.ico');
fs.writeFileSync(out, ico(frames));
console.log('写入', out, fs.statSync(out).size, 'bytes');
