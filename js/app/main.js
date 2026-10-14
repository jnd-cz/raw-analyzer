/*
 * Raw Analyzer UI wiring.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { CH_NAMES, CH_COLORS, ALL_COLOR } = window.Analysis;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, d = 1) => (v === undefined || v === null || !isFinite(v) ? '–' : Number.isInteger(v) && d <= 1 ? String(v) : v.toFixed(d));
  const fmtEV = (v) => (v === -Infinity ? '−∞' : !isFinite(v) ? '–' : Math.abs(v) < 0.005 ? '0.00' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2));
  const fmtInt = (n) => n.toLocaleString('en-US');
  const fmtPct = (v) => (!isFinite(v) ? '–' : v === 0 ? '0' : v < 0.001 ? '<0.001' : v.toFixed(v < 1 ? 3 : 2));
  const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' kB');
  const CFA_LETTERS = ['R', 'G', 'B', 'G'];

  const state = {
    img: null,
    levels: null,
    fileLevels: null,
    wb: { asshot: null, auto: null, none: [1, 1, 1, 1], custom: null },
    wbMode: 'asshot',
    area: 'active',
    histCache: new Map(),
    histo: null,
    stats: null,
    visible: [true, true, true, true],
    thumbUrls: [],
  };

  const viewer = new Viewer($('view'), $('viewport'));
  const chart = new HistChart($('histCanvas'), $('histTip'));
  const chartAll = new HistChart($('histCanvasAll'), null);
  const waveform = new Waveform($('waveCanvas'), $('waveTip'));

  // ------------------------------------------------------------ open file
  function openFile(file) {
    if (!file) return;
    $('errorBox').hidden = true;
    const prog = $('progress');
    prog.hidden = false;
    prog.querySelector('.label').textContent = 'Reading ' + file.name;
    prog.style.setProperty('--p', '0%');
    file.arrayBuffer().then((buf) => {
      prog.querySelector('.label').textContent = 'Decoding';
      return decodeRaw(buf, file.name, (p) => prog.querySelector('.bar').style.setProperty('--p', Math.round(p * 100) + '%'));
    }).then((img) => {
      prog.hidden = true;
      loadImage(img);
    }).catch((err) => {
      prog.hidden = true;
      console.error(err);
      const box = $('errorBox');
      box.textContent = 'Could not open ' + file.name + ': ' + err.message;
      box.hidden = false;
    });
  }

  const RGB_NAMES = ['R', 'G', 'B', 'G2'], RGB_COLORS = ['#ff5a52', '#4cc96a', '#4d8dff', '#2fb3a6'];
  const CMYG_COLORS = ['#4cc96a', '#e05bd0', '#3cc4e0', '#e8c547'];

  /** Channel slots are R, G, B, G2 on Bayer sensors and G, M, C, Y on CMYG ones. */
  function setChannels(img) {
    const names = img.channelNames || RGB_NAMES;
    CH_NAMES.splice(0, 4, ...names);
    CH_COLORS.splice(0, 4, ...(img.colors4 ? CMYG_COLORS : RGB_COLORS));
    document.querySelectorAll('#viewMode option').forEach((o) => {
      const i = { R: 0, G: 1, B: 2, G2: 3 }[o.value];
      if (i !== undefined) o.textContent = 'Channel ' + names[i];
    });
    const cls = ['v-r', 'v-g', 'v-b', 'v-g2'];
    cls.forEach((c, i) => document.documentElement.style.setProperty('--ch-' + c.slice(2), CH_COLORS[i]));
    renderLegend();
  }

  function loadImage(img) {
    state.img = img;
    setChannels(img);
    state.levels = { black: img.black.slice(), white: img.white };
    state.fileLevels = { black: img.black.slice(), white: img.white };
    state.histCache.clear();
    state.selection = null;
    state.sigma = img.noise ? img.noise.sigma.slice() : null;
    viewer.noiseSigma = state.sigma;
    $('underK').querySelectorAll('option').forEach((o) => { o.disabled = !state.sigma && o.value !== '0'; });
    if (!state.sigma) $('underK').value = '0';
    viewer.underK = +$('underK').value;
    $('app').classList.remove('empty');

    // white balance options
    const asShot = img.wbAsShot && img.wbAsShot[0] > 0 && img.wbAsShot[1] > 0 && img.wbAsShot[2] > 0
      ? (() => { const g = img.wbAsShot[1]; return [img.wbAsShot[0] / g, 1, img.wbAsShot[2] / g, 1]; })() : null;
    state.wb.asshot = asShot;
    state.wb.custom = null;
    const activeHisto = histFor('active');
    const activeStats = Analysis.computeStats(activeHisto, state.levels, state.sigma);
    state.wb.auto = Analysis.grayWorld(activeStats, state.levels.black, state.img.colors4);
    const wbSel = $('wbMode');
    wbSel.querySelector('option[value=asshot]').disabled = !asShot;
    wbSel.querySelector('option[value=custom]').disabled = true;
    state.wbMode = asShot ? 'asshot' : 'auto';
    wbSel.value = state.wbMode;

    // area options
    const areaSel = $('histArea');
    areaSel.querySelector('option[value=masked]').disabled = !img.masked;
    areaSel.querySelector('option[value=selection]').disabled = true;
    if (areaSel.value === 'selection' || (areaSel.value === 'masked' && !img.masked)) areaSel.value = 'active';
    state.area = areaSel.value;

    // title
    const f = img.facts;
    $('fileTitle').innerHTML = `<span class="name">${esc(img.fileName)}</span>` +
      `<span class="badge fmt">${esc(img.format)}</span>` +
      (f.model ? `<span class="badge">${esc(f.model)}</span>` : '') +
      `<span class="badge">${img.width} × ${img.height}, ${img.bits} bit</span>`;
    document.title = img.fileName + ' · Raw Analyzer';

    viewer.setImage(img, state.levels, currentWB());
    $('btnExport').disabled = false;
    $('btnCompare').disabled = false;
    autoExposure(activeStats);
    updateAnalysis();
    renderMeta();
    renderInfo();
    updatePtc();
    updatePattern();
    updateDefects();
  }

  // ---------------------------------------------------------------- areas
  function areaRect(area) {
    const img = state.img;
    if (area === 'full') return { x0: 0, y0: 0, x1: img.width, y1: img.height };
    if (area === 'masked' && img.masked) return img.masked.rect;
    if (area === 'selection' && state.selection) return state.selection;
    const a = img.active;
    return { x0: a.left, y0: a.top, x1: a.right, y1: a.bottom };
  }

  function histFor(area) {
    const r = areaRect(area);
    const key = area + ':' + r.x0 + ',' + r.y0 + ',' + r.x1 + ',' + r.y1;
    let h = state.histCache.get(key);
    if (!h) {
      h = Analysis.computeHist(state.img, r);
      if (state.histCache.size > 6) state.histCache.delete(state.histCache.keys().next().value);
      state.histCache.set(key, h);
    }
    return h;
  }

  function currentWB() {
    return state.wb[state.wbMode] || state.wb.auto || [1, 1, 1, 1];
  }

  function autoExposure(stats) {
    const lv = state.levels;
    const g = stats[1];
    if (!g) return;
    const t = (g.p99 - lv.black[1]) / Math.max(1, lv.white - lv.black[1]);
    const ev = t > 0 ? Math.max(-2, Math.min(6, Math.log2(0.7 / t))) : 0;
    setExposure(Math.round(ev * 10) / 10);
  }

  function setExposure(v) {
    viewer.exposure = v;
    $('exposure').value = v;
    $('exposureOut').textContent = (v > 0 ? '+' : '') + v.toFixed(1);
    viewer.requestRender();
  }

  // ------------------------------------------------------------- analysis
  function updateAnalysis() {
    const img = state.img;
    if (!img) return;
    state.histo = histFor(state.area);
    state.stats = Analysis.computeStats(state.histo, state.levels, state.sigma);
    viewer.overlayRect = state.area === 'masked' && img.masked ? img.masked.rect : null;
    viewer.requestRender();
    drawCharts();
    renderQuickStats();
    renderFullStats();
  }

  function drawCharts() {
    if (!state.histo) return;
    const lv = state.levels;
    const layout = $('histLayout').value;
    const wave = $('histScope').value === 'wave';
    $('chartWrap').hidden = $('chartWrapAll').hidden = wave;
    $('waveWrap').hidden = !wave;
    $('histYCtl').hidden = $('histBinCtl').hidden = wave;
    $('histXLabel').textContent = wave ? 'Levels' : 'X axis';
    if (wave) {
      const channels = [0, 1, 2, 3].filter((c) => state.visible[c]).map((c) => ({ c, name: CH_NAMES[c], color: CH_COLORS[c] }));
      waveform.draw(state.img, state.histo.rect, lv, {
        channels, layout, yMode: $('histX').value, subBlack: $('histSubBlack').checked,
        sigma: state.sigma ? state.sigma.reduce((a, b) => a + b, 0) / 4 : 0,
      });
      const r = state.histo.rect;
      $('histNote').textContent = `${(r.x1 - r.x0)} × ${(r.y1 - r.y0)} px · waveform` + (layout === 'stacked' ? ' (parade)' : ' (overlay)');
      return;
    }
    const opt = {
      xMode: $('histX').value,
      yMode: $('histY').value,
      bin: $('histBin').value,
      subBlack: $('histSubBlack').checked,
      white: lv.white,
      blackRef: Math.round((lv.black[0] + lv.black[1] + lv.black[2] + lv.black[3]) / 4),
      fitData: state.area === 'masked',
      layout,
      noise: state.sigma ? state.sigma.reduce((a, b) => a + b, 0) / 4 : 0,
    };
    $('chartWrap').classList.toggle('stacked', layout === 'stacked');
    const series = [];
    const totals = [];
    for (let c = 0; c < 4; c++) {
      if (!state.visible[c]) continue;
      series.push({ name: CH_NAMES[c], color: CH_COLORS[c], hist: state.histo.hist[c], black: lv.black[c], dashed: c === 3 && layout !== 'stacked' });
      totals.push(state.stats[c] ? state.stats[c].n : 0);
    }
    chart.totals = totals;
    chart.draw(series, opt);
    const all = state.histo.all || (state.histo.all = Analysis.sumHist(state.histo.hist));
    chartAll.draw([{ name: 'All', color: ALL_COLOR, hist: all, black: opt.blackRef }], Object.assign({}, opt, { layout: 'overlay', title: 'Combined (all CFA channels)' }));
    const r = state.histo.rect;
    $('histNote').textContent = `${(r.x1 - r.x0)} × ${(r.y1 - r.y0)} px` + (chart.bins && chart.bins.mode === 'linear' ? ` · bin ${chart.bins.width}` : ' · 1/10 EV bins');
  }

  function renderLegend() {
    const el = $('histLegend');
    el.innerHTML = '';
    CH_NAMES.forEach((n, c) => {
      const b = document.createElement('button');
      b.className = state.visible[c] ? '' : 'off';
      b.innerHTML = `<span class="sw" style="background:${CH_COLORS[c]}"></span>${n}`;
      b.title = 'Show or hide ' + n;
      b.onclick = () => {
        state.visible[c] = !state.visible[c];
        if (!state.visible.some(Boolean)) state.visible[c] = true;
        renderLegend();
        drawCharts();
      };
      el.appendChild(b);
    });
  }

  function chCell(i) {
    const name = i < 4 ? CH_NAMES[i] : 'All';
    const color = i < 4 ? CH_COLORS[i] : ALL_COLOR;
    return `<td class="ch"><span class="sw" style="background:${color}"></span>${name}</td>`;
  }

  function renderQuickStats() {
    const s = state.stats;
    let html = '<thead><tr><th>Ch</th><th>Mean</th><th>Median</th><th>σ</th><th>Max</th><th title="Pixels within 1 read-noise sigma of black (at the noise floor)">Floor %</th><th title="Pixels at or above the saturation level">Clip %</th><th title="P99.9 relative to saturation">P99.9 EV</th></tr></thead><tbody>';
    s.forEach((st, i) => {
      if (!st) return;
      html += `<tr>${chCell(i)}<td>${fmt(st.mean)}</td><td>${st.median}</td><td>${fmt(st.sd)}</td><td>${st.max}</td>` +
        `<td>${st.floor1 !== undefined ? fmtPct(st.floor1) : '–'}</td>` +
        `<td class="${st.clippedPct > 0.1 ? 'bad' : st.clippedPct > 0 ? 'warn' : ''}">${fmtPct(st.clippedPct)}</td><td>${fmtEV(st.p999EV)}</td></tr>`;
    });
    $('quickStats').innerHTML = html + '</tbody>';
  }

  const AREA_NAMES = { active: 'image area', full: 'full sensor', masked: 'masked border', selection: 'selection' };

  // counts of a million or more in a compact form (exact value in the tooltip), so the table fits the panel
  const fmtCount = (n) => (n >= 1e6 ? `<span title="${n.toLocaleString('en-US')}">${(n / 1e6).toFixed(2)}M</span>` : n.toLocaleString('en-US'));

  function renderFullStats() {
    const s = state.stats, lv = state.levels, img = state.img;
    const r = state.histo.rect;
    $('statsArea').textContent = `${AREA_NAMES[state.area]}, ${r.x1 - r.x0} × ${r.y1 - r.y0} at (${r.x0}, ${r.y0})`;
    const rows = [
      ['Pixels', (st) => fmtCount(st.n)],
      ['Black level', (st, i) => (i < 4 ? lv.black[i] : Math.round(lv.black.reduce((a, b) => a + b) / 4))],
      ['Min', (st) => st.min],
      ['Max', (st) => st.max],
      ['Mean', (st) => fmt(st.mean, 2)],
      ['Mean − black', (st, i) => fmt(st.mean - (i < 4 ? lv.black[i] : lv.black.reduce((a, b) => a + b) / 4), 2)],
      ['Median', (st) => st.median],
      ['Std. dev. σ', (st) => fmt(st.sd, 2)],
      ['P0.1', (st) => st.p001],
      ['P99', (st) => st.p99],
      ['P99.9', (st) => st.p999],
      ['≤ black %', (st) => fmtPct(st.underPct)],
      ['≥ saturation %', (st) => fmtPct(st.clippedPct)],
      ['≥ saturation px', (st) => fmtCount(st.clipped)],
      ['Mean EV', (st) => fmtEV(st.meanEV)],
      ['Median EV', (st) => fmtEV(st.medianEV)],
      ['P99.9 EV', (st) => fmtEV(st.p999EV)],
      ['Max EV', (st) => fmtEV(st.maxEV)],
    ];
    let html = '<thead><tr><th></th>' + [0, 1, 2, 3, 4].map((i) => `<th style="color:${i < 4 ? CH_COLORS[i] : ALL_COLOR}">${i < 4 ? CH_NAMES[i] : 'All'}</th>`).join('') + '</tr></thead><tbody>';
    for (const [label, f] of rows) {
      html += `<tr><td>${label}</td>` + s.map((st, i) => `<td>${st ? f(st, i) : '–'}</td>`).join('') + '</tr>';
    }
    $('fullStats').innerHTML = html + '</tbody>';

    // exposure notes (always for the image area unless a selection is active)
    const notes = [];
    const ref = state.area === 'selection' || state.area === 'active' ? s : Analysis.computeStats(histFor('active'), lv, state.sigma);
    const where = state.area === 'selection' ? 'in the selection' : 'in the image area';
    const clipCh = [0, 1, 2, 3].filter((c) => ref[c] && ref[c].clipped > 0);
    if (clipCh.length) notes.push(`<p><b>Clipping ${where}:</b> ` + clipCh.map((c) => `${CH_NAMES[c]} ${fmtPct(ref[c].clippedPct)}% (${ref[c].clipped.toLocaleString("en-US")} px)`).join(', ') + '.</p>');
    else notes.push(`<p><b>No clipped pixels ${where}.</b></p>`);
    const brightest = [0, 1, 2, 3].filter((c) => ref[c]).reduce((a, c) => (ref[c].p999EV > (ref[a] ? ref[a].p999EV : -Infinity) ? c : a), 0);
    if (ref[brightest]) {
      const h = -ref[brightest].p999EV;
      notes.push(`<p>Brightest 0.1% (P99.9) of the <b>${CH_NAMES[brightest]}</b> channel sits at <b>${fmtEV(ref[brightest].p999EV)} EV</b> relative to saturation` +
        (h > 0.05 ? `, so roughly <b>${h.toFixed(1)} EV</b> of highlight headroom was left unused.` : ', i.e. the exposure is at or past the clipping point.') + '</p>');
    }
    notes.push(`<p class="muted">Black: ${esc(img.blackSource)}. Saturation ${lv.white}: ${esc(img.whiteSource)}. Data maximum ${img.maxValue} (${img.maxCount.toLocaleString("en-US")} px).</p>`);
    $('exposureNotes').innerHTML = notes.join('');
    renderShadows(s, ref, where);

    // levels
    let lvh = '<thead><tr><th></th><th>Black</th><th>File</th></tr></thead><tbody>';
    for (let c = 0; c < 4; c++) lvh += `<tr>${chCell(c)}<td><input type="number" data-black="${c}" value="${lv.black[c]}" min="0" max="65535"></td><td>${state.fileLevels.black[c]}</td></tr>`;
    lvh += `<tr><td>Saturation</td><td><input type="number" id="whiteInput" value="${lv.white}" min="1" max="65535"></td><td>${state.fileLevels.white}</td></tr></tbody>`;
    const lt = $('levelsTable');
    if (!lt.contains(document.activeElement)) lt.innerHTML = lvh;

    // masked
    let mh;
    if (img.masked) {
      const m = img.masked;
      mh = `<thead><tr><th>Ch</th><th>Mean</th><th>Median</th><th>σ</th><th>Pixels</th></tr></thead><tbody>`;
      m.ch.forEach((c, i) => { if (c) mh += `<tr>${chCell(i)}<td>${c.mean.toFixed(2)}</td><td>${c.median}</td><td>${c.sd.toFixed(2)}</td><td>${c.n.toLocaleString("en-US")}</td></tr>`; });
      mh += `<tr><td colspan="5" class="muted" style="font-family:inherit;text-align:left">Area x ${m.rect.x0}–${m.rect.x1 - 1}, y ${m.rect.y0}–${m.rect.y1 - 1} (trimmed 0.5% tails)</td></tr></tbody>`;
    } else mh = '<tbody><tr><td class="muted">This file has no masked (optical black) border.</td></tr></tbody>';
    $('maskedStats').innerHTML = mh;
  }

  // ------------------------------------------------- photon transfer estimate
  let ptcTimer = 0;
  function updatePtc() {
    state.ptc = null;
    $('ptcKv').innerHTML = '<div class="muted">Computing&hellip;</div>';
    $('pushTable').innerHTML = '';
    $('ptcNotes').innerHTML = '';
    clearTimeout(ptcTimer);
    const img = state.img;
    ptcTimer = setTimeout(() => {
      if (state.img !== img) return;
      state.ptc = Analysis.photonTransfer(img, state.levels, state.sigma);
      renderPtc();
    }, 60);
  }

  function renderPtc() {
    const p = state.ptc, img = state.img;
    if (!p) return;
    drawPtc();
    if (!p.ok) {
      $('ptcKv').innerHTML = `<div class="muted" style="grid-column:1/-1">No estimate: ${esc(p.reason)}. A frame with smooth areas over a wide range of brightness (sky, walls, out of focus background) works best.</div>`;
      $('pushTable').innerHTML = '';
      $('ptcNotes').innerHTML = '';
      return;
    }
    const iso = img.facts.iso ? `ISO ${img.facts.iso}` : 'unknown ISO';
    const conf = { good: 'good', fair: 'fair: limited brightness range', low: 'low: very few flat areas' }[p.confidence];
    const rows = [
      ['Conditions', `${iso}, ${p.patches.toLocaleString('en-US')} patches, fit over ${p.spanEV.toFixed(1)} EV of signal`],
      ['Confidence', conf],
      ['Gain', `${p.gain.toFixed(2)} e⁻/DN (${(1 / p.gain).toFixed(3)} DN/e⁻)` +
        (img.facts.iso && img.facts.iso !== 100 ? `, ≈ ${(p.gain * img.facts.iso / 100).toFixed(1)} e⁻/DN scaled to ISO 100` : '')],
      ['Read noise', `${p.readDN.toFixed(2)} DN = ${p.readE.toFixed(1)} e⁻ (${p.readSource})`],
      ['Full well', `${Math.round(p.fwc).toLocaleString('en-US')} e⁻ at saturation (${Math.round(p.sat)} DN above black)`],
      ['Dynamic range', `${p.edr.toFixed(1)} EV to the read noise (SNR 1)`],
      ['Usable range', `SNR 4 at ${fmtEV(-p.ev[4])} EV, SNR 10 at ${fmtEV(-p.ev[10])} EV, SNR 20 at ${fmtEV(-p.ev[20])} EV`],
    ];
    $('ptcKv').innerHTML = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');

    const cls = (v) => (v >= 10 ? 'good' : v >= 4 ? '' : v >= 2 ? 'warn' : 'bad');
    let html = '<thead><tr><th>SNR after push</th>' + [0, 1, 2, 3, 4, 5].map((n) => `<th>${n ? '+' + n : '0'} EV</th>`).join('') + '</tr></thead><tbody>';
    html += '<tr><td>Mid-tone (−3 EV)</td>' + p.push.map((x) => `<td class="${cls(x[0])}">${x[0].toFixed(1)}</td>`).join('') + '</tr>';
    html += '<tr><td>Shadow (−6 EV)</td>' + p.push.map((x) => `<td class="${cls(x[1])}">${x[1].toFixed(1)}</td>`).join('') + '</tr>';
    $('pushTable').innerHTML = html + '</tbody>';

    const maxPush = (k) => { let n = 0; while (n < 5 && p.push[n + 1][1] >= k) n++; return n; };
    $('ptcNotes').innerHTML =
      `<p>The table shows the per-pixel signal-to-noise ratio when a scene is exposed darker by the given amount and brightened back in post. ` +
      `Shadows stay above SNR 4 (grainy but usable) up to about <b>+${maxPush(4)} EV</b> of push, and above SNR 10 (clean) up to <b>+${maxPush(10)} EV</b>.</p>` +
      '<p class="muted">Dots: measured noise per ¼ EV signal bin (10th percentile of 8×8 same-colour patches, so texture is mostly ignored). ' +
      'Hollow dots are outside the fit range. Line: fitted model noise² = floor² + signal / gain + (k · signal)², where the last term takes up pixel ' +
      'response non-uniformity and leftover texture. Random noise only: banding is in the Pattern noise section.</p>' +
      '<p class="muted">Accuracy: against flat-field measurements of a 5D Mark II, single frames landed within 3–9% of the gain at ISO 1600 and on a ' +
      'shadow-heavy ISO 100 scene, and 24% low on a busy ISO 100 scene (texture still reads as noise). Older tests on D30, D60, 10D and EOS-1D frames ' +
      'gave ±25% for most images. Treat one image as a rough figure and compare a few. ' +
      'The dynamic range and push figures move far less (a few tenths of an EV), because they depend mostly on the read noise. ' +
      'Gain scales with ISO, so compare frames by the ISO 100 figure; high ISO frames are often the most reliable, as noise swamps texture.</p>';
  }

  function drawPtc() {
    const c = $('ptcCanvas'), p = state.ptc;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H || !p) return;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!p.pts.length) return;
    const L = 40, R = W - 10, T = 10, B = H - 26;
    const xHi = Math.log2(Math.max(16, p.sat));
    const ys = p.pts.map((q) => Math.sqrt(q.V));
    const yLo = Math.floor(Math.log2(Math.min(0.5, ...ys)));
    const yHi = Math.ceil(Math.log2(Math.max(...ys) * 1.2));
    const X = (s) => L + (Math.log2(Math.max(s, 1)) / xHi) * (R - L);
    const Y = (n) => B - ((Math.log2(n) - yLo) / (yHi - yLo)) * (B - T);
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = '#2a2f36'; ctx.fillStyle = '#8a939d';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let e = 0; e <= xHi; e += 2) {
      const x = Math.round(X(2 ** e)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(String(2 ** e), x, B + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let e = yLo; e <= yHi; e++) {
      const y = Math.round(Y(2 ** e)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke();
      ctx.fillText(e >= 0 ? String(2 ** e) : '1/' + 2 ** -e, L - 6, y);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('signal above black (DN)', L + 4, B - 2);
    ctx.save(); ctx.translate(11, (T + B) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('noise σ (DN)', 0, 0); ctx.restore();
    // saturation marker
    ctx.strokeStyle = '#ff6b6b'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(X(p.sat)) + 0.5, T); ctx.lineTo(Math.round(X(p.sat)) + 0.5, B); ctx.stroke();
    if (p.ok) {
      ctx.strokeStyle = '#6f8fd8';
      ctx.beginPath(); ctx.moveTo(L, Y(p.readDN)); ctx.lineTo(R, Y(p.readDN)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#b4bbc3'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText('read noise', R - 4, Y(p.readDN) - 2);
      ctx.strokeStyle = '#e5e8eb'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const s = 2 ** ((i / 120) * xHi);
        const x = X(s), y = Y(p.model(s));
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.setLineDash([]);
    for (const q of p.pts) {
      const inFit = q.S > 8 && q.S < 0.5 * p.sat;
      ctx.beginPath(); ctx.arc(X(q.S), Y(Math.sqrt(q.V)), 4, 0, 2 * Math.PI);
      if (inFit) { ctx.fillStyle = '#4c9aff'; ctx.fill(); ctx.strokeStyle = '#181b1f'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }
      else { ctx.strokeStyle = '#4c9aff'; ctx.stroke(); }
    }
    c._ptcGeom = { X, Y };
  }

  $('ptcCanvas').addEventListener('mousemove', (e) => {
    const p = state.ptc, g = $('ptcCanvas')._ptcGeom, tip = $('ptcTip');
    if (!p || !g) return;
    const rect = e.target.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best = null, bd = 196;
    for (const q of p.pts) {
      const d = (g.X(q.S) - mx) ** 2 + (g.Y(Math.sqrt(q.V)) - my) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    if (!best) { tip.hidden = true; return; }
    const sd = Math.sqrt(best.V);
    tip.innerHTML = `<div class="t-head">signal ${best.S.toFixed(1)} DN (${fmtEV(Math.log2(best.S / p.sat))} EV)</div>` +
      `<div class="t-row">measured σ<span class="v">${sd.toFixed(2)} DN</span></div>` +
      (p.ok ? `<div class="t-row">model σ<span class="v">${p.model(best.S).toFixed(2)} DN</span></div>` : '') +
      `<div class="t-row">SNR<span class="v">${(best.S / sd).toFixed(1)}</span></div>` +
      `<div class="t-row">patches<span class="v">${best.n.toLocaleString('en-US')}</span></div>`;
    tip.hidden = false;
    tip.style.left = Math.min(mx + 14, rect.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = Math.max(4, my - tip.offsetHeight - 8) + 'px';
  });
  $('ptcCanvas').addEventListener('mouseleave', () => { $('ptcTip').hidden = true; });
  new ResizeObserver(() => drawPtc()).observe($('ptcWrap'));

  /** Shadow / noise floor section of the Statistics tab. */
  function renderShadows(s, ref, where) {
    const img = state.img;
    if (!state.sigma) {
      $('noiseSource').textContent = '';
      $('shadowStats').innerHTML = '';
      $('shadowNotes').innerHTML = '<p>The read noise cannot be measured for this file: it has no masked border, and the darkest image areas are clipped at zero by the camera (in-camera black subtraction). ' +
        'Pixels at or below black: ' + [0, 1, 2, 3].filter((c) => s[c]).map((c) => `${CH_NAMES[c]} ${fmtPct(s[c].underPct)}%`).join(', ') + '.</p>';
      return;
    }
    $('noiseSource').textContent = '(noise σ from ' + img.noise.source + ')';
    const rows = [
      ['Read noise σ (DN)', (st) => fmt(st.sigma, 2)],
      ['Noise floor (EV)', (st) => fmtEV(st.floorEV)],
      ['Dynamic range (EV)', (st) => fmt(st.dr, 1)],
      ['≤ black %', (st) => fmtPct(st.underPct)],
      ['< 1σ % (floor)', (st) => fmtPct(st.floor1)],
      ['< 2σ %', (st) => fmtPct(st.floor2)],
      ['< 4σ %', (st) => fmtPct(st.floor4)],
      ['< 10σ %', (st) => fmtPct(st.floor10)],
      ['P10 SNR', (st) => fmt(st.p10SNR, 1)],
      ['Median SNR', (st) => fmt(st.medianSNR, 1)],
    ];
    let html = '<thead><tr><th></th>' + [0, 1, 2, 3, 4].map((i) => `<th style="color:${i < 4 ? CH_COLORS[i] : ALL_COLOR}">${i < 4 ? CH_NAMES[i] : 'All'}</th>`).join('') + '</tr></thead><tbody>';
    for (const [label, f] of rows) html += `<tr><td>${label}</td>` + s.map((st, i) => `<td>${st && st.sigma ? f(st, i) : '–'}</td>`).join('') + '</tr>';
    $('shadowStats').innerHTML = html + '</tbody>';

    const g = ref[1], a = ref[4];
    const notes = [];
    if (a && a.sigma) {
      notes.push(`<p>Read noise is <b>${fmt(a.sigma, 2)} DN</b>, which puts the noise floor <b>${fmtEV(a.floorEV)} EV</b> below saturation (engineering dynamic range ≈ <b>${fmt(a.dr, 1)} EV</b>).</p>`);
      notes.push(`<p>${where[0].toUpperCase() + where.slice(1)}: <b>${fmtPct(a.floor1)}%</b> of the pixels are within 1σ of black (indistinguishable from noise), ` +
        `<b>${fmtPct(a.floor4)}%</b> are below 4σ (visibly noisy) and <b>${fmtPct(a.floor10)}%</b> below 10σ.` +
        (g ? ` The darkest 10% of the G channel has a read-noise SNR of <b>${fmt(g.p10SNR, 1)}</b>.` : '') + '</p>');
      const weakest = [0, 1, 2, 3].filter((c) => ref[c] && ref[c].sigma).reduce((a, c) => (ref[c].floor4 > ref[a].floor4 ? c : a), 0);
      if (ref[weakest] && g && ref[weakest].floor4 > 1.5 * g.floor4 + 0.01)
        notes.push(`<p>The <b>${CH_NAMES[weakest]}</b> channel reaches the noise floor first: ${fmtPct(ref[weakest].floor4)}% of its pixels are below 4σ, against ${fmtPct(g.floor4)}% for G. ` +
          'Lifted shadows will show colour (chroma) noise before they show grain in the luminance.</p>');
    }
    notes.push('<p class="muted">SNR here counts read noise only. Photon shot noise makes the real SNR lower at higher signal levels. Turn on <i>Shadows</i> in the viewer toolbar to see where these areas are.</p>');
    $('shadowNotes').innerHTML = notes.join('');
  }

  // ---------------------------------------------------------- pattern noise
  /** Dark frame (lens cap on): every channel within 20 read-noise sigmas of black at the 99th percentile. */
  function isDarkFrame() {
    if (!state.sigma) return false;
    const st = Analysis.computeStats(histFor('active'), state.levels, state.sigma);
    return [0, 1, 2, 3].every((i) => st[i] && st[i].p99 - state.levels.black[i] < 20 * state.sigma[i]);
  }

  function updatePattern() {
    state.pattern = Analysis.patternNoise(state.img, state.levels.black, isDarkFrame());
    renderPattern();
  }

  function renderPattern() {
    const p = state.pattern;
    if (!p) {
      $('patternStats').innerHTML = '';
      $('patternNotes').innerHTML = '<p class="muted">Needs an optically black (masked) border, which this file does not have.</p>';
      return;
    }
    const ratio = (c, i) => (c && p.random[i] ? c.line / p.random[i] : null);
    const cls = (r) => (r >= 0.25 ? 'bad' : r >= 0.1 ? 'warn' : '');
    const line = (o, i) => {
      const c = o && o.ch[i];
      if (!c) return '<td>–</td>';
      return c.detected ? `<td>${fmt(c.line, 2)}</td>` : `<td class="muted" title="not detected; upper limit">&lt;${fmt(c.limit, 2)}</td>`;
    };
    const rel = (o, i) => {
      const c = o && o.ch[i], r = ratio(c, i);
      if (r === null) return '<td>–</td>';
      return c.detected ? `<td class="${cls(r)}">${Math.round(100 * r)}%</td>` : `<td class="muted">&lt;${Math.round((100 * c.limit) / p.random[i])}%</td>`;
    };
    const ch = [0, 1, 2, 3];
    let html = '<thead><tr><th></th>' + ch.map((i) => `<th style="color:${CH_COLORS[i]}">${CH_NAMES[i]}</th>`).join('') + '</tr></thead><tbody>';
    html += '<tr><td>Random noise σ (DN)</td>' + ch.map((i) => `<td>${fmt(p.random[i], 2)}</td>`).join('') + '</tr>';
    html += '<tr><td title="horizontal banding: offsets shared by a whole row">Row noise σ</td>' + ch.map((i) => line(p.rows, i)).join('') + '</tr>';
    html += '<tr><td>Row / random</td>' + ch.map((i) => rel(p.rows, i)).join('') + '</tr>';
    html += '<tr><td title="vertical banding: offsets shared by a whole column">Column noise σ</td>' + ch.map((i) => line(p.cols, i)).join('') + '</tr>';
    html += '<tr><td>Column / random</td>' + ch.map((i) => rel(p.cols, i)).join('') + '</tr>';
    $('patternStats').innerHTML = html + '</tbody>';

    const notes = [];
    const avgPct = (o) => { const v = ch.map((i) => (o && o.ch[i] && p.random[i] ? o.ch[i].line / p.random[i] : null)).filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
    if (p.mode === 'image') {
      $('patternSource').textContent = '(banding, whole image area of this dark frame)';
      const im = avgPct(p.rows), bd = avgPct(p.border);
      notes.push(`<p>This is a <b>dark frame</b>, so rows and columns are measured over the whole image area (${p.rows.width} × ${p.rows.length} px): the definitive numbers for this ISO and exposure time.` +
        (bd !== null && im ? ` The ${p.borderSide} masked border alone shows ${Math.round(bd * 100)}% row noise` + (im > bd * 1.5 ? `, ${(im / Math.max(bd, 1e-6)).toFixed(1)}× less than the image area, so border-only figures on normal photos understate it.` : ', in line with the image area.') : '') + '</p>');
    } else {
      $('patternSource').textContent = '(banding, masked border only)';
      notes.push(p.rows
        ? `<p>Row noise is measured across the ${p.borderSide} masked border (${p.rows.width} × ${p.rows.length} px). Treat it as a <b>lower bound</b>: ` +
          'the image area can band more than the border (on the 5D Mark II about 3× more). Column noise and the true figures need a <b>dark frame</b> ' +
          'at the same ISO: lens cap and eyepiece cover on, which this tab then measures over the whole sensor.' + (p.rejected.length ? ' Not used: ' + p.rejected.join(', ') + '.' : '') + '</p>'
        : '<p>No usable masked strip along the left or right. Take a dark frame (lens cap on) to measure banding over the image area.</p>');
    }
    const det = (o, i) => (o && o.ch[i] && o.ch[i].detected ? ratio(o.ch[i], i) : 0);
    const worstRow = Math.max(0, ...ch.map((i) => det(p.rows, i))), worstCol = Math.max(0, ...ch.map((i) => det(p.cols, i)));
    const worst = Math.max(worstRow, worstCol);
    const dir = worstRow >= 0.8 * worst && worstCol >= 0.8 * worst ? 'horizontal and vertical' : worstCol > worstRow ? 'vertical' : 'horizontal';
    const pct = Math.round(worst * 100);
    let verdict;
    if (worst < 0.05) verdict = '<b>No banding detected.</b> Line offsets are below 5% of the random noise, too weak to see even in pushed shadows.';
    else if (worst < 0.1) verdict = `<b>Faint ${dir} pattern</b> (${pct}% of the random noise): visible at most in flat, strongly pushed shadows.`;
    else if (worst < 0.25) verdict = `<b>Moderate ${dir} banding</b> (${pct}% of the random noise): expect stripes in flat areas when shadows are pushed several EV.`;
    else verdict = `<b>Strong ${dir} banding</b> (${pct}% of the random noise): stripes show in lifted shadows and limit how far they can be pushed.`;
    if (p.mode !== 'image') verdict = '<i>In the masked border:</i> ' + verdict.replace('No banding detected.', 'No banding detected there.');
    notes.push('<p>' + verdict + '</p>');
    notes.push('<p class="muted">The eye picks up a stripe across the whole frame at roughly a tenth of the random noise, because it averages along the line. ' +
      'Noise reduction and downsizing remove random noise but leave banding, so banding often sets the real limit for shadow lifting. ' +
      'Values marked &lt; are upper limits: the strip is too small to detect weaker banding.</p>');
    $('patternNotes').innerHTML = notes.join('');
  }



  // ---------------------------------------------------------- hot / stuck / dead pixels
  let defectTimer = 0;
  const KIND_NAMES = { hot: 'hot', stuck: 'stuck (saturated)', dead: 'dead (dark)' };

  function updateDefects() {
    state.defects = null;
    viewer.defects = null;
    $('defectStats').innerHTML = '';
    $('defectList').innerHTML = '';
    $('defectNotes').innerHTML = '<p class="muted">Scanning&hellip;</p>';
    clearTimeout(defectTimer);
    const img = state.img;
    defectTimer = setTimeout(() => {
      if (state.img !== img) return;
      state.defects = Analysis.defectPixels(img, state.levels, state.sigma);
      viewer.defects = state.defects.list;
      renderDefects();
      viewer.requestRender();
    }, 120);
  }

  function renderDefects() {
    const d = state.defects, img = state.img;
    if (!d) return;
    const ch = [0, 1, 2, 3];
    const per = (n) => (n / d.area * 4 * 1e6); // per million pixels of that channel
    const tot = { hot: 0, strong: 0, stuck: 0, dead: 0 };
    for (const k of d.counts) for (const f in tot) tot[f] += k[f];
    let html = '<thead><tr><th></th>' + ch.map((i) => `<th style="color:${CH_COLORS[i]}">${CH_NAMES[i]}</th>`).join('') + '<th>All</th></tr></thead><tbody>';
    const row = (label, f, title) => `<tr><td${title ? ` title="${title}"` : ''}>${label}</td>` + ch.map((i) => `<td>${fmtInt(d.counts[i][f])}</td>`).join('') + `<td>${fmtInt(tot[f])}</td></tr>`;
    html += row('Hot', 'hot', 'above all same-colour neighbours by more than the threshold');
    html += row('of which strong', 'strong', 'more than 64 read-noise sigmas above the neighbours');
    html += row('Stuck (saturated)', 'stuck');
    html += row('Dead (dark)', 'dead', 'below all neighbours in a lit, smooth area');
    html += '<tr><td>Hot per million px</td>' + ch.map((i) => `<td>${fmt(per(d.counts[i].hot), 1)}</td>`).join('') + `<td>${fmt(tot.hot / d.area * 1e6, 1)}</td></tr>`;
    $('defectStats').innerHTML = html + '</tbody>';
    $('defectSource').textContent = `(image area, ${fmtInt(d.list.length)} found${d.truncated ? ', list truncated' : ''})`;

    const top = d.list.slice(0, 12);
    $('defectList').innerHTML = top.length ? '<thead><tr><th>Position</th><th>Ch</th><th>Kind</th><th>Value</th><th>Neighbours</th><th>Excess</th></tr></thead><tbody>' +
      top.map((p, k) => `<tr data-k="${k}"><td>${p.x}, ${p.y}</td><td style="color:${CH_COLORS[p.c]}">${CH_NAMES[p.c]}</td><td>${KIND_NAMES[p.kind]}</td>` +
        `<td>${p.v}</td><td>${p.ref}</td><td>${fmt(p.excess, 0)}σ</td></tr>`).join('') + '</tbody>' : '';

    // dark frame: every channel stays within 20 read-noise sigmas of black (99th percentile)
    const st = Analysis.computeStats(histFor('active'), state.levels, state.sigma);
    const dark = state.sigma && ch.every((i) => st[i] && st[i].p99 - state.levels.black[i] < 20 * state.sigma[i]);
    const notes = [];
    if (!d.list.length) notes.push('<p><b>No defective pixels found.</b></p>');
    if (dark) notes.push('<p>This looks like a <b>dark frame</b> (lens cap on): every hot pixel stands out, so the counts describe the sensor. ' +
      'Hot pixels grow with exposure time and temperature' + (img.cameraTemp !== undefined ? ` (camera at ${img.cameraTemp} °C)` : '') + '; compare frames taken with the same settings.</p>');
    else notes.push('<p>In a normal photo only defects in smooth areas can be told apart from the scene, so these counts are a lower bound. ' +
      'For a sensor check take a <b>dark frame</b>: lens cap and eyepiece cover on, the exposure time and ISO you want to test, long-exposure noise reduction off.</p>');
    notes.push('<p class="muted">A pixel is flagged when its 8 nearest same-colour neighbours agree with each other and it differs from all of them by more than ' +
      'max(20 σ read noise, 3 × their range) + 20% of their level (lower thresholds catch popping noise that does not repeat between frames). Dead pixels are only detectable in lit areas. Click a row to zoom in.</p>');
    $('defectNotes').innerHTML = notes.join('');
  }

  $('defectList').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr || !state.defects) return;
    const p = state.defects.list[+tr.dataset.k];
    $('showDefects').checked = viewer.showDefects = true;
    viewer.centerOn(p.x, p.y, 8);
  });
  $('showDefects').onchange = (e) => { viewer.showDefects = e.target.checked; viewer.requestRender(); };
  $('btnDefectsCsv').onclick = () => {
    const d = state.defects;
    if (!d) return;
    const lines = ['x,y,channel,kind,value,neighbours,excess_sigma'];
    for (const p of d.list) lines.push([p.x, p.y, CH_NAMES[p.c], p.kind, p.v, p.ref, p.excess.toFixed(1)].join(','));
    download(baseName() + '_defects.csv', lines.join('\n'), 'text/csv');
  };

  // ---------------------------------------------------------- compare two files
  /** Analysis results of one image for the comparison (image area). */
  function profileOf(img, levels, sigma, have) {
    const A = img.active;
    const histo = have && have.histo || Analysis.computeHist(img, { x0: A.left, y0: A.top, x1: A.right, y1: A.bottom });
    return {
      img, levels, sigma, histo,
      stats: Analysis.computeStats(histo, levels, sigma),
      pattern: have && have.pattern !== undefined ? have.pattern : Analysis.patternNoise(img, levels.black),
      ptc: have && have.ptc || null,
      defects: have && have.defects || null,
    };
  }

  function compareWith(file) {
    if (!file || !state.img) return;
    const prog = $('progress');
    prog.hidden = false;
    prog.querySelector('.label').textContent = 'Decoding ' + file.name;
    file.arrayBuffer()
      .then((buf) => decodeRaw(buf, file.name, (p) => prog.querySelector('.bar').style.setProperty('--p', Math.round(p * 100) + '%')))
      .then((img) => { prog.hidden = true; setCompare(img); showTab('compare'); })
      .catch((err) => { prog.hidden = true; $('cmpBody').innerHTML = `<p class="bad">Could not open ${esc(file.name)}: ${esc(err.message)}</p>`; showTab('compare'); });
  }

  function setCompare(img) {
    const levels = { black: img.black.slice(), white: img.white };
    const sigma = img.noise ? img.noise.sigma.slice() : null;
    const b = profileOf(img, levels, sigma);
    state.cmp = b;
    renderCompare();
    // the slower estimates follow
    setTimeout(() => {
      if (state.cmp !== b) return;
      b.ptc = Analysis.photonTransfer(img, levels, sigma);
      b.defects = Analysis.defectPixels(img, levels, sigma);
      renderCompare();
    }, 50);
  }

  function profileA() {
    if (!state.ptc) state.ptc = Analysis.photonTransfer(state.img, state.levels, state.sigma);
    return profileOf(state.img, state.levels, state.sigma, { histo: histFor('active'), pattern: state.pattern, ptc: state.ptc, defects: state.defects });
  }

  function renderCompare() {
    const b = state.cmp;
    $('btnCmpSwap').disabled = $('btnCmpClose').disabled = !b;
    if (!b) {
      $('cmpBody').innerHTML = '<p class="muted">Open a second raw file with <b>Compare with&hellip;</b> to see both side by side: ' +
        'exposure, noise, dynamic range, banding and defects. Useful for two bodies, two ISO settings or two exposures of the same scene.</p>';
      $('cmpWrap').hidden = true;
      return;
    }
    const a = profileA();
    const name = (p) => esc(p.img.fileName);
    const f = (p) => p.img.facts;
    const sum = (p, k) => { const r = p.img.summary.find((x) => x[0] === k); return r ? r[1] : '–'; };
    const ch = [0, 1, 2, 3];
    const nCh = (p) => (p.img.colors4 ? 4 : 3);
    const worst = (p, fn) => Math.max(...ch.map((i) => (p.stats[i] ? fn(p.stats[i]) : -Infinity)));
    const least = (p, fn) => Math.min(...ch.map((i) => (p.stats[i] ? fn(p.stats[i]) : Infinity)));
    const gStat = (p) => p.stats[1];
    const meanSigma = (p) => (p.sigma ? p.sigma.reduce((x, y) => x + y, 0) / 4 : null);
    const range = (p) => p.levels.white - p.levels.black.reduce((x, y) => x + y, 0) / 4;
    const lineWorst = (p, key) => {
      const o = p.pattern && p.pattern[key];
      if (!o) return null;
      return Math.max(0, ...ch.map((i) => (o.ch[i] && o.ch[i].detected && p.pattern.random[i] ? o.ch[i].line / p.pattern.random[i] : 0)));
    };
    const defectTot = (p, k) => (p.defects ? p.defects.counts.reduce((s, c) => s + c[k], 0) : null);
    // [label, fn(p) -> number|string, format, delta format]
    const ev = (v) => (v === null || !isFinite(v) ? '–' : fmtEV(v));
    const num = (d) => (v) => (v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(d));
    const pct = (v) => (v === null || !isFinite(v) ? '–' : fmtPct(v) + '%');
    const pct0 = (v) => (v === null ? '–' : Math.round(v * 100) + '%');
    const int = (v) => (v === null || v === undefined ? '…' : fmtInt(v));
    const sections = [
      ['Files', [
        ['File', (p) => p.img.fileName, esc],
        ['Camera', (p) => f(p).model || '–', esc],
        ['Lens', (p) => sum(p, 'Lens'), esc],
        ['Exposure', (p) => [f(p).exposureTime ? RL.fmtShutter(f(p).exposureTime) : '', f(p).fnumber ? 'f/' + RL.fmtNum(f(p).fnumber, 1) : '', f(p).iso ? 'ISO ' + f(p).iso : ''].filter(Boolean).join(', ') || '–', esc],
        ['Analog ISO', (p) => { const iso = f(p).iso; if (!iso) return '–'; const g = p.img.digitalGain || 1; return g > 1 ? `${Math.round(iso / g)} (×${g} digital push to ${iso})` : `${iso} (no digital push found)`; }, esc],
        ['Scene', (p) => (p.img.scene && p.img.scene.measured !== null ? `LV ${p.img.scene.measured.toFixed(1)}` : '–'), esc],
        ['Image area', (p) => `${p.img.active.right - p.img.active.left} × ${p.img.active.bottom - p.img.active.top}, ${p.img.bits} bit`, esc],
      ]],
      ['Exposure (image area)', [
        ['Green median', (p) => gStat(p) && gStat(p).medianEV, ev, true],
        ['Brightest 0.1% (P99.9)', (p) => worst(p, (s) => s.p999EV), ev, true],
        ['Clipped, worst channel', (p) => worst(p, (s) => s.clippedPct), pct],
        ['At the noise floor, weakest channel', (p) => (p.sigma ? worst(p, (s) => s.floor1 || 0) : null), pct],
      ]],
      ['Noise and range', [
        ['Read noise (DN)', (p) => meanSigma(p), num(2)],
        ['Read noise (e⁻)', (p) => (p.ptc && p.ptc.ok ? p.ptc.readE : null), num(1)],
        ['Gain (e⁻/DN)', (p) => (p.ptc && p.ptc.ok ? p.ptc.gain : null), num(2)],
        ['Full well (e⁻)', (p) => (p.ptc && p.ptc.ok ? Math.round(p.ptc.fwc) : null), int],
        ['Dynamic range, engineering (EV)', (p) => (meanSigma(p) ? Math.log2(range(p) / meanSigma(p)) : null), num(1), true],
        ['Range to SNR 10 (EV)', (p) => (p.ptc && p.ptc.ok ? p.ptc.ev[10] : null), num(1), true],
        ['Row banding / random', (p) => lineWorst(p, 'rows'), pct0],
        ['Column banding / random', (p) => lineWorst(p, 'cols'), pct0],
      ]],
      ['Defects (image area)', [
        ['Hot pixels', (p) => defectTot(p, 'hot'), int],
        ['of which strong', (p) => defectTot(p, 'strong'), int],
        ['Stuck / dead', (p) => (p.defects ? defectTot(p, 'stuck') + defectTot(p, 'dead') : null), int],
        ['Hot per million px', (p) => (p.defects ? defectTot(p, 'hot') / p.defects.area * 1e6 : null), num(1)],
      ]],
    ];
    let html = `<table class="data cmp"><thead><tr><th></th><th>A <span class="muted">(viewer)</span></th><th>B</th><th>B − A</th></tr></thead>`;
    for (const [title, rows] of sections) {
      html += `<tbody><tr class="sec"><td colspan="4">${title}</td></tr>`;
      for (const [label, fn, format, delta] of rows) {
        const va = fn(a), vb = fn(b);
        const d = delta && typeof va === 'number' && typeof vb === 'number' && isFinite(va) && isFinite(vb) ? (vb - va >= 0.05 ? '+' : vb - va <= -0.05 ? '−' : '±') + Math.abs(vb - va).toFixed(1) + ' EV' : '';
        html += `<tr><td>${label}</td><td>${format(va)}</td><td>${format(vb)}</td><td>${d}</td></tr>`;
      }
      html += '</tbody>';
    }
    $('cmpBody').innerHTML = html + '</table>' +
      `<p class="notes muted">A: ${name(a)}, B: ${name(b)}. EV values are relative to each file's own saturation level, so files with different bit depths compare directly. ` +
      'B uses the levels from its file; edits in the Levels table apply to A only.' + (b.ptc ? '' : ' Computing B&rsquo;s sensor estimate and defects&hellip;') + '</p>';
    $('cmpWrap').hidden = false;
    drawCompare(a, b, nCh);
  }

  /** Histograms of A (solid) and B (dashed) in EV below saturation, per channel. */
  function drawCompare(a, b) {
    const c = $('cmpCanvas');
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = 34, R = W - 10, T = 10, B = H - 24;
    const EV0 = -14, BINS = 14 * 6;
    const curves = (p) => {
      const out = [];
      const colors4 = p.img.colors4;
      const groups = colors4 ? [[0], [1], [2], [3]] : [[0], [1, 3], [2]];
      for (const g of groups) {
        const bins = new Float64Array(BINS);
        let n = 0;
        for (const i of g) {
          const h = p.histo.hist[i], bl = p.levels.black[i], rng = p.levels.white - bl;
          for (let v = 0; v < h.length; v++) {
            const k = h[v];
            if (!k) continue;
            n += k;
            const e = v - bl > 0 ? Math.log2((v - bl) / rng) : -99;
            const j = Math.floor((e - EV0) * 6);
            if (j >= 0 && j < BINS) bins[j] += k;
            else if (j >= BINS) bins[BINS - 1] += k;
          }
        }
        for (let j = 0; j < BINS; j++) bins[j] /= n || 1;
        out.push({ bins, color: colors4 ? CH_COLORS[g[0]] : CH_COLORS[g[0]] });
      }
      return out;
    };
    const ca = curves(a), cb = curves(b);
    const max = Math.max(1e-9, ...ca.flatMap((q) => [...q.bins]), ...cb.flatMap((q) => [...q.bins]));
    const X = (e) => L + ((e - EV0) / -EV0) * (R - L);
    const Y = (v) => B - (Math.sqrt(v / max)) * (B - T); // square root scale shows both peaks and tails
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = '#2a2f36'; ctx.fillStyle = '#8a939d';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let e = EV0; e <= 0; e += 2) {
      const x = Math.round(X(e)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, B); ctx.stroke();
      ctx.fillText(e === 0 ? '0 EV' : String(e), x, B + 6);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('A solid, B dashed (√ scale)', L + 4, T);
    for (const [set, dash] of [[ca, []], [cb, [4, 3]]]) {
      ctx.setLineDash(dash);
      for (const q of set) {
        ctx.strokeStyle = q.color; ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let j = 0; j < BINS; j++) {
          const x = X(EV0 + (j + 0.5) / 6), y = Y(q.bins[j]);
          if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'compare') renderCompare();
  }

  $('btnCompare').onclick = () => $('fileInputB').click();
  $('fileInputB').onchange = () => { compareWith($('fileInputB').files[0]); $('fileInputB').value = ''; };
  $('btnCmpClose').onclick = () => { state.cmp = null; renderCompare(); };
  $('btnCmpSwap').onclick = () => {
    const b = state.cmp, prevA = state.img;
    if (!b) return;
    state.cmp = null;
    loadImage(b.img);
    setCompare(prevA);
    showTab('compare');
  };
  new ResizeObserver(() => { if (state.cmp && $('tab-compare').classList.contains('active')) renderCompare(); }).observe($('cmpWrap'));

  function onLevelsChanged() {
    viewer.levels = state.levels;
    state.wb.auto = Analysis.grayWorld(Analysis.computeStats(histFor('active'), state.levels, state.sigma), state.levels.black, state.img.colors4);
    viewer.wb = currentWB();
    updateAnalysis();
    updatePtc();
    updatePattern();
    updateDefects();
  }

  $('levelsTable').addEventListener('change', (e) => {
    const t = e.target;
    const v = Math.max(0, Math.min(65535, Math.round(+t.value)));
    if (t.dataset.black !== undefined) state.levels.black[+t.dataset.black] = v;
    else if (t.id === 'whiteInput') state.levels.white = Math.max(1, v);
    t.blur();
    onLevelsChanged();
  });
  $('btnLevelsReset').onclick = () => { state.levels.black = state.fileLevels.black.slice(); state.levels.white = state.fileLevels.white; onLevelsChanged(); };
  $('btnBlackFromMasked').onclick = () => {
    const m = state.img && state.img.masked;
    if (!m) return;
    state.levels.black = m.ch.map((c, i) => (c ? Math.round(c.mean) : state.levels.black[i]));
    onLevelsChanged();
  };
  $('btnWhiteFromMax').onclick = () => { if (state.img) { state.levels.white = state.img.maxValue; onLevelsChanged(); } };

  // ------------------------------------------------------------- metadata
  function renderMeta() {
    const img = state.img;
    $('summary').innerHTML = img.summary.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');
    const box = $('metaGroups');
    box.innerHTML = img.groups.map((g, gi) => `<details class="group-meta" ${gi < 2 ? 'open' : ''} data-g="${gi}"><summary>${esc(g.name)} <span class="muted">${g.rows.length}</span></summary>` +
      `<table class="data"><tbody>${g.rows.map((r) => `<tr data-s="${esc((r.id + ' ' + r.name + ' ' + r.value).toLowerCase())}"><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${esc(r.value)}</td></tr>`).join('')}</tbody></table></details>`).join('');
    applyMetaFilter();
  }
  function applyMetaFilter() {
    const q = $('metaFilter').value.trim().toLowerCase();
    for (const d of $('metaGroups').querySelectorAll('details')) {
      let any = false;
      for (const tr of d.querySelectorAll('tr')) {
        const hit = !q || tr.dataset.s.includes(q);
        tr.style.display = hit ? '' : 'none';
        any = any || hit;
      }
      d.style.display = any ? '' : 'none';
      if (q && any) d.open = true;
    }
  }
  $('metaFilter').addEventListener('input', applyMetaFilter);

  function renderInfo() {
    const img = state.img, a = img.active;
    const cfa = img.cfa.map((c) => CFA_LETTERS[c]).join('');
    const wb = img.wbAsShot ? img.wbAsShot.slice(0, 3).map((v) => v).join(' / ') + `  (R ×${(img.wbAsShot[0] / img.wbAsShot[1]).toFixed(3)}, B ×${(img.wbAsShot[2] / img.wbAsShot[1]).toFixed(3)})` : 'not available';
    const rows = [
      ['File', img.fileName],
      ['Size', fmtBytes(img.fileSize)],
      ['Format', img.format],
      ['Camera', img.facts.model && img.facts.make && !img.facts.model.startsWith(img.facts.make) ? img.facts.make + ' ' + img.facts.model : (img.facts.model || img.facts.make || 'unknown') + (img.facts.modelId ? ' (model ID ' + img.facts.modelId + ')' : '')],
      ['Raw frame', `${img.width} × ${img.height} (${(img.width * img.height / 1e6).toFixed(1)} MP)`],
      ['Image area', `x ${a.left}–${a.right - 1}, y ${a.top}–${a.bottom - 1} (${a.right - a.left} × ${a.bottom - a.top})`],
      ['CFA pattern', cfa],
      ['Bit depth', img.bits + ' bit (max ' + ((1 << img.bits) - 1) + ')'],
      ['Black level', state.fileLevels.black.join(' / ') + ' (' + img.blackSource + ')'],
      ['Saturation', state.fileLevels.white + ' (' + img.whiteSource + ')'],
      ['Data maximum', img.maxValue + ' (' + img.maxCount.toLocaleString("en-US") + ' px)'],
      ['As shot WB', wb],
      ['Colour matrix', img.colorEntry ? 'Canon ' + img.colorEntry.prefix + ' (LibRaw table)' : 'not available (preview uses raw colours)'],
      ...(img.digitalGain > 1 ? [['Digital gain', `×${img.digitalGain}: only every ${img.digitalGain === 2 ? '2nd' : img.digitalGain === 4 ? '4th' : img.digitalGain + 'th'} raw value occurs, so this ISO is a lower analog ISO multiplied in software. Same noise as brightening that ISO in post, with ${Math.log2(img.digitalGain)} EV less highlight headroom`]] : []),
      ['Shutter count', img.shutterCount ? (img.shutterCount.value ? img.shutterCount.value.toLocaleString('en-US') + (img.shutterCount.note ? ' (' + img.shutterCount.note + ')' : '') : 'not available: ' + img.shutterCount.note)
        : 'not recorded by this camera in raw files'],
      ...(img.scene ? [['Scene brightness', img.scene.text + (img.scene.source ? ' [' + img.scene.source + ']' : '')]] : []),
      ...(img.cameraTemp !== undefined ? [['Camera temperature', img.cameraTemp + ' °C (camera internal reading)']] : []),
      ...img.info,
      ['Decode time', img.decodeMs + ' ms'],
    ];
    $('rawInfo').innerHTML = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');

    for (const u of state.thumbUrls) URL.revokeObjectURL(u);
    state.thumbUrls = [];
    const box = $('thumbs');
    box.innerHTML = '';
    if (!img.thumbs.length) box.innerHTML = '<p class="muted">No embedded images.</p>';
    img.thumbs.forEach((t) => {
      const el = document.createElement('div');
      el.className = 'thumb';
      let media, href;
      if (t.mime === 'image/jpeg') {
        href = URL.createObjectURL(new Blob([t.data], { type: 'image/jpeg' }));
        state.thumbUrls.push(href);
        media = document.createElement('img');
        media.src = href;
        media.onload = () => { cap.querySelector('.dim').textContent = media.naturalWidth + ' × ' + media.naturalHeight; };
        media.onclick = () => showPreview(href);
      } else {
        media = document.createElement('canvas');
        media.width = t.width; media.height = t.height;
        const id = media.getContext('2d').createImageData(t.width, t.height);
        for (let i = 0, j = 0; i < t.width * t.height; i++, j += 3) { id.data[4 * i] = t.data[j]; id.data[4 * i + 1] = t.data[j + 1]; id.data[4 * i + 2] = t.data[j + 2]; id.data[4 * i + 3] = 255; }
        media.getContext('2d').putImageData(id, 0, 0);
        href = media.toDataURL('image/png');
        media.onclick = () => showPreview(href);
      }
      const cap = document.createElement('div');
      cap.className = 'cap';
      const base = img.fileName.replace(/\.[^.]+$/, '');
      cap.innerHTML = `<span>${esc(t.label)}</span><span class="dim muted">${t.width && t.height ? t.width + ' × ' + t.height : ''}</span><a download="${esc(base + '_' + t.label.replace(/\W+/g, '_') + (t.mime === 'image/jpeg' ? '.jpg' : '.png'))}" href="${href}">Save</a>`;
      el.append(media, cap);
      box.appendChild(el);
    });
  }

  function showPreview(src) {
    let d = document.querySelector('dialog.preview');
    if (!d) {
      d = document.createElement('dialog');
      d.className = 'preview';
      d.innerHTML = '<img alt="Embedded preview">';
      d.addEventListener('click', () => d.close());
      document.body.appendChild(d);
    }
    d.querySelector('img').src = src;
    d.showModal();
  }

  // ------------------------------------------------------------ downloads
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const baseName = () => state.img.fileName.replace(/\.[^.]+$/, '');
  $('btnHistCsv').onclick = () => { if (state.img) download(baseName() + '_histogram_' + state.area + '.csv', chart.csv(), 'text/csv'); };
  $('btnHistPng').onclick = () => {
    if (!state.img) return;
    const a = document.createElement('a');
    const wave = $('histScope').value === 'wave';
    a.href = $(wave ? 'waveCanvas' : 'histCanvas').toDataURL('image/png');
    a.download = baseName() + (wave ? '_waveform.png' : '_histogram.png');
    a.click();
  };
  $('btnStatsCsv').onclick = () => {
    if (!state.img) return;
    const keys = ['n', 'min', 'max', 'mean', 'median', 'sd', 'p001', 'p99', 'p999', 'under', 'underPct', 'clipped', 'clippedPct', 'meanEV', 'medianEV', 'p999EV', 'maxEV'];
    const lines = ['channel,black,white,' + keys.join(',')];
    state.stats.forEach((st, i) => {
      if (!st) return;
      const black = i < 4 ? state.levels.black[i] : state.levels.black.reduce((a, b) => a + b) / 4;
      lines.push([i < 4 ? CH_NAMES[i] : 'All', black, state.levels.white, ...keys.map((k) => (isFinite(st[k]) ? +(+st[k]).toFixed(4) : ''))].join(','));
    });
    download(baseName() + '_stats_' + state.area + '.csv', lines.join('\n'), 'text/csv');
  };

  // -------------------------------------------------------------- viewer UI
  viewer.onZoom = (scale, fitted) => { $('zoomLabel').textContent = fitted ? 'Fit' : Math.round(scale * 100) + '%'; };
  viewer.onHover = (b) => {
    if (!b) { $('stPos').innerHTML = '&nbsp;'; $('stVals').innerHTML = ''; return; }
    const lv = state.levels;
    $('stPos').textContent = `x ${b.x}  y ${b.y}`;
    const cls = ['v-r', 'v-g', 'v-b', 'v-g2'];
    $('stVals').innerHTML = [0, 1, 2, 3].map((c) => `<span class="${b.v[c] >= lv.white ? 'clip' : cls[c]}">${CH_NAMES[c]} ${b.v[c]}</span>`).join('  ') +
      `  <span class="muted">pixel ${CH_NAMES[b.pixelCh]}=${b.pixel}` +
      (b.pixel > lv.black[b.pixelCh] ? ` (${fmtEV(Math.log2((b.pixel - lv.black[b.pixelCh]) / (lv.white - lv.black[b.pixelCh])))} EV)` : '') +
      (state.sigma ? `, ${((b.pixel - lv.black[b.pixelCh]) / state.sigma[b.pixelCh]).toFixed(1)}σ` : '') + '</span>';
  };
  viewer.onSelect = (sel) => {
    state.selection = sel;
    const opt = $('histArea').querySelector('option[value=selection]');
    opt.disabled = false;
    $('histArea').value = 'selection';
    state.area = 'selection';
    $('stSel').textContent = `Selection ${sel.x1 - sel.x0} × ${sel.y1 - sel.y0} at (${sel.x0}, ${sel.y0}) · Esc clears`;
    updateAnalysis();
  };
  viewer.onPick = (rect) => {
    const h = Analysis.computeHist(state.img, rect);
    const st = Analysis.computeStats(h, state.levels, state.sigma);
    // clipped or near-black samples give meaningless channel ratios
    const lv = state.levels;
    const clipped = [0, 1, 2, 3].some((c) => st[c] && st[c].clippedPct > 2);
    const tooDark = [0, 1, 2, 3].some((c) => st[c] && (st[c].mean - lv.black[c]) < Math.max(20, 10 * (state.sigma ? state.sigma[c] : 2)));
    if (clipped || tooDark) {
      $('stSel').textContent = clipped ? 'WB pick ignored: that area is clipped. Click a bright but unclipped neutral area.'
        : 'WB pick ignored: that area is too dark for reliable channel ratios. Click a brighter neutral area.';
      setTimeout(() => { if (/^WB pick ignored/.test($('stSel').textContent)) $('stSel').textContent = ''; }, 5000);
      return;
    }
    if (/^WB pick ignored/.test($('stSel').textContent)) $('stSel').textContent = '';
    state.wb.custom = Analysis.grayWorld(st, state.levels.black, state.img.colors4);
    const sel = $('wbMode');
    sel.querySelector('option[value=custom]').disabled = false;
    sel.value = 'custom';
    state.wbMode = 'custom';
    viewer.wb = currentWB();
    viewer.requestRender();
  };

  function clearSelection() {
    if (!state.selection) return;
    state.selection = null;
    viewer.clearSelection();
    $('histArea').querySelector('option[value=selection]').disabled = true;
    $('stSel').textContent = '';
    if (state.area === 'selection') { state.area = 'active'; $('histArea').value = 'active'; updateAnalysis(); }
  }

  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('active', x === b));
    viewer.tool = b.dataset.tool;
    $('viewport').className = 'viewport tool-' + viewer.tool;
  }));
  $('viewport').classList.add('tool-pan');

  $('viewMode').onchange = (e) => { viewer.mode = e.target.value; viewer.requestRender(); };
  $('demosaic').onchange = (e) => { viewer.demosaic = e.target.value; viewer.resetDemosaic(); viewer.requestRender(); };
  viewer.onDemosaicStatus = (t) => { $('stDemosaic').textContent = t; };

  // export
  ImageExport.init(() => ({
    img: state.img, levels: state.levels, wb: currentWB(), exposure: viewer.exposure, matrix: viewer.matrix,
    wbLabel: $('wbMode').selectedOptions[0].textContent, selection: viewer.selection, baseName: state.img ? baseName() : '',
    onDone: (msg) => { $('stDemosaic').textContent = msg; },
  }));
  $('btnExport').onclick = () => ImageExport.open();
  FolderScan.init((file) => openFile(file));
  $('wbMode').onchange = (e) => { state.wbMode = e.target.value; viewer.wb = currentWB(); viewer.requestRender(); };
  $('exposure').oninput = (e) => setExposure(+e.target.value);
  $('btnAutoExp').onclick = () => { if (state.img) autoExposure(Analysis.computeStats(histFor('active'), state.levels, state.sigma)); };
  $('showClip').onchange = (e) => { viewer.showClip = e.target.checked; viewer.requestRender(); };
  $('showUnder').onchange = (e) => { viewer.showUnder = e.target.checked; viewer.requestRender(); };
  $('underK').onchange = (e) => { viewer.underK = +e.target.value; $('showUnder').checked = viewer.showUnder = true; viewer.requestRender(); };
  $('showMasked').onchange = (e) => { viewer.showMasked = e.target.checked; viewer.fit(); };
  $('zoomIn').onclick = () => viewer.zoomTo(viewer.scale * 1.5);
  $('zoomOut').onclick = () => viewer.zoomTo(viewer.scale / 1.5);
  $('zoomLabel').onclick = () => { if (viewer.fitted) viewer.zoomTo(1); else viewer.fit(); };

  // histogram controls
  $('histArea').onchange = (e) => { state.area = e.target.value; updateAnalysis(); };
  new ResizeObserver(() => { if ($('histScope').value === 'wave') drawCharts(); }).observe($('waveWrap'));
  for (const id of ['histScope', 'histX', 'histY', 'histBin', 'histSubBlack', 'histLayout']) $(id).addEventListener('change', () => {
    $('histBin').disabled = $('histX').value === 'ev';
    drawCharts();
  });
  new ResizeObserver(() => drawCharts()).observe($('chartWrap'));

  // tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
    if (t.dataset.tab === 'hist') drawCharts();
    if (t.dataset.tab === 'stats') drawPtc();
    if (t.dataset.tab === 'compare') renderCompare();
  }));

  // ---------------------------------------------------------- file input
  const fileInput = $('fileInput');
  const pick = () => fileInput.click();
  $('btnOpen').onclick = pick;
  $('btnOpen2').onclick = pick;
  fileInput.onchange = () => { openFile(fileInput.files[0]); fileInput.value = ''; };
  $('btnHelp').onclick = () => $('helpDialog').showModal();

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pick(); return; }
    if (!state.img) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); ImageExport.open(); return; }
    if (e.key === '+' || e.key === '=') viewer.zoomTo(viewer.scale * 1.5);
    else if (e.key === '-') viewer.zoomTo(viewer.scale / 1.5);
    else if (e.key === '0') { if (viewer.fitted) viewer.zoomTo(1); else viewer.fit(); }
    else if (e.key === 'Escape') clearSelection();
  });

  // ---------------------------------------------------------- remembered settings
  // viewer and histogram options persist between sessions (per browser); the page
  // works the same when storage is unavailable
  const PREFS_KEY = 'rawAnalyzer.settings';
  const PREF_IDS = ['demosaic', 'viewMode', 'underK', 'showUnder', 'showClip', 'histScope', 'histX', 'histY', 'histBin', 'histLayout', 'histSubBlack'];
  function savePrefs() {
    try {
      const v = {};
      for (const id of PREF_IDS) { const e = $(id); v[id] = e.type === 'checkbox' ? e.checked : e.value; }
      const tab = document.querySelector('.tab.active');
      v.tab = tab ? tab.dataset.tab : 'hist';
      localStorage.setItem(PREFS_KEY, JSON.stringify(v));
    } catch (e) { /* storage unavailable */ }
  }
  (function loadPrefs() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { /* storage unavailable */ }
    if (v) {
      // underK before showUnder: changing the threshold switches the overlay on
      for (const id of PREF_IDS) {
        const e = $(id);
        if (v[id] === undefined || !e) continue;
        if (e.type === 'checkbox') e.checked = !!v[id];
        else if ([...e.options].some((o) => o.value === String(v[id]))) e.value = v[id];
        else continue;
        e.dispatchEvent(new Event('change'));
      }
      if (v.tab && v.tab !== 'compare') { const t = document.querySelector(`.tab[data-tab="${v.tab}"]`); if (t) t.click(); }
    }
    for (const id of PREF_IDS) $(id).addEventListener('change', savePrefs);
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', savePrefs));
  })();

  renderLegend();
  window.RawAnalyzer ={ openFile, compareWith, state, viewer, loadImage };
})();
