/*
 * Histogram chart rendering (canvas) with hover read-out.
 */
(function () {
  'use strict';

  const { CH_NAMES, CH_COLORS, ALL_COLOR } = window.Analysis;
  const GRID = '#2a2f36', AXIS = '#4a515a', INK = '#8a939d', INK2 = '#b4bbc3';
  const EV_BINS = 10; // bins per EV in EV mode

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  const fmtCount = (v) => (v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k' : String(Math.round(v)));

  /**
   * Bins the 65536-value histograms for display.
   * series: [{ name, color, hist, black }]; returns { edges:[lo,hi][], counts:[Float64Array], ... }
   */
  function binSeries(series, opt, plotW) {
    const { white } = opt;
    if (opt.xMode === 'ev') {
      const range = Math.max(1, white - opt.blackRef);
      const evLo = -Math.max(6, Math.ceil(Math.log2(range)) + 0.5);
      const evHi = 0.5;
      const nb = Math.ceil((evHi - evLo) * EV_BINS);
      const counts = series.map((s) => {
        const out = new Float64Array(nb);
        const r = Math.max(1, white - s.black);
        for (let v = s.black + 1; v < 65536; v++) {
          const k = s.hist[v];
          if (!k) continue;
          const ev = Math.log2((v - s.black) / r);
          let b = Math.floor((ev - evLo) * EV_BINS);
          if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
          out[b] += k;
        }
        return out;
      });
      const below = series.map((s) => { let n = 0; for (let v = 0; v <= s.black; v++) n += s.hist[v]; return n; });
      return { mode: 'ev', lo: evLo, hi: evHi, nb, width: 1 / EV_BINS, counts, below };
    }
    // linear: x = v - (subBlack ? black : 0)
    let lo = Infinity, hi = -Infinity;
    for (const s of series) {
      const off = opt.subBlack ? s.black : 0;
      let mn = -1, mx = 0;
      for (let v = 0; v < 65536; v++) if (s.hist[v]) { if (mn < 0) mn = v; mx = v; }
      if (mn < 0) continue;
      lo = Math.min(lo, mn - off);
      hi = Math.max(hi, mx - off);
    }
    if (!isFinite(lo)) { lo = 0; hi = white; }
    const satX = white - (opt.subBlack ? opt.blackRef : 0);
    if (!opt.fitData) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, satX);
    }
    hi = Math.max(hi, lo + 16);
    hi += Math.max(1, (hi - lo) * 0.02);
    let w = opt.bin === 'auto' ? Math.max(1, Math.pow(2, Math.ceil(Math.log2((hi - lo) / Math.max(64, plotW))))) : +opt.bin;
    lo = Math.floor(lo / w) * w;
    const nb = Math.max(1, Math.ceil((hi - lo) / w));
    const counts = series.map((s) => {
      const out = new Float64Array(nb);
      const off = opt.subBlack ? s.black : 0;
      for (let v = 0; v < 65536; v++) {
        const k = s.hist[v];
        if (!k) continue;
        const b = Math.floor((v - off - lo) / w);
        if (b >= 0 && b < nb) out[b] += k;
      }
      return out;
    });
    return { mode: 'linear', lo, hi: lo + nb * w, nb, width: w, counts };
  }

  class HistChart {
    constructor(canvas, tip) {
      this.canvas = canvas;
      this.tip = tip;
      this.state = null;
      if (tip) {
        canvas.addEventListener('mousemove', (e) => this.hover(e));
        canvas.addEventListener('mouseleave', () => { this.tip.hidden = true; this.hoverX = null; this.redraw(); });
      }
    }

    /**
     * series: [{ name, color, hist, black, dashed }]
     * opt: { xMode, yMode, bin, subBlack, white, blackRef, fitData, layout, title }
     */
    draw(series, opt) {
      this.series = series;
      this.opt = opt;
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (!W || !H) return;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      this.dims = { W, H, dpr, left: 46, right: 10, top: 10, bottom: 24 };
      const plotW = W - this.dims.left - this.dims.right;
      this.bins = series.length ? binSeries(series, opt, plotW) : null;
      this.redraw();
    }

    redraw() {
      const c = this.canvas, d = this.dims;
      if (!d) return;
      const ctx = c.getContext('2d');
      ctx.setTransform(d.dpr, 0, 0, d.dpr, 0, 0);
      ctx.clearRect(0, 0, d.W, d.H);
      if (!this.bins) return;
      const opt = this.opt, b = this.bins;
      const L = d.left, R = d.W - d.right, T = d.top, B = d.H - d.bottom;
      const xOf = (x) => L + ((x - b.lo) / (b.hi - b.lo)) * (R - L);
      this.xOf = xOf;
      this.xInv = (px) => b.lo + ((px - L) / (R - L)) * (b.hi - b.lo);

      const panels = opt.layout === 'stacked' ? this.series.map((s, i) => [i]) : [this.series.map((s, i) => i)];
      const gap = 6;
      const ph = (B - T - gap * (panels.length - 1)) / panels.length;
      ctx.font = '11px system-ui, sans-serif';

      // x grid + labels (shared)
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const ticks = [];
      if (b.mode === 'ev') {
        const step = (b.hi - b.lo) > 10 ? 2 : 1;
        for (let e = Math.ceil(b.lo / step) * step; e <= b.hi; e += step) ticks.push([e, e === 0 ? '0 EV' : String(e)]);
      } else {
        const st = niceStep(b.hi - b.lo, Math.max(3, (R - L) / 70));
        for (let v = Math.ceil(b.lo / st) * st; v <= b.hi; v += st) ticks.push([v, String(Math.round(v))]);
      }
      for (const [v, label] of ticks) {
        const x = Math.round(xOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
        ctx.fillText(label, x, B + 6);
      }

      panels.forEach((idx, pi) => {
        const pT = T + pi * (ph + gap), pB = pT + ph;
        // y scale: ignore the spikes in the first/last bins and at saturation
        let ymax = 0, trueMax = 0;
        const satBin = b.mode === 'ev' ? Math.floor((0 - b.lo) * EV_BINS) : Math.floor((opt.white - (opt.subBlack ? opt.blackRef : 0) - b.lo) / b.width);
        for (const i of idx) {
          const cnt = b.counts[i];
          for (let k = 0; k < b.nb; k++) {
            trueMax = Math.max(trueMax, cnt[k]);
            if (k === 0 || k === b.nb - 1 || Math.abs(k - satBin) <= 1) continue;
            ymax = Math.max(ymax, cnt[k]);
          }
        }
        if (!ymax) ymax = trueMax || 1;
        const log = opt.yMode === 'log';
        const yv = (v) => (log ? Math.log10(1 + v) / Math.log10(1 + trueMax || 10) : v / ymax);
        const yOf = (v) => pB - Math.min(1, yv(v)) * (pB - pT - 4);

        ctx.strokeStyle = AXIS;
        ctx.beginPath(); ctx.moveTo(L, Math.round(pB) + 0.5); ctx.lineTo(R, Math.round(pB) + 0.5); ctx.stroke();
        // y labels
        ctx.fillStyle = INK; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const yt = log ? [10, 1000, 100000, 1e7].filter((v) => v <= trueMax * 1.01) : [ymax / 2, ymax];
        ctx.strokeStyle = GRID;
        for (const v of yt) {
          const y = Math.round(yOf(v)) + 0.5;
          if (y < pT + 6) continue;
          ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
          ctx.fillText(fmtCount(v), L - 6, y);
        }

        // level markers
        const marker = (x, color, label) => {
          if (x < L || x > R) return;
          ctx.save();
          ctx.strokeStyle = color; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, pT); ctx.lineTo(Math.round(x) + 0.5, pB); ctx.stroke();
          ctx.restore();
          if (pi === 0) {
            ctx.fillStyle = INK2; ctx.textBaseline = 'top';
            const tw = ctx.measureText(label).width;
            const right = x + 4 + tw > R;
            ctx.textAlign = right ? 'right' : 'left';
            ctx.fillText(label, Math.round(x) + (right ? -4 : 4), pT + (right ? 14 : 1));
          }
        };
        if (b.mode === 'ev') {
          marker(xOf(0), '#ff6b6b', 'saturation');
          if (opt.noise > 0) marker(xOf(Math.log2(opt.noise / Math.max(1, opt.white - opt.blackRef))), '#6f8fd8', 'noise floor');
        } else {
          marker(xOf(opt.white - (opt.subBlack ? opt.blackRef : 0)), '#ff6b6b', 'saturation');
          if (!opt.subBlack) marker(xOf(opt.blackRef), '#8a939d', 'black');
          // the noise floor is only worth a marker when it is distinguishable from black
          if (opt.noise > 0 && xOf(opt.noise) - xOf(0) > 24) marker(xOf((opt.subBlack ? 0 : opt.blackRef) + opt.noise), '#6f8fd8', '1σ');
        }

        // series
        for (const i of idx) {
          const s = this.series[i], cnt = b.counts[i];
          const path = new Path2D();
          path.moveTo(xOf(b.lo), pB);
          for (let k = 0; k < b.nb; k++) {
            const x0 = xOf(b.lo + k * b.width), x1 = xOf(b.lo + (k + 1) * b.width);
            const y = yOf(cnt[k]);
            path.lineTo(x0, y);
            path.lineTo(x1, y);
          }
          path.lineTo(xOf(b.hi), pB);
          ctx.globalAlpha = idx.length > 1 ? 0.14 : 0.3;
          ctx.fillStyle = s.color;
          ctx.fill(path);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = s.color; ctx.lineWidth = 1.5;
          if (s.dashed) ctx.setLineDash([4, 3]);
          ctx.stroke(path);
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          // spike overflow marker
          for (let k = 0; k < b.nb; k++) {
            if (!log && cnt[k] > ymax * 1.02) {
              const x = xOf(b.lo + (k + 0.5) * b.width);
              ctx.fillStyle = s.color;
              ctx.beginPath(); ctx.moveTo(x - 4, pT + 7); ctx.lineTo(x + 4, pT + 7); ctx.lineTo(x, pT + 1); ctx.fill();
            }
          }
        }
        if (opt.layout === 'stacked' || opt.title) {
          const s0 = this.series[idx[0]];
          ctx.fillStyle = opt.layout === 'stacked' ? s0.color : INK2;
          ctx.textBaseline = 'top';
          ctx.font = '600 11px system-ui, sans-serif';
          if (opt.layout === 'stacked') { ctx.textAlign = 'left'; ctx.fillText(s0.name, L + 6, pT + 14); }
          else { ctx.textAlign = 'right'; ctx.fillText(opt.title, R - 2, pT + 28); }
          ctx.font = '11px system-ui, sans-serif';
        }
      });

      if (this.hoverX != null) {
        ctx.strokeStyle = 'rgba(229,232,235,.55)';
        ctx.beginPath(); ctx.moveTo(Math.round(this.hoverX) + 0.5, T); ctx.lineTo(Math.round(this.hoverX) + 0.5, B); ctx.stroke();
      }
    }

    hover(e) {
      if (!this.bins || !this.dims) return;
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const d = this.dims, b = this.bins;
      if (px < d.left || px > d.W - d.right) { this.tip.hidden = true; this.hoverX = null; this.redraw(); return; }
      const x = this.xInv(px);
      const k = Math.floor((x - b.lo) / b.width);
      if (k < 0 || k >= b.nb) return;
      this.hoverX = px;
      this.redraw();
      const lo = b.lo + k * b.width, hi = lo + b.width;
      let head;
      if (b.mode === 'ev') head = `${lo.toFixed(1)} … ${hi.toFixed(1)} EV`;
      else head = b.width === 1 ? `value ${lo}` : `${lo} … ${hi - 1}`;
      let html = `<div class="t-head">${head}</div>`;
      this.series.forEach((s, i) => {
        const total = this.totals ? this.totals[i] : 0;
        const v = b.counts[i][k];
        html += `<div class="t-row"><span class="sw" style="background:${s.color}"></span>${s.name}<span class="v">${v.toLocaleString("en-US")}${total ? ' · ' + ((100 * v) / total).toFixed(2) + '%' : ''}</span></div>`;
      });
      this.tip.innerHTML = html;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let tx = px + 14, ty = py - th / 2;
      if (tx + tw > d.W - 4) tx = px - tw - 14;
      ty = Math.max(4, Math.min(d.H - th - 4, ty));
      this.tip.style.left = tx + 'px';
      this.tip.style.top = ty + 'px';
    }

    /** CSV of the current binning. */
    csv() {
      if (!this.bins) return '';
      const b = this.bins;
      const head = [b.mode === 'ev' ? 'ev_from' : 'value_from', b.mode === 'ev' ? 'ev_to' : 'value_to', ...this.series.map((s) => s.name)];
      const lines = [head.join(',')];
      for (let k = 0; k < b.nb; k++) {
        const lo = b.lo + k * b.width;
        const hi = b.mode === 'ev' ? lo + b.width : lo + b.width - 1;
        lines.push([b.mode === 'ev' ? lo.toFixed(2) : lo, b.mode === 'ev' ? hi.toFixed(2) : hi, ...b.counts.map((c) => c[k])].join(','));
      }
      return lines.join('\n');
    }
  }

  window.HistChart = HistChart;
  window.HistColors = { CH_NAMES, CH_COLORS, ALL_COLOR };
})();
