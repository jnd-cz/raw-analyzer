/*
 * Waveform / parade scope (as in DaVinci Resolve) on the raw data: the image
 * column runs left to right, the raw level bottom to top, and brightness shows
 * how many pixels of that column sit at that level. Overlay mixes the CFA
 * channels additively in their colours (where they coincide the trace turns
 * white, i.e. brightness); Per channel puts them side by side as a parade.
 */
(function () {
  'use strict';

  const EV_MIN = -14;
  const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  class Waveform {
    constructor(canvas, tip) {
      this.canvas = canvas;
      this.tip = tip;
      this.data = null;
      canvas.addEventListener('mousemove', (e) => this.hover(e));
      canvas.addEventListener('mouseleave', () => { if (this.tip) this.tip.hidden = true; });
    }

    /**
     * img: decoded image; rect {x0,y0,x1,y1}; levels {black[4], white};
     * opt: { channels: [{ c, name, color }], layout: 'overlay'|'stacked'|'side', yMode: 'linear'|'ev', subBlack, sigma }
     */
    draw(img, rect, levels, opt) {
      const cv = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H || !img) return;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      const L = 46, R = 10, T = 10, B = 22;
      // per channel: 'stacked' puts the panels under each other at full width,
      // 'side' next to each other (the classic parade)
      const panels = opt.layout === 'overlay' ? 1 : opt.channels.length;
      const cols = opt.layout === 'side' ? panels : 1, rows = opt.layout === 'side' ? 1 : panels;
      const gap = panels > 1 ? 8 : 0;
      const pw = Math.max(8, Math.floor((W - L - R - gap * (cols - 1)) / cols));
      const ph = Math.max(8, Math.floor((H - T - B - gap * (rows - 1)) / rows));
      const origin = (pi) => [L + (pi % cols) * (pw + gap), T + Math.floor(pi / cols) * (ph + gap)];
      // bins in device pixels for a crisp trace
      const nx = Math.max(8, Math.round(pw * dpr)), ny = Math.max(8, Math.round(ph * dpr));
      const d = this.compute(img, rect, levels, opt, nx, ny);
      this.data = { d, L, T, pw, ph, gap, cols, rows, panels, nx, ny, rect, levels, opt, dpr, W, H, origin };
      const ctx = cv.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);

      // traces: one RGBA layer per panel, channels added
      for (let pi = 0; pi < panels; pi++) {
        const chans = panels > 1 ? [opt.channels[pi]] : opt.channels;
        const im = ctx.createImageData(nx, ny);
        const px = im.data;
        for (const ch of chans) {
          const cnt = d.counts[ch.c], ref = d.ref[ch.c];
          if (!cnt || !ref) continue;
          const [cr, cg, cb] = hexRgb(ch.color);
          // a single channel per panel is drawn brighter
          const boost = chans.length === 1 ? 1.25 : 0.85;
          for (let i = 0; i < nx * ny; i++) {
            const n = cnt[i];
            if (!n) continue;
            const a = Math.min(1, Math.sqrt(n / ref)) * boost;
            const o = i * 4;
            px[o] = Math.min(255, px[o] + cr * a);
            px[o + 1] = Math.min(255, px[o + 1] + cg * a);
            px[o + 2] = Math.min(255, px[o + 2] + cb * a);
            px[o + 3] = 255;
          }
        }
        const [ox, oy] = origin(pi);
        ctx.putImageData(im, Math.round(ox * dpr), Math.round(oy * dpr));
      }

      // frame, grid and labels per panel (tick labels in the first column only)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '11px system-ui, sans-serif';
      for (let pi = 0; pi < panels; pi++) {
        const [ox, oy] = origin(pi);
        const Y = (f) => oy + (1 - f) * ph; // f = fraction of the level range
        ctx.strokeStyle = 'rgba(138,147,157,.28)';
        ctx.fillStyle = '#8a939d';
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const ticks = rows > 1 ? d.ticks.filter((_, k) => k % 2 === 0) : d.ticks;
        for (const [f, label] of ticks) {
          const y = Math.round(Y(f)) + 0.5;
          ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + pw, y); ctx.stroke();
          if (pi % cols === 0) ctx.fillText(label, L - 6, y);
        }
        const mark = (f, color, text) => {
          if (f === null || f < 0 || f > 1) return;
          const y = Math.round(Y(f)) + 0.5;
          ctx.strokeStyle = color; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox + pw, y); ctx.stroke();
          ctx.setLineDash([]);
          if (pi === panels - 1 || cols === 1) { ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(text, ox + pw - 4, y - 2); }
        };
        mark(d.satF, '#ff6b6b', 'saturation');
        mark(d.floorF, '#6f8fd8', 'noise floor');
        ctx.strokeStyle = '#2a2f36';
        ctx.strokeRect(ox + 0.5, oy + 0.5, pw, ph);
        if (panels > 1) { ctx.fillStyle = opt.channels[pi].color; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(opt.channels[pi].name, ox + 4, oy + 3); }
      }
      ctx.fillStyle = '#8a939d'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('image left \u2192 right', L + 2, T + rows * ph + (rows - 1) * gap + 6);
    }

    /** counts[c][y * nx + x] for the visible channels, plus the level mapping. */
    compute(img, rect, levels, opt, nx, ny) {
      const { raw, width: W, cfa } = img;
      const x0 = rect.x0, x1 = rect.x1, y0 = rect.y0, y1 = rect.y1;
      const w = x1 - x0;
      const ev = opt.yMode === 'ev';
      const white = levels.white;
      const meanBlack = levels.black.reduce((a, b) => a + b, 0) / 4;
      // linear: black (or 0) .. white; EV: EV_MIN .. 0 below saturation
      const lo = opt.subBlack ? meanBlack : 0;
      const lut = [0, 1, 2, 3].map((c) => {
        const t = new Int32Array(65536);
        const b = levels.black[c], rng = Math.max(1, white - b);
        for (let v = 0; v < 65536; v++) {
          let f;
          if (ev) f = v - b > 0 ? (Math.log2((v - b) / rng) - EV_MIN) / -EV_MIN : -1;
          else f = (v - lo) / Math.max(1, white - lo);
          t[v] = f < 0 ? 0 : f >= 1 ? ny - 1 : Math.floor(f * (ny - 1) + 0.5);
        }
        return t;
      });
      const colBin = new Int32Array(w);
      for (let x = 0; x < w; x++) colBin[x] = Math.min(nx - 1, Math.floor((x * nx) / w));
      const want = new Set(opt.channels.map((c) => c.c));
      const counts = [0, 1, 2, 3].map((c) => (want.has(c) ? new Uint32Array(nx * ny) : null));
      // big frames: every other row pair is plenty for the picture
      const step = (x1 - x0) * (y1 - y0) > 12e6 ? 4 : 2;
      const flipY = ny - 1;
      for (let yb = y0 & ~1; yb < y1; yb += step) {
        for (let dy = 0; dy < 2; dy++) {
          const y = yb + dy;
          if (y < y0 || y >= y1) continue;
          const o = y * W;
          for (let p = 0; p < 2; p++) {
            const c = cfa[(y & 1) * 2 + p], cnt = counts[c];
            if (!cnt) continue;
            const t = lut[c];
            for (let x = x0 + ((x0 & 1) !== p ? 1 : 0); x < x1; x += 2) cnt[(flipY - t[raw[o + x]]) * nx + colBin[x - x0]]++;
          }
        }
      }
      // brightness reference: a high percentile of the occupied bins, so a few
      // dense bins do not make everything else invisible
      const ref = counts.map((cnt) => {
        if (!cnt) return 0;
        const v = [];
        for (let i = 0; i < cnt.length; i += 7) if (cnt[i]) v.push(cnt[i]);
        if (!v.length) return 1;
        v.sort((a, b) => a - b);
        return Math.max(1, v[Math.floor(v.length * 0.98)]);
      });
      const ticks = [];
      if (ev) for (let e = 0; e >= EV_MIN; e -= 2) ticks.push([(e - EV_MIN) / -EV_MIN, e === 0 ? '0 EV' : String(e)]);
      else for (let k = 0; k <= 4; k++) { const f = k / 4; ticks.push([f, String(Math.round(lo + f * (white - lo)))]); }
      const satF = ev ? 1 : 1;
      let floorF = null;
      if (opt.sigma) floorF = ev ? (Math.log2(opt.sigma / Math.max(1, white - meanBlack)) - EV_MIN) / -EV_MIN : (meanBlack + opt.sigma - lo) / Math.max(1, white - lo);
      return { counts, ref, ticks, satF, floorF, ev, lo, white, meanBlack, step };
    }

    hover(e) {
      const s = this.data;
      if (!s || !this.tip) return;
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const col = Math.floor((mx - s.L) / (s.pw + s.gap)), row = Math.floor((my - s.T) / (s.ph + s.gap));
      const pi = row * s.cols + col;
      const px = mx - s.L - col * (s.pw + s.gap), py = my - s.T - row * (s.ph + s.gap);
      if (col < 0 || row < 0 || col >= s.cols || pi >= s.panels || px < 0 || px > s.pw || py < 0 || py > s.ph) { this.tip.hidden = true; return; }
      const f = 1 - py / s.ph;
      const column = Math.round(s.rect.x0 + (px / s.pw) * (s.rect.x1 - s.rect.x0));
      const lvl = s.d.ev ? `${(EV_MIN + f * -EV_MIN).toFixed(1)} EV` : `${Math.round(s.d.lo + f * (s.d.white - s.d.lo))} DN`;
      const chans = s.panels > 1 ? [s.opt.channels[pi]] : s.opt.channels;
      const bx = Math.min(s.nx - 1, Math.floor((px / s.pw) * s.nx)), by = Math.min(s.ny - 1, Math.floor((1 - f) * s.ny));
      const parts = chans.map((ch) => { const n = s.d.counts[ch.c] ? s.d.counts[ch.c][by * s.nx + bx] * (s.d.step / 2) : 0; return `<span style="color:${ch.color}">${ch.name}</span> ${n}`; });
      this.tip.innerHTML = `column ${column}, level ${lvl}<br>${parts.join(' · ')} px`;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = Math.min(mx + 12, s.W - tw - 4) + 'px';
      this.tip.style.top = Math.max(0, my - 40) + 'px';
    }
  }

  window.Waveform = Waveform;
})();
