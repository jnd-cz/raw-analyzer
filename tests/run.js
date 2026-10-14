/*
 * Browser test runner (tests/run.html, served by tests/server.py).
 * Decode: frame size, per-row pixel sums and CFA pattern against LibRaw.
 * Demosaic: bilinear, PPG and AHD crops against LibRaw, bit for bit.
 * Snapshot: metadata, levels and statistics against the stored snapshot.
 */
(function () {
  'use strict';

  const RL = {};
  for (const m of self.RAW_MODULES) m(RL);
  const $ = (id) => document.getElementById(id);
  const api = (p, opt) => fetch('/tests/api/' + p, opt);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // rejected on purpose by the app (LibRaw opens them)
  const UNSUPPORTED = /sRAW|SensorInfo|Unrecognized file/;

  // ------------------------------------------------------------ checks
  function checkDecode(res, ref) {
    const notes = [];
    let ok = true;
    if (res.width !== ref.w || res.height !== ref.h) return { status: 'fail', notes: [`size ${res.width}x${res.height}, LibRaw ${ref.w}x${ref.h}`] };
    let bad = 0;
    for (let y = 0; y < res.height; y++) {
      let s = 0;
      const o = y * res.width;
      for (let x = 0; x < res.width; x++) s += res.raw[o + x];
      if (s !== ref.rows[y]) bad++;
    }
    if (bad) { ok = false; notes.push(`${bad} rows differ from LibRaw`); }
    if (res.cfa.join() !== ref.cfa.join()) { ok = false; notes.push(`CFA ${res.cfa.join('')}, LibRaw ${ref.cfa.join('')}`); }
    let warn = false;
    const db = res.black.map((b, i) => b - ref.black[i]);
    if (db.some((d) => Math.abs(d) > 2)) { warn = true; notes.push(`black ${res.black.join('/')} vs LibRaw ${ref.black.join('/')} (${res.blackSource})`); }
    return { status: ok ? (warn ? 'warn' : 'pass') : 'fail', notes };
  }

  async function checkDemosaic(res, ref, name) {
    if (!ref.crops) return { status: 'skip', notes: [] };
    const fr = Math.fround;
    const minB = Math.min(...ref.black), dmin = Math.min(...ref.wb);
    const mul = ref.wb.map((v) => fr(fr(fr(v / dmin) * 65535) / (ref.white - minB)));
    const notes = [];
    let ok = true;
    for (const algo of ref.algos) {
      const data = new Uint16Array(await (await api('ref/' + name + '.' + algo + '.bin')).arrayBuffer());
      let off = 0;
      for (const [cx, cy, cw, ch] of ref.crops) {
        const x0 = Math.max(0, cx - 16), y0 = Math.max(0, cy - 16);
        const x1 = Math.min(ref.width, cx + cw + 16), y1 = Math.min(ref.height, cy + ch + 16);
        const w = x1 - x0, h = y1 - y0;
        const X0 = ref.left + x0, Y0 = ref.top + y0;
        const raw = new Uint16Array(w * h);
        for (let y = 0; y < h; y++) raw.set(res.raw.subarray((Y0 + y) * res.width + X0, (Y0 + y) * res.width + X0 + w), y * w);
        const fc4 = [0, 1, 2, 3].map((p) => res.cfa[((Y0 + (p >> 1)) & 1) * 2 + ((X0 + (p & 1)) & 1)]);
        const out = RL.demosaic({ raw, w, h, fc4, black: ref.black, mul, colors: 3, algo, rgbCam: ref.rgb_cam, crop: { x: cx - x0, y: cy - y0, w: cw, h: ch } });
        let bad = 0;
        for (let i = 0; i < cw * ch * 3; i++) if (out.data[i] !== data[off + i]) bad++;
        off += cw * ch * 3;
        if (bad) { ok = false; notes.push(`${algo} ${cw}x${ch} at ${cx},${cy}: ${bad} values differ`); }
      }
    }
    return { status: ok ? 'pass' : 'fail', notes };
  }

  /** Values that should only change on purpose. */
  function snapshot(res) {
    const A = res.active;
    const histo = Analysis.computeHist(res, { x0: A.left, y0: A.top, x1: A.right, y1: A.bottom });
    const levels = { black: res.black, white: res.white };
    const st = Analysis.computeStats(histo, levels, res.noise ? res.noise.sigma : null);
    const r4 = (v) => (typeof v === 'number' && isFinite(v) ? +v.toPrecision(5) : v);
    const sig = res.noise ? res.noise.sigma : null;
    const st0 = Analysis.computeStats(Analysis.computeHist(res, { x0: A.left, y0: A.top, x1: A.right, y1: A.bottom }), { black: res.black, white: res.white }, sig);
    const dark = !!sig && [0, 1, 2, 3].every((i) => st0[i] && st0[i].p99 - res.black[i] < 20 * sig[i]);
    const pn = Analysis.patternNoise(res, res.black, dark);
    const lines = (o) => o && o.ch.map((c) => c && { line: r4(c.line), detected: c.detected });
    const df = Analysis.defectPixels(res, levels, res.noise ? res.noise.sigma : null);
    return {
      defects: df.counts,
      pattern: pn && { random: pn.random.map(r4), mode: pn.mode, rows: lines(pn.rows), cols: lines(pn.cols), border: lines(pn.border), side: pn.borderSide, rejected: pn.rejected },
      format: res.format, size: [res.width, res.height], bits: res.bits, active: A, cfa: res.cfa, colors4: !!res.colors4,
      black: res.black, blackSource: res.blackSource, white: res.white, whiteSource: res.whiteSource,
      colorEntry: res.colorEntry ? res.colorEntry.prefix : null, wbAsShot: res.wbAsShot && res.wbAsShot.map(r4),
      noise: res.noise ? { source: res.noise.source, sigma: res.noise.sigma.map(r4) } : null,
      orientation: res.facts.orientation || null, summary: res.summary,
      stats: st.map((s) => s && { mean: r4(s.mean), median: s.median, sd: r4(s.sd), max: s.max, clipped: s.clipped, under: s.under }),
    };
  }

  function diff(a, b, path, out) {
    if (out.length > 6) return out;
    if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
      out.push(`${path}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    } else if (a && typeof a === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path ? path + '.' + k : k, out);
    } else if (a !== b) {
      out.push(`${path}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
    return out;
  }

  // ------------------------------------------------------------ runner
  let list = [];
  async function loadList() {
    list = await (await api('samples')).json();
    $('count').textContent = `${list.length} samples, ${list.filter((s) => s.ref).length} with LibRaw references, ${list.filter((s) => s.snapshot).length} with snapshots`;
    $('exSample').innerHTML = list.map((s) => `<option>${esc(s.name)}</option>`).join('');
  }

  function cell(r) {
    return `<td class="${r.status}">${r.status}</td>`;
  }

  async function run(update) {
    $('run').disabled = $('snap').disabled = true;
    const re = $('filter').value ? new RegExp($('filter').value, 'i') : null;
    const rows = $('rows');
    rows.innerHTML = '';
    const totals = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const s of list) {
      if (re && !re.test(s.name)) continue;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(s.name)}</td><td colspan="5" class="skip">running</td>`;
      rows.appendChild(tr);
      tr.scrollIntoView({ block: 'nearest' });
      await tick();
      const buf = await (await api('sample/' + encodeURIComponent(s.name))).arrayBuffer();
      const ref = s.ref ? await (await api('ref/' + encodeURIComponent(s.name) + '.json')).json() : null;
      const t0 = performance.now();
      let res, err;
      try { res = RL.decode(buf, s.name); } catch (e) { err = e; }
      const ms = Math.round(performance.now() - t0);
      let dec, dem, snap;
      const notes = [];
      if (err) {
        const expected = UNSUPPORTED.test(err.message) || (ref && ref.error);
        dec = { status: expected ? 'skip' : 'fail' };
        dem = snap = { status: 'skip' };
        notes.push(err.message);
      } else {
        dec = ref && !ref.error ? checkDecode(res, ref) : { status: 'skip', notes: [ref ? 'LibRaw cannot open it' : 'no LibRaw reference (run make_refs.py)'] };
        dem = ref && !ref.error && dec.status !== 'fail' ? await checkDemosaic(res, ref, encodeURIComponent(s.name)) : { status: 'skip', notes: [] };
        const cur = snapshot(res);
        if (update) {
          await api('snapshot/' + encodeURIComponent(s.name), { method: 'POST', body: JSON.stringify(cur) });
          snap = { status: 'pass', notes: ['snapshot stored'] };
          s.snapshot = true;
        } else if (s.snapshot) {
          const old = await (await api('ref/' + encodeURIComponent(s.name) + '.snap.json')).json();
          const d = diff(JSON.parse(JSON.stringify(cur)), old, '', []);
          snap = { status: d.length ? 'fail' : 'pass', notes: d };
        } else snap = { status: 'skip', notes: ['no snapshot'] };
        notes.push(...(dec.notes || []), ...(dem.notes || []), ...(snap.notes || []));
      }
      for (const r of [dec, dem, snap]) totals[r.status]++;
      tr.innerHTML = `<td>${esc(s.name)}</td>${cell(dec)}${cell(dem)}${cell(snap)}<td>${ms}</td><td class="detail">${esc(notes.join('\n'))}</td>`;
      $('summary').textContent = `checks: ${totals.pass} passed, ${totals.fail} failed, ${totals.warn} warnings, ${totals.skip} skipped`;
      $('summary').style.color = totals.fail ? 'var(--bad)' : 'var(--ok)';
    }
    $('run').disabled = $('snap').disabled = false;
    loadList();
    return totals;
  }

  // ------------------------------------------------------------ export check
  const EXPORTS = [['tiff16', 'srgb', 'srgb.tif'], ['png16', 'srgb', 'srgb16.png'], ['jpeg', 'srgb', 'srgb.jpg'], ['jpeg', 'adobe', 'adobe.jpg'], ['png8', 'adobe', 'adobe8.png'], ['dng', 'srgb', 'raw.dng']];

  async function runExport() {
    const name = $('exSample').value;
    const out = $('exOut');
    $('exRun').disabled = true;
    try {
      out.textContent = 'Loading the app';
      const frame = $('app');
      await new Promise((r) => { frame.onload = r; frame.src = '../index.html'; });
      const win = frame.contentWindow, doc = win.document;
      const saved = [];
      win.HTMLAnchorElement.prototype.click = function () { if (this.download) saved.push(this.href); };
      const buf = await (await api('sample/' + encodeURIComponent(name))).arrayBuffer();
      win.RawAnalyzer.openFile(new win.File([buf], name));
      for (let i = 0; i < 240 && !(win.RawAnalyzer.state.img && win.RawAnalyzer.state.img.fileName === name); i++) await new Promise((r) => setTimeout(r, 250));
      const st = win.RawAnalyzer.state;
      if (!st.img) throw new Error(doc.getElementById('errorBox').textContent || 'the app did not load the file');
      const set = (id, v) => { const e = doc.getElementById(id); if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dispatchEvent(new win.Event('input')); };
      set('exposure', 0);
      for (const [fmt, space, file] of EXPORTS.filter(([fm]) => !(fm === 'dng' && st.img.colors4))) {
        out.textContent = `Exporting ${file}`;
        win.ImageExport.open();
        set('exFormat', fmt); set('exSpace', space); set('exAlgo', 'ahd'); set('exArea', 'active'); set('exRotate', true);
        const n = saved.length;
        doc.getElementById('exGo').click();
        for (let i = 0; i < 1200 && saved.length === n; i++) await new Promise((r) => setTimeout(r, 100));
        if (saved.length === n) throw new Error('export did not finish: ' + doc.getElementById('exNote').textContent);
        // send the Blob as is: reading 200+ MB files into JS memory crashes the tab
        await api('export/' + file, { method: 'POST', body: await (await fetch(saved[n])).blob() });
        win.URL.revokeObjectURL(saved[n]);
      }
      const img = st.img, o = +img.facts.orientation;
      const meta = {
        sample: name, wb: win.RawAnalyzer.viewer.wb, black: st.levels.black, white: st.levels.white, active: img.active,
        orient: [3, 6, 8].includes(o) ? o : 1, hasMatrix: !!img.colorMatrix,
        colors4: !!img.colors4,
        raw: { width: img.width, height: img.height, cfa: img.cfa, colors4: !!img.colors4, matrix: img.colorMatrix || null },
      };
      out.textContent = 'Checking with tifffile, LittleCMS and LibRaw';
      const r = await api('check-export', { method: 'POST', body: JSON.stringify(meta) });
      out.textContent = r.ok ? (await r.json()).report : await r.text();
      frame.src = 'about:blank'; // free the app instance
    } catch (e) {
      out.textContent = 'FAIL ' + e.message;
    }
    out.className = /FAIL/.test(out.textContent) ? '' : 'muted';
    $('exRun').disabled = false;
    return out.textContent;
  }

  $('run').onclick = () => run(false);
  $('snap').onclick = () => { if (confirm('Store the current results as the expected snapshots?')) run(true); };
  $('exRun').onclick = runExport;
  loadList();
  window.Tests = { run, runExport };
})();
