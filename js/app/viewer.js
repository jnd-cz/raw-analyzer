/*
 * Raw image viewer: renders the visible part of the raw frame straight from
 * the undemosaiced data (2x2 CFA blocks), with zoom, pan, area selection,
 * white balance picking and clipping overlays. With a demosaic algorithm chosen,
 * views at one raw pixel per screen pixel or closer use demosaiced data for the
 * visible area (computed in the worker pool, see demosaic-host.js).
 */
(function () {
  'use strict';

  const XYZ_RGB = [[0.412453, 0.357580, 0.180423], [0.212671, 0.715160, 0.072169], [0.019334, 0.119193, 0.950227]];

  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
    ];
  }

  /**
   * camera -> linear sRGB matrix from an XYZ->camera matrix (dcraw cam_xyz_coeff).
   * 3 colours: 3x3 inverse. 4 colours (CMYG): 3x4 pseudo-inverse.
   */
  function rgbFromCam(camXyz) {
    if (!camXyz || (camXyz.length !== 9 && camXyz.length !== 12)) return null;
    const n = camXyz.length / 3;
    const cx = [];
    for (let i = 0; i < n; i++) cx.push(camXyz.slice(3 * i, 3 * i + 3));
    const camRgb = cx.map((r) => [0, 1, 2].map((j) => r[0] * XYZ_RGB[0][j] + r[1] * XYZ_RGB[1][j] + r[2] * XYZ_RGB[2][j]));
    for (const row of camRgb) { const s = row[0] + row[1] + row[2]; for (let j = 0; j < 3; j++) row[j] /= s; }
    if (n === 3) return inv3(camRgb);
    // pseudo-inverse (A^T A)^-1 A^T of the 4x3 matrix
    const AtA = [0, 1, 2].map((i) => [0, 1, 2].map((j) => camRgb.reduce((s, r) => s + r[i] * r[j], 0)));
    const inv = inv3(AtA);
    if (!inv) return null;
    return [0, 1, 2].map((i) => [0, 1, 2, 3].map((k) => inv[i][0] * camRgb[k][0] + inv[i][1] * camRgb[k][1] + inv[i][2] * camRgb[k][2]));
  }

  // sRGB transfer curve lookup, 4096 steps over [0, 1]
  const GAMMA = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) {
    const v = i / 4096;
    GAMMA[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  }
  const g8 = (v) => GAMMA[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0];

  const CLIP_RGB = [255, 43, 214];
  const UNDER_RGB = [43, 107, 255];
  const CH_RGB = [[1, 0.27, 0.25], [0.3, 0.85, 0.42], [0.3, 0.55, 1], [0.18, 0.75, 0.68]];
  const ALGO_NAMES = { bilinear: 'Bilinear', ppg: 'PPG', ahd: 'AHD' };
  const CMYG_RGB = [[0.3, 0.85, 0.42], [0.95, 0.3, 0.85], [0.2, 0.8, 0.95], [0.95, 0.85, 0.2]]; // G, M, C, Y

  class Viewer {
    constructor(canvas, container) {
      this.canvas = canvas;
      this.box = container;
      this.img = null;
      this.mode = 'rgb';
      this.exposure = 0;
      this.showClip = true;
      this.showUnder = false;
      this.showMasked = false;
      this.tool = 'pan';
      this.selection = null;
      this.overlayRect = null;
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.onHover = null; this.onSelect = null; this.onPick = null; this.onZoom = null;
      this._hqTimer = 0;
      this._raf = 0;
      this.demosaic = 'quick';
      this.dmCache = null; this._dmWant = null; this._dmGen = 0; this._dmTimer = 0; this._dmStatus = '';
      this.onDemosaicStatus = null;
      this._bindEvents();
      new ResizeObserver(() => { if (this.img) { this._keepCenterOnResize(); this.requestRender(); } }).observe(container);
    }

    setImage(img, levels, wb) {
      this.img = img;
      this.levels = levels;
      this.wb = wb;
      this.matrix = rgbFromCam(img.colorMatrix) || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      this.selection = null;
      this.resetDemosaic();
      this.fit();
    }

    bounds() {
      const img = this.img;
      if (this.showMasked) return { left: 0, top: 0, right: img.width, bottom: img.height };
      return img.active;
    }

    fit() {
      if (!this.img) return;
      const b = this.bounds();
      const cw = this.box.clientWidth, ch = this.box.clientHeight;
      const bw = b.right - b.left, bh = b.bottom - b.top;
      this.scale = Math.min(cw / bw, ch / bh) * 0.98;
      this.ox = b.left + bw / 2 - cw / 2 / this.scale;
      this.oy = b.top + bh / 2 - ch / 2 / this.scale;
      this.fitted = true;
      this._zoomed();
      this.requestRender();
    }

    zoomAt(factor, sx, sy) {
      if (!this.img) return;
      const ns = Math.max(0.02, Math.min(32, this.scale * factor));
      const rx = this.ox + sx / this.scale, ry = this.oy + sy / this.scale;
      this.scale = ns;
      this.ox = rx - sx / ns;
      this.oy = ry - sy / ns;
      this.fitted = false;
      this._zoomed();
      this.requestRender();
    }

    zoomTo(scale) {
      const cw = this.box.clientWidth, ch = this.box.clientHeight;
      this.zoomAt(scale / this.scale, cw / 2, ch / 2);
    }

    _zoomed() { if (this.onZoom) this.onZoom(this.scale, this.fitted); }

    _keepCenterOnResize() {
      if (this.fitted) { this.fit(); return; }
    }

    requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.render(false);
        clearTimeout(this._hqTimer);
        this._hqTimer = setTimeout(() => this.render(true), 160);
      });
    }

    toRaw(sx, sy) { return [this.ox + sx / this.scale, this.oy + sy / this.scale]; }

    /** Drops the demosaiced area (new image, levels or algorithm). */
    resetDemosaic() {
      if (this._dmGen && window.Demosaic) Demosaic.cancel(this._dmGen);
      this._dmGen = 0;
      this.dmCache = null;
      this._dmWant = null;
      clearTimeout(this._dmTimer);
    }

    _dmKey() {
      return [this.demosaic, this.wb.join(), this.levels.black.join(), this.levels.white, this.showMasked].join('|');
    }

    _setDmStatus(t) {
      if (t === this._dmStatus) return;
      this._dmStatus = t;
      if (this.onDemosaicStatus) this.onDemosaicStatus(t);
    }

    /** Demosaiced data usable for the visible rect vr, requesting it if missing. */
    _dmFor(vr, bnd) {
      const key = this._dmKey();
      const c = this.dmCache && this.dmCache.key === key ? this.dmCache : null;
      const covers = (r) => r && r.x0 <= vr.x0 && r.y0 <= vr.y0 && r.x1 >= vr.x1 && r.y1 >= vr.y1;
      if (covers(c)) return c;
      if (!(this._dmWant && this._dmWant.key === key && covers(this._dmWant.rect))) {
        // a margin around the view so small pans do not need a new pass
        const vw = vr.x1 - vr.x0, vh = vr.y1 - vr.y0;
        const ex = vw * vh > 4e6 ? 0.1 : 0.25;
        const mx = Math.round(vw * ex), my = Math.round(vh * ex);
        const rect = {
          x0: Math.max(bnd.left, vr.x0 - mx), y0: Math.max(bnd.top, vr.y0 - my),
          x1: Math.min(bnd.right, vr.x1 + mx), y1: Math.min(bnd.bottom, vr.y1 + my),
        };
        this._dmWant = { key, rect };
        clearTimeout(this._dmTimer);
        this._dmTimer = setTimeout(() => this._dmStart(), 120);
      }
      return c; // part of the view may still be covered
    }

    _dmStart() {
      const want = this._dmWant;
      if (!want || !this.img) return;
      if (this._dmGen) Demosaic.cancel(this._dmGen);
      const gen = this._dmGen = Demosaic.newGen();
      const p = Demosaic.params(this.img, this.levels, this.wb, this.demosaic);
      const name = this.img.colors4 ? 'Bilinear (CMYG sensor)' : ALGO_NAMES[this.demosaic];
      const t0 = performance.now();
      this._setDmStatus(name + ': demosaicing…');
      Demosaic.region(this.img, want.rect, this.bounds(), p, gen).then((r) => {
        if (gen !== this._dmGen) return;
        this.dmCache = { ...r, x1: r.x0 + r.w, y1: r.y0 + r.h, key: want.key, wbMin: p.wbMin };
        if (this._dmWant === want) this._dmWant = null;
        const mp = (r.w * r.h / 1e6).toFixed(1);
        this._setDmStatus(`${name}: ${mp} MP in ${Math.round(performance.now() - t0)} ms on ${Demosaic.threads} thread${Demosaic.threads > 1 ? 's' : ''}`);
        this.requestRender();
      }, (e) => {
        if (e.cancelled) return;
        console.error(e);
        this._setDmStatus('Demosaic failed: ' + e.message);
      });
    }

    /** Renders the viewport. hq = average several CFA blocks per screen pixel. */
    render(hq) {
      const img = this.img;
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const cw = this.box.clientWidth, chh = this.box.clientHeight;
      const W = Math.max(1, Math.round(cw * dpr)), H = Math.max(1, Math.round(chh * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const ctx = c.getContext('2d');
      if (!img) { ctx.clearRect(0, 0, W, H); return; }

      const raw = img.raw, RW = img.width;
      const sd = this.scale * dpr; // device px per raw px
      const bnd = this.bounds();
      const lv = this.levels, cfa = img.cfa;
      // offsets of R, G, B, G2 inside an even aligned 2x2 block
      const posOff = [0, 1, RW, RW + 1];
      const off = [0, 0, 0, 0];
      for (let p = 0; p < 4; p++) off[cfa[p]] = posOff[p];
      const [oR, oG, oB, oG2] = off;
      const [bR, bG, bB, bG2] = lv.black;
      const white = lv.white;
      const gain = Math.pow(2, this.exposure);
      const wb = this.wb;
      const kR = gain * wb[0] / Math.max(1, white - bR);
      const kG = gain * wb[1] / Math.max(1, white - (bG + bG2) / 2);
      const kB = gain * wb[2] / Math.max(1, white - bB);
      const M = this.mode === 'rgb' && this.matrix && this.matrix[0].length === 3 ? this.matrix : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const m00 = M[0][0], m01 = M[0][1], m02 = M[0][2], m10 = M[1][0], m11 = M[1][1], m12 = M[1][2], m20 = M[2][0], m21 = M[2][1], m22 = M[2][2];
      const clip = this.showClip, under = this.showUnder;
      // shadow overlay: average signal in read-noise sigmas below this threshold
      const sig = this.noiseSigma;
      const useSigma = under && sig && this.underK > 0;
      const iR = useSigma ? 1 / sig[0] : 0, iG = useSigma ? 1 / sig[1] : 0, iB = useSigma ? 1 / sig[2] : 0, iG2 = useSigma ? 1 / sig[3] : 0;
      // highlights: clip all channels where the least amplified one saturates,
      // so clipped areas render white instead of pink/magenta
      const hiClip = gain * Math.min(wb[0], wb[1], wb[2]);
      // CMYG sensors: four independent channels through a 3x4 matrix
      const c4 = !!img.colors4 && this.matrix && this.matrix[0].length === 4;
      const k4 = [0, 1, 2, 3].map((c) => gain * wb[c] / Math.max(1, white - lv.black[c]));
      const hi4 = gain * Math.min(wb[0], wb[1], wb[2], wb[3]);
      const P = c4 ? this.matrix : null;

      const id = ctx.createImageData(W, H);
      const out = id.data;
      // column lookups
      const colX = new Int32Array(W);
      for (let px = 0; px < W; px++) colX[px] = Math.floor(this.ox + (px + 0.5) / sd);
      // block sampling grid for the quality pass
      const span = 1 / sd; // raw px per device px
      const nS = hq && span > 2.5 ? Math.min(4, Math.floor(span / 2)) : 1;
      const stepS = span / nS;
      const xMin = (bnd.left + 1) & ~1, yMin = (bnd.top + 1) & ~1;

      const mode = this.mode;
      const chanIdx = { R: 0, G: 1, B: 2, G2: 3 }[mode];
      const pixelCfa = mode === 'cfa' && sd >= 1.5;

      // demosaiced data for the visible area (camera RGB, white balanced, 0..65535)
      let dm = null, dmM = null;
      if (mode === 'rgb' && this.demosaic !== 'quick') {
        if (sd > 0.99) { // 100% zoom may land a hair below 1
          const vr = {
            x0: Math.max(bnd.left, Math.floor(this.ox)), y0: Math.max(bnd.top, Math.floor(this.oy)),
            x1: Math.min(bnd.right, Math.ceil(this.ox + W / sd)), y1: Math.min(bnd.bottom, Math.ceil(this.oy + H / sd)),
          };
          if (vr.x1 > vr.x0 && vr.y1 > vr.y0) dm = this._dmFor(vr, bnd);
          if (dm) {
            const s = gain * dm.wbMin / 65535;
            dmM = (c4 ? P : M).map((row) => row.map((v) => v * s));
          }
          if (dm && this._dmStatus.endsWith('100%')) this._setDmStatus('');
        } else {
          this._setDmStatus(ALGO_NAMES[this.demosaic] + ' from 100%');
        }
      } else {
        this._setDmStatus('');
      }

      let o = 0;
      for (let py = 0; py < H; py++) {
        const ry = Math.floor(this.oy + (py + 0.5) / sd);
        if (ry < bnd.top || ry >= bnd.bottom) { for (let px = 0; px < W; px++, o += 4) { out[o] = 11; out[o + 1] = 12; out[o + 2] = 14; out[o + 3] = 255; } continue; }
        const by = ry & ~1;
        for (let px = 0; px < W; px++, o += 4) {
          const rx = colX[px];
          if (rx < bnd.left || rx >= bnd.right) { out[o] = 11; out[o + 1] = 12; out[o + 2] = 14; out[o + 3] = 255; continue; }
          if (pixelCfa) {
            const v = raw[ry * RW + rx];
            const ch = cfa[(ry & 1) * 2 + (rx & 1)];
            if (clip && v >= white) { out[o] = CLIP_RGB[0]; out[o + 1] = CLIP_RGB[1]; out[o + 2] = CLIP_RGB[2]; out[o + 3] = 255; continue; }
            const k = c4 ? k4[ch] : ch === 0 ? kR : ch === 2 ? kB : kG;
            const t = (v - lv.black[ch]) * k;
            const col = (c4 ? CMYG_RGB : CH_RGB)[ch];
            out[o] = g8(t * col[0]); out[o + 1] = g8(t * col[1]); out[o + 2] = g8(t * col[2]); out[o + 3] = 255;
            continue;
          }
          let R = 0, G = 0, B = 0, G2 = 0, isClip = false, isUnder = true;
          if (nS === 1) {
            const i = by * RW + (rx & ~1);
            R = raw[i + oR]; G = raw[i + oG]; B = raw[i + oB]; G2 = raw[i + oG2];
            isClip = R >= white || G >= white || B >= white || G2 >= white;
            isUnder = R <= bR && G <= bG && B <= bB && G2 <= bG2;
          } else {
            let n = 0;
            for (let sy = 0; sy < nS; sy++) {
              // keep every sample inside the frame: a negative x would wrap to the end
              // of the previous row (wrong content and swapped CFA rows)
              const yy = Math.max(yMin, Math.min(bnd.bottom - 2, Math.floor(this.oy + py / sd + (sy + 0.5) * stepS))) & ~1;
              for (let sx = 0; sx < nS; sx++) {
                const xx = Math.max(xMin, Math.min(bnd.right - 2, Math.floor(this.ox + px / sd + (sx + 0.5) * stepS))) & ~1;
                const i = yy * RW + xx;
                const a = raw[i + oR], b2 = raw[i + oG], c2 = raw[i + oB], d2 = raw[i + oG2];
                R += a; G += b2; B += c2; G2 += d2; n++;
                if (a >= white || b2 >= white || c2 >= white || d2 >= white) isClip = true;
                if (!(a <= bR && b2 <= bG && c2 <= bB && d2 <= bG2)) isUnder = false;
              }
            }
            R /= n; G /= n; B /= n; G2 /= n;
          }
          if (clip && isClip) { out[o] = CLIP_RGB[0]; out[o + 1] = CLIP_RGB[1]; out[o + 2] = CLIP_RGB[2]; out[o + 3] = 255; continue; }
          if (under) {
            let dark = isUnder;
            if (useSigma) {
              // the weakest channel decides (it carries the colour noise); a single
              // 2x2 block is too noisy for the test, so average a 2x2 neighbourhood of blocks
              let sR = R, sG = G, sB = B, sG2 = G2;
              if (nS === 1) {
                const bx = Math.min(bnd.right - 4, rx & ~1), byy = Math.min(bnd.bottom - 4, by);
                sR = sG = sB = sG2 = 0;
                for (let dy = 0; dy <= 2; dy += 2) {
                  for (let dx = 0; dx <= 2; dx += 2) {
                    const i = (byy + dy) * RW + bx + dx;
                    sR += raw[i + oR]; sG += raw[i + oG]; sB += raw[i + oB]; sG2 += raw[i + oG2];
                  }
                }
                sR *= 0.25; sG *= 0.25; sB *= 0.25; sG2 *= 0.25;
              }
              const k = this.underK;
              dark = (sR - bR) * iR <= k || (sG - bG) * iG <= k || (sB - bB) * iB <= k || (sG2 - bG2) * iG2 <= k;
            }
            if (dark) { out[o] = UNDER_RGB[0]; out[o + 1] = UNDER_RGB[1]; out[o + 2] = UNDER_RGB[2]; out[o + 3] = 255; continue; }
          }
          if (chanIdx !== undefined) {
            const v = c4 ? ([R, G, B, G2][chanIdx] - lv.black[chanIdx]) * k4[chanIdx] / wb[chanIdx]
              : chanIdx === 0 ? (R - bR) * kR / wb[0] : chanIdx === 2 ? (B - bB) * kB / wb[2] : chanIdx === 1 ? (G - bG) * kG / wb[1] : (G2 - bG2) * kG / wb[1];
            const q = g8(v);
            out[o] = q; out[o + 1] = q; out[o + 2] = q; out[o + 3] = 255;
            continue;
          }
          let or, og, ob;
          if (dm && rx >= dm.x0 && ry >= dm.y0 && rx < dm.x1 && ry < dm.y1) {
            const d = dm.data, q = ((ry - dm.y0) * dm.w + rx - dm.x0) * dm.colors;
            const a = d[q], b = d[q + 1], e = d[q + 2], f = dm.colors === 4 ? d[q + 3] : 0;
            const m0 = dmM[0], m1 = dmM[1], m2 = dmM[2];
            or = m0[0] * a + m0[1] * b + m0[2] * e + (f ? m0[3] * f : 0);
            og = m1[0] * a + m1[1] * b + m1[2] * e + (f ? m1[3] * f : 0);
            ob = m2[0] * a + m2[1] * b + m2[2] * e + (f ? m2[3] * f : 0);
          } else if (c4) {
            const q0 = Math.min(hi4, (R - bR) * k4[0]), q1 = Math.min(hi4, (G - bG) * k4[1]);
            const q2 = Math.min(hi4, (B - bB) * k4[2]), q3 = Math.min(hi4, (G2 - bG2) * k4[3]);
            or = P[0][0] * q0 + P[0][1] * q1 + P[0][2] * q2 + P[0][3] * q3;
            og = P[1][0] * q0 + P[1][1] * q1 + P[1][2] * q2 + P[1][3] * q3;
            ob = P[2][0] * q0 + P[2][1] * q1 + P[2][2] * q2 + P[2][3] * q3;
          } else {
            let r = (R - bR) * kR, g = ((G - bG) + (G2 - bG2)) * 0.5 * kG, b = (B - bB) * kB;
            if (r > hiClip) r = hiClip;
            if (g > hiClip) g = hiClip;
            if (b > hiClip) b = hiClip;
            or = m00 * r + m01 * g + m02 * b; og = m10 * r + m11 * g + m12 * b; ob = m20 * r + m21 * g + m22 * b;
          }
          const mx = or > og ? (or > ob ? or : ob) : (og > ob ? og : ob);
          if (mx > 1) {
            // over the display range: keep luminance, desaturate towards white
            const Y = 0.2126 * or + 0.7152 * og + 0.0722 * ob;
            if (Y >= 1) { or = og = ob = 1; } else {
              const s = (1 - Y) / (mx - Y);
              or = Y + (or - Y) * s; og = Y + (og - Y) * s; ob = Y + (ob - Y) * s;
            }
          }
          out[o] = g8(or);
          out[o + 1] = g8(og);
          out[o + 2] = g8(ob);
          out[o + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      this._drawOverlays(ctx, dpr);
    }

    _rectToScreen(r, dpr) {
      return [(r.x0 - this.ox) * this.scale * dpr, (r.y0 - this.oy) * this.scale * dpr,
        (r.x1 - r.x0) * this.scale * dpr, (r.y1 - r.y0) * this.scale * dpr];
    }

    _drawOverlays(ctx, dpr) {
      const img = this.img;
      ctx.save();
      ctx.lineWidth = Math.max(1, dpr);
      if (this.showMasked) {
        const a = img.active;
        const [x, y, w, h] = this._rectToScreen({ x0: a.left, y0: a.top, x1: a.right, y1: a.bottom }, dpr);
        ctx.strokeStyle = 'rgba(242,184,75,.9)';
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        ctx.setLineDash([]);
      }
      if (this.overlayRect) {
        const [x, y, w, h] = this._rectToScreen(this.overlayRect, dpr);
        ctx.strokeStyle = 'rgba(196,202,210,.9)';
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        ctx.setLineDash([]);
      }
      const sel = this._dragSel || this.selection;
      if (sel) {
        const [x, y, w, h] = this._rectToScreen(sel, dpr);
        ctx.fillStyle = 'rgba(76,154,255,.12)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#4c9aff';
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeRect(x + 0.5, y + 0.5, w, h);
        const label = `${sel.x1 - sel.x0} x ${sel.y1 - sel.y0}`;
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width + 8 * dpr;
        ctx.fillStyle = '#4c9aff';
        ctx.fillRect(x, y - 16 * dpr, tw, 16 * dpr);
        ctx.fillStyle = '#0b1420';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + 4 * dpr, y - 8 * dpr);
      }
      ctx.restore();
    }

    /** Raw values of the 2x2 CFA block at raw coordinates. */
    blockAt(rx, ry) {
      const img = this.img;
      if (!img || rx < 0 || ry < 0 || rx >= img.width || ry >= img.height) return null;
      const bx = rx & ~1, by = ry & ~1;
      if (bx + 1 >= img.width || by + 1 >= img.height) return null;
      const v = [0, 0, 0, 0];
      const pos = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (let p = 0; p < 4; p++) v[img.cfa[p]] = img.raw[(by + pos[p][1]) * img.width + bx + pos[p][0]];
      return { x: rx, y: ry, bx, by, v, pixel: img.raw[ry * img.width + rx], pixelCh: img.cfa[(ry & 1) * 2 + (rx & 1)] };
    }

    _clampRect(x0, y0, x1, y1) {
      const img = this.img;
      const a = Math.max(0, Math.min(x0, x1)) & ~1, b = Math.max(0, Math.min(y0, y1)) & ~1;
      let c = Math.min(img.width, Math.max(x0, x1)), d = Math.min(img.height, Math.max(y0, y1));
      c = Math.min(img.width, (c + 1) & ~1); d = Math.min(img.height, (d + 1) & ~1);
      return { x0: a, y0: b, x1: c, y1: d };
    }

    _bindEvents() {
      const cv = this.canvas;
      let drag = null;
      let space = false;
      window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { space = true; e.preventDefault(); } });
      window.addEventListener('keyup', (e) => { if (e.code === 'Space') space = false; });

      cv.addEventListener('wheel', (e) => {
        if (!this.img) return;
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const f = Math.pow(1.0018, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
        this.zoomAt(f, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });

      cv.addEventListener('dblclick', () => this.fit());

      cv.addEventListener('pointerdown', (e) => {
        if (!this.img || e.button !== 0) return;
        cv.setPointerCapture(e.pointerId);
        const r = cv.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        let kind = this.tool;
        if (space) kind = 'pan';
        else if (e.shiftKey) kind = 'select';
        drag = { kind, sx, sy, ox: this.ox, oy: this.oy, moved: false };
        if (kind === 'pan') this.box.classList.add('dragging');
      });

      cv.addEventListener('pointermove', (e) => {
        if (!this.img) return;
        const r = cv.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const [rx, ry] = this.toRaw(sx, sy);
        if (this.onHover) this.onHover(this.blockAt(Math.floor(rx), Math.floor(ry)));
        if (!drag) return;
        if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
        if (drag.kind === 'pan') {
          this.ox = drag.ox - (sx - drag.sx) / this.scale;
          this.oy = drag.oy - (sy - drag.sy) / this.scale;
          this.fitted = false;
          this.requestRender();
        } else if (drag.kind === 'select' && drag.moved) {
          const [ax, ay] = this.toRaw(drag.sx, drag.sy);
          this._dragSel = this._clampRect(Math.floor(ax), Math.floor(ay), Math.floor(rx), Math.floor(ry));
          this.requestRender();
        }
      });

      const end = (e) => {
        if (!drag) return;
        this.box.classList.remove('dragging');
        const r = cv.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        if (drag.kind === 'select' && this._dragSel) {
          const s = this._dragSel;
          this._dragSel = null;
          if (s.x1 - s.x0 >= 2 && s.y1 - s.y0 >= 2) {
            this.selection = s;
            if (this.onSelect) this.onSelect(s);
          }
          this.requestRender();
        } else if (drag.kind === 'wb' && !drag.moved) {
          const [rx, ry] = this.toRaw(sx, sy);
          if (this.onPick) this.onPick(this._clampRect(Math.floor(rx) - 8, Math.floor(ry) - 8, Math.floor(rx) + 8, Math.floor(ry) + 8));
        } else if (drag.kind === 'select' && !drag.moved) {
          // click without drag: nothing
        }
        drag = null;
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', () => { drag = null; this._dragSel = null; this.box.classList.remove('dragging'); });
      cv.addEventListener('mouseleave', () => { if (this.onHover) this.onHover(null); });
    }

    clearSelection() {
      this.selection = null;
      this.requestRender();
    }
  }

  window.Viewer = Viewer;
  window.rgbFromCam = rgbFromCam;
})();
