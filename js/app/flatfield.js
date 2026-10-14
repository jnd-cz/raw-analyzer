/*
 * Flat-field checks on the raw data (an evenly lit, featureless frame):
 *   - vignetting, from a heavily smoothed copy of the frame
 *   - dust: soft dark spots in the frame divided by that smoothed copy
 *   - shutter: the ratio of two flats at different shutter speeds along the
 *     curtain travel (top to bottom of the sensor), which cancels vignetting,
 *     dust and pixel response
 * All work happens on 2x2-block means (one value per CFA block, black removed).
 */
(function () {
  'use strict';

  /** 2x2-block means above black over the image area: { p: Float32Array, w, h }. */
  function blockPlane(img, levels) {
    const { raw, width: W, cfa } = img;
    const A = img.active;
    const x0 = (A.left + 1) & ~1, y0 = (A.top + 1) & ~1;
    const w = (A.right - x0) >> 1, h = (A.bottom - y0) >> 1;
    const bl = [0, 1, 2, 3].map((p) => levels.black[cfa[((y0 + (p >> 1)) & 1) * 2 + ((x0 + (p & 1)) & 1)]]);
    const blk = (bl[0] + bl[1] + bl[2] + bl[3]) / 4;
    const p = new Float32Array(w * h);
    for (let by = 0; by < h; by++) {
      const o = (y0 + 2 * by) * W + x0, o2 = o + W;
      for (let bx = 0; bx < w; bx++) {
        const x = 2 * bx;
        p[by * w + bx] = (raw[o + x] + raw[o + x + 1] + raw[o2 + x] + raw[o2 + x + 1]) / 4 - blk;
      }
    }
    return { p, w, h, x0, y0 };
  }

  /** Box mean of radius r (edges clamped) through an integral image. */
  function boxMean(p, w, h, r) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += p[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
        const s = I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa];
        out[y * w + x] = s / ((yb - ya) * (xb - xa));
      }
    }
    return out;
  }

  /** Is this a flat field? Neighbouring cells must agree within ~1.5% and the frame must be well exposed. */
  function flatness(pl, levels) {
    const C = 32, cw = Math.floor(pl.w / C), ch = Math.floor(pl.h / C);
    if (cw < 6 || ch < 4) return { flat: false, reason: 'frame too small' };
    const m = new Float64Array(cw * ch);
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let s = 0;
      for (let y = cy * C; y < cy * C + C; y += 2) for (let x = cx * C; x < cx * C + C; x += 2) s += pl.p[y * pl.w + x];
      m[cy * cw + cx] = s / ((C / 2) * (C / 2));
    }
    const devs = [];
    let mean = 0;
    for (const v of m) mean += v;
    mean /= m.length;
    for (let cy = 1; cy < ch - 1; cy++) for (let cx = 1; cx < cw - 1; cx++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) s += m[(cy + dy) * cw + cx + dx];
      devs.push(Math.abs(m[cy * cw + cx] / (s / 8) - 1));
    }
    devs.sort((a, b) => a - b);
    const typical = devs[Math.floor(devs.length * 0.9)];
    const range = levels.white - levels.black.reduce((a, b) => a + b, 0) / 4;
    const level = mean / range;
    // below ~2% of saturation the noise hides faint dust and the structure test fails anyway
    const flat = typical < 0.015 && level > 0.02 && level < 0.97;
    return { flat, typical, level, mean, reason: flat ? '' : level <= 0.02 ? 'the frame is too dark for these checks' : level >= 0.97 ? 'the frame is clipped' : 'the frame has structure (not an even, featureless field)' };
  }

  function analyze(img, levels, sigma) {
    const pl = blockPlane(img, levels);
    const f = flatness(pl, levels);
    if (!f.flat) return { flat: false, reason: f.reason, typical: f.typical, level: f.level };
    const { p, w, h } = pl;
    const R = Math.max(16, Math.round(Math.min(w, h) / 30));
    const base = boxMean(p, w, h, R);
    const small = boxMean(p, w, h, 2);
    const dev = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) dev[i] = base[i] > 1 ? small[i] / base[i] - 1 : 0;

    // vignetting: smoothed level at corners and edge midpoints against the centre
    const at = (fx, fy) => {
      const x = Math.min(w - 1, Math.max(0, Math.round(fx * (w - 1)))), y = Math.min(h - 1, Math.max(0, Math.round(fy * (h - 1))));
      return base[y * w + x];
    };
    const c = at(0.5, 0.5);
    const evAt = (fx, fy) => Math.log2(Math.max(1e-6, at(fx, fy)) / c);
    const e = 0.02;
    const vig = {
      corners: { tl: evAt(e, e), tr: evAt(1 - e, e), bl: evAt(e, 1 - e), br: evAt(1 - e, 1 - e) },
      edges: { top: evAt(0.5, e), bottom: evAt(0.5, 1 - e), left: evAt(e, 0.5), right: evAt(1 - e, 0.5) },
    };

    // noise of the deviation map in smooth areas, robust
    const smp = [];
    for (let i = 0; i < w * h; i += 97) smp.push(dev[i]);
    smp.sort((a, b) => a - b);
    const med = smp[smp.length >> 1];
    const mad = 1.4826 * smp.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[smp.length >> 1];
    const thr = -Math.max(0.004, 5 * mad);

    // dust: connected areas below the threshold (4-neighbour flood fill)
    const lab = new Int32Array(w * h);
    const spots = [];
    const stack = [];
    const MINA = 8;
    for (let i = 0; i < w * h; i++) {
      if (lab[i] || dev[i] >= thr) continue;
      let n = 0, sx = 0, sy = 0, depth = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      lab[i] = 1; stack.push(i);
      while (stack.length) {
        const k = stack.pop();
        const x = k % w, y = (k - x) / w;
        n++; sx += x; sy += y;
        if (dev[k] < depth) depth = dev[k];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !lab[k - 1] && dev[k - 1] < thr) { lab[k - 1] = 1; stack.push(k - 1); }
        if (x < w - 1 && !lab[k + 1] && dev[k + 1] < thr) { lab[k + 1] = 1; stack.push(k + 1); }
        if (y > 0 && !lab[k - w] && dev[k - w] < thr) { lab[k - w] = 1; stack.push(k - w); }
        if (y < h - 1 && !lab[k + w] && dev[k + w] < thr) { lab[k + w] = 1; stack.push(k + w); }
      }
      if (n < MINA) continue;
      // spots right at the frame edge are mostly vignetting residue
      if (x0 <= R / 4 || y0 <= R / 4 || x1 >= w - 1 - R / 4 || y1 >= h - 1 - R / 4) continue;
      spots.push({
        x: pl.x0 + 2 * (sx / n) + 1, y: pl.y0 + 2 * (sy / n) + 1,
        size: 2 * Math.max(x1 - x0 + 1, y1 - y0 + 1), area: n * 4, depth: -depth,
      });
    }
    spots.sort((a, b) => b.depth - a.depth);
    let sd = 0;
    for (let i = 0; i < w * h; i += 13) sd += dev[i] * dev[i];
    return {
      flat: true, level: f.level, typical: f.typical, vig, spots, threshold: -thr, noise: mad,
      uniformity: Math.sqrt(sd / Math.ceil(w * h / 13)),
      map: { dev, w, h, x0: pl.x0, y0: pl.y0 },
    };
  }

  /**
   * Exposure ratio of flat b to flat a along the rows (top to bottom, the
   * curtain travel) and the columns, in EV, normalised to their means.
   * dark: optional { img, levels } subtracted from both.
   */
  function ratioProfiles(imgA, levelsA, imgB, levelsB, n, dark) {
    n = n || 48;
    const a = blockPlane(imgA, levelsA), b = blockPlane(imgB, levelsB);
    // a dark frame (same camera and ISO, lens cap on) removes fixed offsets and
    // row / column patterns that dominate dim, fast frames
    if (dark) {
      const d = blockPlane(dark.img, dark.levels);
      if (d.w === a.w && d.h === a.h && d.w === b.w && d.h === b.h) {
        for (let i = 0; i < d.p.length; i++) { a.p[i] -= d.p[i]; b.p[i] -= d.p[i]; }
      }
    }
    const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
    const rowsA = new Float64Array(n), rowsB = new Float64Array(n), colsA = new Float64Array(n), colsB = new Float64Array(n);
    let sumA = 0, sumB = 0;
    for (let y = 0; y < h; y++) {
      const ry = Math.min(n - 1, Math.floor((y * n) / h));
      for (let x = 0; x < w; x++) {
        const va = a.p[y * a.w + x], vb = b.p[y * b.w + x];
        const rx = Math.min(n - 1, Math.floor((x * n) / w));
        rowsA[ry] += va; rowsB[ry] += vb; colsA[rx] += va; colsB[rx] += vb;
        sumA += va; sumB += vb;
      }
    }
    const k = sumB / sumA;
    const ev = (pb, pa) => Array.from(pb, (v, i) => Math.log2(v / pa[i] / k));
    return { rows: ev(rowsB, rowsA), cols: ev(colsB, colsA), meanA: sumA / (w * h), meanB: sumB / (w * h), ratio: k };
  }

  window.FlatField = { analyze, ratioProfiles };
})();
