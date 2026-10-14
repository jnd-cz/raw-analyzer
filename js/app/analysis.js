/*
 * Raw statistics: per CFA channel histograms (full 16 bit resolution) and the
 * numbers derived from them.
 */
(function () {
  'use strict';

  const CH_NAMES = ['R', 'G', 'B', 'G2'];
  const CH_COLORS = ['#ff5a52', '#4cc96a', '#4d8dff', '#2fb3a6'];
  const ALL_COLOR = '#c4cad2';

  /** Histograms of rect {x0,y0,x1,y1} (exclusive end). */
  function computeHist(img, rect) {
    const { raw, width: W, cfa } = img;
    const hist = [new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536)];
    const x0 = Math.max(0, rect.x0), x1 = Math.min(W, rect.x1);
    const y0 = Math.max(0, rect.y0), y1 = Math.min(img.height, rect.y1);
    for (let y = y0; y < y1; y++) {
      const rowCfa = (y & 1) * 2;
      // even and odd columns are separate passes: no branch in the inner loop
      const hEven = hist[cfa[rowCfa + (x0 & 1)]], hOdd = hist[cfa[rowCfa + ((x0 + 1) & 1)]];
      const o = y * W;
      let x = x0;
      for (; x + 1 < x1; x += 2) { hEven[raw[o + x]]++; hOdd[raw[o + x + 1]]++; }
      if (x < x1) hEven[raw[o + x]]++;
    }
    return { hist, rect: { x0, y0, x1, y1 } };
  }

  function sumHist(hs) {
    const all = new Uint32Array(65536);
    for (const h of hs) for (let i = 0; i < 65536; i++) all[i] += h[i];
    return all;
  }

  /** Statistics of one 65536-bin histogram. black/white are in raw units. */
  function histStats(h, black, white, sigma) {
    let n = 0, s = 0, s2 = 0, min = -1, max = 0;
    for (let v = 0; v < 65536; v++) {
      const k = h[v];
      if (!k) continue;
      if (min < 0) min = v;
      max = v;
      n += k; s += k * v; s2 += k * v * v;
    }
    if (!n) return null;
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    const pct = (p) => {
      const target = n * p;
      let acc = 0;
      for (let v = min; v <= max; v++) { acc += h[v]; if (acc >= target) return v; }
      return max;
    };
    let clipped = 0, under = 0;
    for (let v = Math.max(0, white); v < 65536; v++) clipped += h[v];
    for (let v = 0; v <= Math.min(65535, black); v++) under += h[v];
    const range = white - black;
    const ev = (v) => (v - black > 0 && range > 0 ? Math.log2((v - black) / range) : -Infinity);
    const p999 = pct(0.999), p99 = pct(0.99), median = pct(0.5), p001 = pct(0.001), p10 = pct(0.1);
    const st = {
      n, min, max, mean, sd, median, p001, p10, p99, p999,
      clipped, clippedPct: (100 * clipped) / n,
      under, underPct: (100 * under) / n,
      meanEV: ev(mean), medianEV: ev(median), p99EV: ev(p99), p999EV: ev(p999), maxEV: ev(max),
    };
    // shadows relative to the noise floor (signal measured in read noise sigmas)
    if (sigma > 0) {
      st.sigma = sigma;
      st.floorEV = Math.log2(sigma / Math.max(1, range));
      st.dr = Math.log2(Math.max(1, range) / sigma);
      const below = (k) => {
        let c = 0;
        const lim = Math.min(65535, Math.floor(black + k * sigma));
        for (let v = 0; v <= lim; v++) c += h[v];
        return (100 * c) / n;
      };
      st.floor1 = below(1); st.floor2 = below(2); st.floor4 = below(4); st.floor10 = below(10);
      const snr = (v) => (v - black) / sigma;
      st.medianSNR = snr(median);
      st.p10SNR = snr(p10);
    }
    return st;
  }

  /** stats for the 4 channels + combined "All". sigma: per channel read noise or null. */
  function computeStats(histo, levels, sigma) {
    const out = [];
    for (let c = 0; c < 4; c++) out.push(histStats(histo.hist[c], levels.black[c], levels.white, sigma ? sigma[c] : 0));
    if (!histo.all) histo.all = sumHist(histo.hist);
    const meanBlack = levels.black.reduce((a, b) => a + b, 0) / 4;
    const meanSigma = sigma ? sigma.reduce((a, b) => a + b, 0) / 4 : 0;
    out.push(histStats(histo.all, Math.round(meanBlack), levels.white, meanSigma));
    return out;
  }

  /** Gray world white balance from channel means (black subtracted). */
  function grayWorld(stats, black, colors4) {
    const m = [0, 1, 2, 3].map((c) => (stats[c] ? Math.max(1e-6, stats[c].mean - black[c]) : 1));
    if (colors4) { const avg = (m[0] + m[1] + m[2] + m[3]) / 4; return m.map((v) => avg / v); }
    const g = (m[1] + m[3]) / 2;
    return [g / m[0], 1, g / m[2], 1];
  }

  /**
   * Photon transfer estimate from one natural image.
   * Patches of 8x8 same-colour samples: mean signal and the variance of
   * differences between same-colour neighbours (/2), which cancels smooth
   * gradients. Flat patches give the noise, textured ones only add variance,
   * so a low percentile (10th) per signal bin tracks the noise. Fits
   *   variance = read^2 + signal / gain        (all in DN above black)
   * with the read noise fixed to the masked-border value when available.
   */
  function photonTransfer(img, levels, sigma, opts) {
    opts = opts || {};
    const { raw, width: W, active: A, cfa } = img;
    const white = levels.white;
    const B = 8, NS = B * B;
    const means = [], vars = [];
    const x0 = (A.left + 1) & ~1, y0 = (A.top + 1) & ~1;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const c = cfa[dy * 2 + dx];
        const bl = levels.black[c];
        const nx = ((A.right - x0 - dx - 2) >> 1), ny = ((A.bottom - y0 - dy) >> 1);
        for (let py = 0; py + B <= ny; py += B) {
          for (let px = 0; px + B + 1 <= nx; px += B) {
            let s = 0, d2 = 0, mx = 0;
            for (let j = 0; j < B; j++) {
              const row = (y0 + dy + 2 * (py + j)) * W + x0 + dx + 2 * px;
              for (let i = 0; i < B; i++) {
                const a = raw[row + 2 * i], b = raw[row + 2 * i + 2];
                s += a;
                const d = a - b;
                d2 += d * d;
                if (a > mx) mx = a;
                if (b > mx) mx = b;
              }
            }
            if (mx >= white - 2) continue; // clipped samples
            const mean = s / NS - bl;
            if (mean < 1) continue;
            means.push(mean);
            vars.push(d2 / NS / 2);
          }
        }
      }
    }
    const sat = white - levels.black.reduce((a, b) => a + b, 0) / 4;
    // bins of 1/4 EV
    const bins = new Map();
    for (let k = 0; k < means.length; k++) {
      const b = Math.floor(Math.log2(means[k]) * 4);
      let e = bins.get(b);
      if (!e) bins.set(b, e = { m: [], v: [] });
      e.m.push(means[k]);
      e.v.push(vars[k]);
    }
    // low percentile of a variance estimated from 64 differences, chi-square corrected
    // the 10th percentile rejects texture better than the 25th (checked against
    // high-ISO frames of the same bodies, where noise swamps texture)
    const PCT = opts.pct || 0.1;
    const Z = { 0.05: 1.645, 0.1: 1.2816, 0.25: 0.674 }[PCT] || 0.674;
    const CORR = 1 - Z * Math.sqrt(2 / 63);
    const pts = [];
    for (const [b, e] of [...bins.entries()].sort((p, q) => p[0] - q[0])) {
      if (e.v.length < 150) continue;
      e.m.sort((p, q) => p - q);
      e.v.sort((p, q) => p - q);
      pts.push({ S: e.m[e.m.length >> 1], V: e.v[(e.v.length * PCT) | 0] / CORR, n: e.v.length });
    }
    const fit = pts.filter((p) => p.S > 8 && p.S < 0.5 * sat);
    const res = { pts, patches: means.length, sat, ok: false };
    if (fit.length < 4) { res.reason = 'not enough flat, unclipped areas over a wide enough range of brightness'; return res; }
    res.spanEV = Math.log2(fit[fit.length - 1].S / fit[0].S);
    let r2, invG;
    if (sigma) {
      const r = sigma.reduce((a, b) => a + b, 0) / 4;
      r2 = r * r;
      let num = 0, den = 0;
      for (const p of fit) { const w = 1 / (p.V * p.V); num += w * p.S * (p.V - r2); den += w * p.S * p.S; }
      invG = num / den;
      res.readSource = 'masked border';
    } else {
      // weighted least squares for [r2, invG]
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (const p of fit) {
        const w = 1 / (p.V * p.V);
        a11 += w; a12 += w * p.S; a22 += w * p.S * p.S; b1 += w * p.V; b2 += w * p.S * p.V;
      }
      const det = a11 * a22 - a12 * a12;
      r2 = (b1 * a22 - b2 * a12) / det;
      invG = (a11 * b2 - a12 * b1) / det;
      if (!(r2 > 0.01)) r2 = 0.01;
      res.readSource = 'fit (no masked border)';
    }
    if (!(invG > 0) || !isFinite(invG)) { res.reason = 'the noise does not grow with signal in this image (too much texture or too few flat areas)'; return res; }
    const g = 1 / invG, r = Math.sqrt(r2);
    const snrLevel = (k) => (k * k / g + Math.sqrt(k ** 4 / (g * g) + 4 * k * k * r2)) / 2;
    const snrAt = (ev) => { const s = sat * Math.pow(2, ev); return s / Math.sqrt(r2 + s / g); };
    Object.assign(res, {
      ok: true, gain: g, readDN: r, readE: r * g, fwc: sat * g, edr: Math.log2(sat / r),
      ev: { 1: Math.log2(sat / snrLevel(1)), 4: Math.log2(sat / snrLevel(4)), 10: Math.log2(sat / snrLevel(10)), 20: Math.log2(sat / snrLevel(20)) },
      push: [0, 1, 2, 3, 4, 5].map((n) => [snrAt(-3 - n), snrAt(-6 - n)]),
      model: (s) => Math.sqrt(r2 + s / g),
      confidence: res.spanEV >= 5 && fit.length >= 12 ? 'good' : res.spanEV >= 3 ? 'fair' : 'low',
    });
    return res;
  }

  /**
   * Pattern (banding) noise from the masked border, per CFA channel.
   * Row noise comes from a vertical strip (left or right border): the mean of each
   * row across the strip. Column noise comes from a horizontal strip (top or
   * bottom): the mean of each column down the strip. Each line mean carries the
   * line offset plus random noise / sqrt(samples), so
   *   var(m[k+1] - m[k]) / 2 = σ_line² + σ_random² / n
   * over neighbouring same-colour lines (the differences also remove slow gradients
   * such as amp glow). Outlying differences and hot pixels are left out. A strip
   * whose level differs from the black level is a separately read area (the 50D's
   * top border sits 35 DN low, with its own column pattern) and is not used.
   */
  function patternNoise(img, black) {
    const M = img.masked;
    if (!M || !M.rects) return null;
    const { raw, width: W, cfa } = img;
    const med = (a) => { const s = Float64Array.from(a).sort(); const n = s.length; return n ? (n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

    function lines(rect, isRow) {
      const a0 = isRow ? rect.y0 : rect.x0, a1 = isRow ? rect.y1 : rect.x1;
      const b0 = isRow ? rect.x0 : rect.y0, b1 = isRow ? rect.x1 : rect.y1;
      const per = [0, 1, 2, 3].map(() => ({ means: [], pos: [], within: 0, wn: 0, samples: 0 }));
      for (let i = a0; i < a1; i++) {
        for (let p = 0; p < 2; p++) {
          const c = isRow ? cfa[(i & 1) * 2 + p] : cfa[p * 2 + (i & 1)];
          const ch = M.ch[c];
          if (!ch) continue;
          const lo = ch.mean - 6 * ch.sd - 2, hi = ch.mean + 6 * ch.sd + 2;
          let s = 0, s2 = 0, n = 0;
          for (let j = b0 + ((b0 & 1) !== p ? 1 : 0); j < b1; j += 2) {
            const v = isRow ? raw[i * W + j] : raw[j * W + i];
            if (v < lo || v > hi) continue; // hot or dead pixel
            s += v; s2 += v * v; n++;
          }
          if (n < 2) continue;
          const m = s / n, e = per[c];
          e.means.push(m); e.pos.push(i); e.sum = (e.sum || 0) + s;
          e.within += s2 - n * m * m; e.wn += n - 1; e.samples += n;
        }
      }
      const res = per.map((e) => {
        if (e.means.length < 8 || !e.wn) return null;
        const random = Math.sqrt(e.within / e.wn);
        const n = e.samples / e.means.length;
        const d = [];
        for (let k = 1; k < e.means.length; k++) d.push(e.means[k] - e.means[k - 1]);
        // variance of the differences, with outliers beyond 5 robust sigmas removed
        const md = med(d);
        const mad = 1.4826 * med(d.map((x) => Math.abs(x - md))) || 1e-9;
        let s2 = 0, k2 = 0;
        for (const x of d) if (Math.abs(x - md) <= 5 * mad) { s2 += (x - md) * (x - md); k2++; }
        const total = s2 / Math.max(1, k2 - 1) / 2;          // σ_line² + σ_random² / n
        const line2 = total - (random * random) / n;
        // standard error of that variance: below three of them the banding counts as not detected
        const se = total * Math.sqrt(2 / Math.max(1, k2 - 1));
        return {
          level: e.sum / e.samples,
          random, line: Math.sqrt(Math.max(0, line2)), detected: line2 > 3 * se, limit: Math.sqrt(Math.max(0, line2) + 2 * se),
          lines: e.means.length, perLine: n,
        };
      });
      return { rect, ch: res, length: a1 - a0, width: b1 - b0 };
    }

    const rejected = [];
    // first usable strip of each orientation: its level must match the black level
    const pick = (names, isRow) => {
      for (const k of names) {
        const r = M.rects[k];
        if (!r) continue;
        const L = lines(r, isRow);
        const off = L.ch.map((c, i) => (c && black ? c.level - black[i] : 0));
        const bad = L.ch.some((c, i) => c && Math.abs(off[i]) > Math.max(3, 0.5 * c.random));
        if (!bad) return Object.assign(L, { side: k });
        const worst = off.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
        rejected.push(`${k} border (${worst > 0 ? '+' : ''}${worst.toFixed(0)} DN from black, read separately)`);
      }
      return null;
    };
    const rows = pick(['left', 'right'], true), cols = pick(['top', 'bottom'], false);
    const out = { rows, cols, rowStrip: rows && rows.side, colStrip: cols && cols.side, rejected };
    // random noise: from the strip with more samples per channel
    out.random = [0, 1, 2, 3].map((c) => {
      const a = out.rows && out.rows.ch[c], b = out.cols && out.cols.ch[c];
      return a && b ? (a.lines * a.perLine >= b.lines * b.perLine ? a.random : b.random) : (a || b) ? (a || b).random : null;
    });
    return out.rows || out.cols ? out : null;
  }

  /**
   * Hot, stuck and dead pixels in the image area. A pixel is compared with its 8
   * nearest same-colour neighbours (2 px away), which must agree among themselves,
   * and flagged when it differs from all of them by more than
   *   T = max(8 σ_read, 3 × neighbour range) + 0.2 × (neighbour level above black)
   * The second term keeps photon noise and fine detail in bright areas from
   * counting: real detail is spread over several pixels by the lens and the AA
   * filter, a defect is not.
   *   hot:   above the brightest neighbour by more than T
   *   stuck: hot and at saturation
   *   dead:  below the darkest neighbour by more than T while the neighbours are lit
   *          (32 σ above black); in the dark a dead pixel looks like any other
   */
  function defectPixels(img, levels, sigma, maxList) {
    const { raw, width: W, active: A, cfa } = img;
    const white = levels.white;
    const sig = [0, 1, 2, 3].map((c) => Math.max(1, sigma && sigma[c] ? sigma[c] : 2));
    const counts = [0, 1, 2, 3].map(() => ({ hot: 0, strong: 0, stuck: 0, dead: 0 }));
    const list = [];
    const cap = maxList || 100000;
    let truncated = false;
    for (let y = A.top + 2; y < A.bottom - 2; y++) {
      const o = y * W, up = o - 2 * W, dn = o + 2 * W;
      for (let x = A.left + 2; x < A.right - 2; x++) {
        const v = raw[o + x], l = raw[o + x - 2], r = raw[o + x + 2];
        const c = cfa[(y & 1) * 2 + (x & 1)], s8 = 8 * sig[c];
        const hiLR = l > r ? l : r, loLR = l < r ? l : r;
        if (v <= hiLR + s8 && v >= loLR - s8) continue; // the full test cannot pass
        let mx = hiLR, mn = loLR;
        for (const q of [up + x - 2, up + x, up + x + 2, dn + x - 2, dn + x, dn + x + 2]) {
          const n = raw[q];
          if (n > mx) mx = n;
          if (n < mn) mn = n;
        }
        const b = levels.black[c];
        // the neighbours must agree among themselves: a defect sits in a smooth
        // area, fine scene detail (specular points, edges) does not
        const spread = mx - mn;
        if (spread > s8 + 0.15 * Math.max(0, mn - b)) continue;
        // local noise: the range of 8 samples is about 3 σ, so 3 × range ~ 8-9 σ
        // (covers photon noise, which read noise alone does not)
        const t0 = Math.max(s8, 3 * spread);
        let kind;
        if (v > mx + t0 + 0.2 * Math.max(0, mx - b)) kind = v >= white ? 'stuck' : 'hot';
        else if (v < mn - t0 - 0.2 * Math.max(0, mn - b) && mn - b > 32 * sig[c]) kind = 'dead';
        else continue;
        const excess = (kind === 'dead' ? mn - v : v - mx) / sig[c];
        const k = counts[c];
        if (kind === 'stuck') k.stuck++;
        else if (kind === 'dead') k.dead++;
        else { k.hot++; if (excess > 64) k.strong++; }
        if (list.length < cap) list.push({ x, y, c, v, ref: kind === 'dead' ? mn : mx, kind, excess });
        else truncated = true;
      }
    }
    list.sort((p, q) => q.excess - p.excess);
    const area = (A.right - A.left) * (A.bottom - A.top);
    return { counts, list, truncated, sig, area };
  }

  window.Analysis = { CH_NAMES, CH_COLORS, ALL_COLOR, computeHist, computeStats, histStats, sumHist, grayWorld, photonTransfer, patternNoise, defectPixels };
})();
