/*
 * Demosaicing and the develop step used for the detailed preview and export.
 * Bilinear, PPG and AHD are ports of LibRaw (src/demosaic/misc_demosaic.cpp and
 * ahd_demosaic.cpp, from dcraw by Dave Coffin; AHD after Hirakawa and Parks).
 * LibRaw (c) LibRaw LLC, LGPL 2.1 / CDDL 1.0.
 *
 * Works on a rectangle of raw data. The image buffer has 4 ushort slots per
 * pixel, like LibRaw's image[][4], so the ported index arithmetic stays the same.
 * Results equal LibRaw's for every pixel further than 5 px from the rectangle edge.
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function demosaicModule(RL) {
  'use strict';

  const fr = Math.fround;
  const CLIP = (x) => (x < 0 ? 0 : x > 65535 ? 65535 : x);
  const LIM = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const ULIM = (x, y, z) => (y < z ? LIM(x, y, z) : LIM(x, z, y));
  const XYZ_RGB = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
  const D65 = [fr(0.95047), 1, fr(1.08883)];

  /**
   * Scaled image (LibRaw scale_colors + pre_interpolate): black subtracted,
   * multiplied by mul[c] (white balance x 65535 / range), clipped to 16 bit.
   * For 3 colour sensors the second green is stored as green.
   */
  function scaled(raw, w, h, fc4, colors, black, mul) {
    const img = new Uint16Array(w * h * 4);
    mul = mul.map(fr); // LibRaw multiplies in single precision
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c4 = fc4[(y & 1) * 2 + (x & 1)];
        let v = raw[i];
        if (v) { v = Math.trunc(fr((v - black[c4]) * mul[c4])); v = v < 0 ? 0 : v > 65535 ? 65535 : v; }
        img[i * 4 + (colors === 3 && c4 === 3 ? 1 : c4)] = v;
      }
    }
    return img;
  }

  function borderInterpolate(img, w, h, fc, colors, border) {
    const sum = new Uint32Array(8);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        if (col === border && row >= border && row < h - border) col = w - border;
        sum.fill(0);
        for (let y = row - 1; y <= row + 1; y++) {
          if (y < 0 || y >= h) continue;
          for (let x = col - 1; x <= col + 1; x++) {
            if (x < 0 || x >= w) continue;
            const f = fc[(y & 1) * 2 + (x & 1)];
            sum[f] += img[(y * w + x) * 4 + f];
            sum[f + 4]++;
          }
        }
        const f = fc[(row & 1) * 2 + (col & 1)];
        for (let c = 0; c < colors; c++) {
          if (c !== f && sum[c + 4]) img[(row * w + col) * 4 + c] = Math.floor(sum[c] / sum[c + 4]);
        }
      }
    }
  }

  function linInterpolate(img, w, h, fc, colors) {
    borderInterpolate(img, w, h, fc, colors, 1);
    const codes = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const f = fc[r * 2 + c];
        const terms = [], sum = [0, 0, 0, 0];
        for (let y = -1; y <= 1; y++) {
          for (let x = -1; x <= 1; x++) {
            const shift = (y === 0) + (x === 0);
            const color = fc[((r + y) & 1) * 2 + ((c + x) & 1)];
            if (color === f) continue;
            terms.push((w * y + x) * 4 + color, shift, color);
            sum[color] += 1 << shift;
          }
        }
        const outs = [];
        for (let k = 0; k < colors; k++) if (k !== f) outs.push(k, sum[k] > 0 ? Math.floor(256 / sum[k]) : 0);
        codes.push({ terms: Int32Array.from(terms), outs: Int32Array.from(outs) });
      }
    }
    const s = [0, 0, 0, 0];
    for (let row = 1; row < h - 1; row++) {
      for (let col = 1; col < w - 1; col++) {
        const { terms, outs } = codes[(row & 1) * 2 + (col & 1)];
        const p = (row * w + col) * 4;
        s[0] = s[1] = s[2] = s[3] = 0;
        for (let i = 0; i < terms.length; i += 3) s[terms[i + 2]] += img[p + terms[i]] << terms[i + 1];
        for (let i = 0; i < outs.length; i += 2) img[p + outs[i]] = (s[outs[i]] * outs[i + 1]) >> 8;
      }
    }
  }

  function ppgInterpolate(img, w, h, fc) {
    const FC = (r, c) => fc[(r & 1) * 2 + (c & 1)];
    const dir = [4, w * 4, -4, -w * 4, 4];
    const ABS = Math.abs;
    borderInterpolate(img, w, h, fc, 3, 3);
    const guess = [0, 0], diff = [0, 0];
    // green layer from gradients and pattern recognition
    for (let row = 3; row < h - 3; row++) {
      let col = 3 + (FC(row, 3) & 1);
      const c = FC(row, col);
      for (; col < w - 3; col += 2) {
        const p = (row * w + col) * 4;
        for (let i = 0; i < 2; i++) {
          const d = dir[i];
          guess[i] = (img[p - d + 1] + img[p + c] + img[p + d + 1]) * 2 - img[p - 2 * d + c] - img[p + 2 * d + c];
          diff[i] = (ABS(img[p - 2 * d + c] - img[p + c]) + ABS(img[p + 2 * d + c] - img[p + c]) + ABS(img[p - d + 1] - img[p + d + 1])) * 3 +
            (ABS(img[p + 3 * d + 1] - img[p + d + 1]) + ABS(img[p - 3 * d + 1] - img[p - d + 1])) * 2;
        }
        const i = diff[0] > diff[1] ? 1 : 0;
        const d = dir[i];
        img[p + 1] = ULIM(guess[i] >> 2, img[p + d + 1], img[p - d + 1]);
      }
    }
    // red and blue for each green pixel
    for (let row = 1; row < h - 1; row++) {
      let col = 1 + (FC(row, 2) & 1);
      let c0 = FC(row, col + 1);
      for (; col < w - 1; col += 2) {
        const p = (row * w + col) * 4;
        let c = c0;
        for (let i = 0; i < 2; c = 2 - c, i++) {
          const d = dir[i];
          img[p + c] = CLIP((img[p - d + c] + img[p + d + c] + 2 * img[p + 1] - img[p - d + 1] - img[p + d + 1]) >> 1);
        }
      }
    }
    // blue for red pixels and vice versa
    for (let row = 1; row < h - 1; row++) {
      let col = 1 + (FC(row, 1) & 1);
      const c = 2 - FC(row, col);
      for (; col < w - 1; col += 2) {
        const p = (row * w + col) * 4;
        for (let i = 0; i < 2; i++) {
          const d = dir[i] + dir[i + 1];
          diff[i] = ABS(img[p - d + c] - img[p + d + c]) + ABS(img[p - d + 1] - img[p + 1]) + ABS(img[p + d + 1] - img[p + 1]);
          guess[i] = img[p - d + c] + img[p + d + c] + 2 * img[p + 1] - img[p - d + 1] - img[p + d + 1];
        }
        if (diff[0] !== diff[1]) img[p + c] = CLIP(guess[diff[0] > diff[1] ? 1 : 0] >> 1);
        else img[p + c] = CLIP((guess[0] + guess[1]) >> 2);
      }
    }
  }

  // ---------------------------------------------------------------- AHD
  const TS = 512;
  let cbrtTab = null;

  function ahdInterpolate(img, w, h, fc, rgbCam) {
    const FC = (r, c) => fc[(r & 1) * 2 + (c & 1)];
    if (!cbrtTab) {
      cbrtTab = new Float32Array(0x10000);
      for (let i = 0; i < 0x10000; i++) {
        const r = fr(i / 65535);
        cbrtTab[i] = r > fr(0.008856) ? Math.pow(r, fr(1 / 3)) : fr(fr(fr(7.787) * r) + fr(16 / 116));
      }
    }
    const xc = new Float32Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let a = 0;
        for (let k = 0; k < 3; k++) a = fr(a + fr(XYZ_RGB[i][k] * rgbCam[k][j] / D65[i]));
        xc[i * 3 + j] = a;
      }
    }
    const cbrt = cbrtTab;
    const x00 = xc[0], x01 = xc[1], x02 = xc[2], x10 = xc[3], x11 = xc[4], x12 = xc[5], x20 = xc[6], x21 = xc[7], x22 = xc[8];
    const c16 = (v) => { v = Math.trunc(v); return v < 0 ? 0 : v > 65535 ? 65535 : v; };
    const half = fr(0.5);
    // rgb at ri (3 values) -> lab at li
    function cielab(rgb, ri, lab, li) {
      const r = rgb[ri], g = rgb[ri + 1], b = rgb[ri + 2];
      const X = cbrt[c16(fr(fr(fr(half + fr(x00 * r)) + fr(x01 * g)) + fr(x02 * b)))];
      const Y = cbrt[c16(fr(fr(fr(half + fr(x10 * r)) + fr(x11 * g)) + fr(x12 * b)))];
      const Z = cbrt[c16(fr(fr(fr(half + fr(x20 * r)) + fr(x21 * g)) + fr(x22 * b)))];
      lab[li] = Math.trunc(fr(64 * fr(fr(116 * Y) - 16)));
      lab[li + 1] = Math.trunc(fr(32000 * fr(X - Y)));
      lab[li + 2] = Math.trunc(fr(12800 * fr(Y - Z)));
    }

    borderInterpolate(img, w, h, fc, 3, 5);
    const rgb = new Uint16Array(2 * TS * TS * 3);
    const lab = new Int16Array(2 * TS * TS * 3);
    const homo = new Uint8Array(TS * TS * 2);
    const D1 = TS * TS * 3; // offset of the vertical direction
    const W4 = w * 4;
    const ld = [0, 0, 0, 0, 0, 0, 0, 0], ad = [0, 0, 0, 0, 0, 0, 0, 0];
    const dirs = [-3, 3, -TS * 3, TS * 3];

    for (let top = 2; top < h - 5; top += TS - 6) {
      for (let left = 2; left < w - 5; left += TS - 6) {
        // green, horizontally and vertically interpolated
        let rowlimit = Math.min(top + TS, h - 2), collimit = Math.min(left + TS, w - 2);
        for (let row = top; row < rowlimit; row++) {
          let col = left + (FC(row, left) & 1);
          const c = FC(row, col);
          for (; col < collimit; col += 2) {
            const p = (row * w + col) * 4;
            const t = ((row - top) * TS + (col - left)) * 3 + 1;
            let val = ((img[p - 4 + 1] + img[p + c] + img[p + 4 + 1]) * 2 - img[p - 8 + c] - img[p + 8 + c]) >> 2;
            rgb[t] = ULIM(val, img[p - 4 + 1], img[p + 4 + 1]);
            val = ((img[p - W4 + 1] + img[p + c] + img[p + W4 + 1]) * 2 - img[p - 2 * W4 + c] - img[p + 2 * W4 + c]) >> 2;
            rgb[D1 + t] = ULIM(val, img[p - W4 + 1], img[p + W4 + 1]);
          }
        }
        // red and blue in both directions, then CIELab
        rowlimit = Math.min(top + TS - 1, h - 3); collimit = Math.min(left + TS - 1, w - 3);
        for (let d = 0; d < 2; d++) {
          const base = d * D1;
          for (let row = top + 1; row < rowlimit; row++) {
            for (let col = left + 1; col < collimit; col++) {
              const p = (row * w + col) * 4;
              const ri = base + ((row - top) * TS + (col - left)) * 3;
              let c = 2 - FC(row, col), val;
              if (c === 1) {
                c = FC(row + 1, col);
                const t1 = 2 - c;
                val = img[p + 1] + ((img[p - 4 + t1] + img[p + 4 + t1] - rgb[ri - 3 + 1] - rgb[ri + 3 + 1]) >> 1);
                rgb[ri + t1] = CLIP(val);
                val = img[p + 1] + ((img[p - W4 + c] + img[p + W4 + c] - rgb[ri - TS * 3 + 1] - rgb[ri + TS * 3 + 1]) >> 1);
              } else {
                val = rgb[ri + 1] + ((img[p - W4 - 4 + c] + img[p - W4 + 4 + c] + img[p + W4 - 4 + c] + img[p + W4 + 4 + c] -
                  rgb[ri - TS * 3 - 3 + 1] - rgb[ri - TS * 3 + 3 + 1] - rgb[ri + TS * 3 - 3 + 1] - rgb[ri + TS * 3 + 3 + 1] + 1) >> 2);
              }
              rgb[ri + c] = CLIP(val);
              c = FC(row, col);
              rgb[ri + c] = img[p + c];
              cielab(rgb, ri, lab, ri);
            }
          }
        }
        // homogeneity map
        homo.fill(0);
        rowlimit = Math.min(top + TS - 2, h - 4); collimit = Math.min(left + TS - 2, w - 4);
        for (let row = top + 2; row < rowlimit; row++) {
          const tr = row - top;
          for (let col = left + 2; col < collimit; col++) {
            const li = (tr * TS + col - left) * 3;
            for (let d = 0; d < 2; d++) {
              const l = d * D1 + li;
              for (let i = 0; i < 4; i++) {
                const a = l + dirs[i];
                ld[d * 4 + i] = Math.abs(lab[l] - lab[a]);
                const da = lab[l + 1] - lab[a + 1], db = lab[l + 2] - lab[a + 2];
                ad[d * 4 + i] = da * da + db * db;
              }
            }
            const leps = Math.min(Math.max(ld[0], ld[1]), Math.max(ld[6], ld[7]));
            const abeps = Math.min(Math.max(ad[0], ad[1]), Math.max(ad[6], ad[7]));
            for (let d = 0; d < 2; d++) {
              let hm = 0;
              for (let i = 0; i < 4; i++) if (ld[d * 4 + i] <= leps && ad[d * 4 + i] <= abeps) hm++;
              homo[(tr * TS + col - left) * 2 + d] = hm;
            }
          }
        }
        // pick the more homogeneous direction
        rowlimit = Math.min(top + TS - 3, h - 5); collimit = Math.min(left + TS - 3, w - 5);
        for (let row = top + 3; row < rowlimit; row++) {
          const tr = row - top;
          for (let col = left + 3; col < collimit; col++) {
            const tc = col - left;
            let h0 = 0, h1 = 0;
            for (let i = tr - 1; i <= tr + 1; i++) {
              for (let j = tc - 1; j <= tc + 1; j++) { const k = (i * TS + j) * 2; h0 += homo[k]; h1 += homo[k + 1]; }
            }
            const p = (row * w + col) * 4;
            const ri = (tr * TS + tc) * 3;
            if (h0 !== h1) {
              const s = h1 > h0 ? D1 + ri : ri;
              img[p] = rgb[s]; img[p + 1] = rgb[s + 1]; img[p + 2] = rgb[s + 2];
            } else {
              for (let c = 0; c < 3; c++) img[p + c] = (rgb[ri + c] + rgb[D1 + ri + c]) >> 1;
            }
          }
        }
      }
    }
  }

  /**
   * job: { raw, w, h, fc4 (channel 0..3 at each 2x2 position of the rect origin),
   *        black[4], mul[4], colors (3 or 4), algo, rgbCam (3x3, AHD only),
   *        crop {x, y, w, h} (optional) }
   * Returns { data: Uint16Array (crop.w * crop.h * colors), w, h, colors }.
   */
  function demosaic(job) {
    const { raw, w, h, fc4, black, mul } = job;
    const colors = job.colors === 4 ? 4 : 3;
    const fc = fc4.map((c) => (colors === 3 && c === 3 ? 1 : c));
    const img = scaled(raw, w, h, fc4, colors, black, mul);
    let algo = job.algo;
    if (colors === 4 || w < 12 || h < 12) algo = 'bilinear';
    if (algo === 'ahd') ahdInterpolate(img, w, h, fc, job.rgbCam);
    else if (algo === 'ppg') ppgInterpolate(img, w, h, fc);
    else linInterpolate(img, w, h, fc, colors);
    const cr = job.crop || { x: 0, y: 0, w, h };
    const out = new Uint16Array(cr.w * cr.h * colors);
    let o = 0;
    for (let y = cr.y; y < cr.y + cr.h; y++) {
      let p = (y * w + cr.x) * 4;
      for (let x = 0; x < cr.w; x++, p += 4) for (let c = 0; c < colors; c++) out[o++] = img[p + c];
    }
    return { data: out, w: cr.w, h: cr.h, colors };
  }

  // ---------------------------------------------------------------- develop

  const curves = new Map();
  /** Transfer curve as a 65537-entry table over linear [0, 1]; the darkest
   *  1/1024 is computed directly (16-bit linear steps are too coarse there). */
  function transfer(kind) {
    let t = curves.get(kind);
    if (t) return t;
    const f = kind === 'srgb'
      ? (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
      : (v) => Math.pow(v, 256 / 563);
    const tab = new Float32Array(65537);
    for (let i = 0; i <= 65536; i++) tab[i] = f(i / 65536);
    t = { f, tab };
    curves.set(kind, t);
    return t;
  }

  /**
   * Camera RGB (demosaic output, white balanced, 0..65535) -> output pixels.
   * dev: { M (3 x colors, camera -> linear output RGB), scale (exposure factor
   *        for the 0..65535 data), luma[3], curve ('srgb' | 'adobe'),
   *        format: 'rgba8' | 'png8' | 'png16' | 'tiff16', orient (1, 3, 6, 8) }
   * The source rect (w x h) is rotated according to orient.
   */
  function develop(src, dev) {
    const { w, h, colors, data } = src;
    const M = dev.M, sc = dev.scale, L = dev.luma;
    const { f, tab } = transfer(dev.curve);
    const lin = new Float32Array(w * h * 3);
    const m = [];
    for (let i = 0; i < 3; i++) for (let c = 0; c < 4; c++) m.push(c < colors ? M[i][c] * sc : 0);
    const enc = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v < 1 / 1024 ? f(v) : tab[(v * 65536 + 0.5) | 0]);
    for (let i = 0, p = 0; i < w * h; i++, p += colors) {
      const a = data[p], b = data[p + 1], c = data[p + 2], d = colors === 4 ? data[p + 3] : 0;
      let r = m[0] * a + m[1] * b + m[2] * c + m[3] * d;
      let g = m[4] * a + m[5] * b + m[6] * c + m[7] * d;
      let bl = m[8] * a + m[9] * b + m[10] * c + m[11] * d;
      const mx = r > g ? (r > bl ? r : bl) : (g > bl ? g : bl);
      if (mx > 1) {
        // over the output range: keep luminance, desaturate towards white
        const Y = L[0] * r + L[1] * g + L[2] * bl;
        if (Y >= 1) { r = g = bl = 1; } else {
          const s = (1 - Y) / (mx - Y);
          r = Y + (r - Y) * s; g = Y + (g - Y) * s; bl = Y + (bl - Y) * s;
        }
      }
      lin[i * 3] = enc(r); lin[i * 3 + 1] = enc(g); lin[i * 3 + 2] = enc(bl);
    }
    // output geometry
    const o = dev.orient || 1;
    const rot = o === 6 || o === 8;
    const ow = rot ? h : w, oh = rot ? w : h;
    // index of the source pixel for output (x, y)
    const srcIdx = o === 3 ? (x, y) => (h - 1 - y) * w + (w - 1 - x)
      : o === 6 ? (x, y) => (h - 1 - x) * w + y
      : o === 8 ? (x, y) => x * w + (w - 1 - y)
      : (x, y) => y * w + x;
    const fmt = dev.format;
    if (fmt === 'rgba8') {
      const out = new Uint8ClampedArray(ow * oh * 4);
      for (let y = 0, q = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++, q += 4) {
          const s = srcIdx(x, y) * 3;
          out[q] = lin[s] * 255 + 0.5; out[q + 1] = lin[s + 1] * 255 + 0.5; out[q + 2] = lin[s + 2] * 255 + 0.5; out[q + 3] = 255;
        }
      }
      return { data: out, w: ow, h: oh };
    }
    if (fmt === 'png8' || fmt === 'png16') {
      // scanlines with a filter byte, Sub filter (1), 16-bit samples big endian
      const bps = fmt === 'png16' ? 2 : 1, bpp = 3 * bps, stride = ow * bpp + 1;
      const out = new Uint8Array(stride * oh);
      const row = new Uint8Array(ow * bpp);
      for (let y = 0; y < oh; y++) {
        for (let x = 0, q = 0; x < ow; x++) {
          const s = srcIdx(x, y) * 3;
          for (let c = 0; c < 3; c++) {
            if (bps === 1) row[q++] = (lin[s + c] * 255 + 0.5) | 0;
            else { const v = (lin[s + c] * 65535 + 0.5) | 0; row[q++] = v >> 8; row[q++] = v & 255; }
          }
        }
        const b = y * stride;
        out[b] = 1;
        for (let i = 0; i < row.length; i++) out[b + 1 + i] = row[i] - (i >= bpp ? row[i - bpp] : 0);
      }
      return { data: out, w: ow, h: oh };
    }
    // tiff16: little endian samples with horizontal differencing (predictor 2)
    const out = new Uint16Array(ow * oh * 3);
    for (let y = 0; y < oh; y++) {
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0, q = y * ow * 3; x < ow; x++, q += 3) {
        const s = srcIdx(x, y) * 3;
        const r = (lin[s] * 65535 + 0.5) | 0, g = (lin[s + 1] * 65535 + 0.5) | 0, b = (lin[s + 2] * 65535 + 0.5) | 0;
        out[q] = r - pr; out[q + 1] = g - pg; out[q + 2] = b - pb;
        pr = r; pg = g; pb = b;
      }
    }
    return { data: out, w: ow, h: oh };
  }

  RL.demosaic = demosaic;
  RL.develop = develop;
});
