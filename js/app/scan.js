/*
 * Folder scan: decodes every raw file of a chosen folder in a pool of Web
 * Workers and lists one row per file (shooting data, scene brightness, shutter
 * count and exposure figures). Only the row comes back from a worker, never the
 * pixel data. Sortable, filterable, CSV export; a click opens the file.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const RAW_EXT = /\.(crw|cr2|cr3|tif|tiff)$/i;

  /** One table row from a decoded file (runs inside the worker as well). */
  function summarize(RL, res) {
    const f = res.facts;
    const sum = (k) => { const r = res.summary.find((x) => x[0] === k); return r ? r[1] : ''; };
    const A = res.active, W = res.width, raw = res.raw, cfa = res.cfa;
    const hist = [0, 1, 2, 3].map(() => new Uint32Array(65536));
    for (let y = A.top; y < A.bottom; y++) {
      const o = y * W, he = hist[cfa[(y & 1) * 2 + (A.left & 1)]], ho = hist[cfa[(y & 1) * 2 + ((A.left + 1) & 1)]];
      let x = A.left;
      for (; x + 1 < A.right; x += 2) { he[raw[o + x]]++; ho[raw[o + x + 1]]++; }
      if (x < A.right) he[raw[o + x]]++;
    }
    const st = hist.map((h, c) => {
      let n = 0;
      for (let v = 0; v < 65536; v++) n += h[v];
      if (!n) return null;
      const bl = res.black[c], rng = res.white - bl;
      const at = (p) => { let acc = 0; const t = n * p; for (let v = 0; v < 65536; v++) { acc += h[v]; if (acc >= t) return v; } return 65535; };
      const ev = (v) => (v - bl > 0 ? Math.log2((v - bl) / rng) : -99);
      let clip = 0;
      for (let v = Math.max(0, res.white); v < 65536; v++) clip += h[v];
      return { median: ev(at(0.5)), p999: ev(at(0.999)), clip: (100 * clip) / n };
    });
    const ok = st.filter(Boolean);
    const sc = res.shutterCount;
    return {
      date: f.date ? String(f.date).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3') : '',
      camera: f.model || '', lens: sum('Lens'), focal: f.focal || null,
      shutter: f.exposureTime || null, aperture: f.fnumber || null, iso: f.iso || null, ec: f.ec !== undefined ? f.ec : null,
      lv: res.scene && res.scene.measured != null ? res.scene.measured : null,
      lvSet: res.scene && res.scene.settings != null ? res.scene.settings : null,
      count: sc && sc.value ? sc.value : null, temp: res.cameraTemp != null ? res.cameraTemp : null,
      medianG: st[1] ? st[1].median : null,
      p999: ok.length ? Math.max(...ok.map((s) => s.p999)) : null,
      clip: ok.length ? Math.max(...ok.map((s) => s.clip)) : null,
      format: res.format, mp: (A.right - A.left) * (A.bottom - A.top) / 1e6,
    };
  }

  // ------------------------------------------------------------ worker pool
  const workerSource = () => [
    'const RL = {};',
    ...self.RAW_MODULES.map((f) => '(' + f.toString() + ')(RL);'),
    'const summarize = ' + summarize.toString() + ';',
    `self.onmessage = function (e) {
      try { const res = RL.decode(e.data.buffer, e.data.name); self.postMessage({ id: e.data.id, row: summarize(RL, res) }); }
      catch (err) { self.postMessage({ id: e.data.id, error: err && err.message ? err.message : String(err) }); }
    };`,
  ].join('\n');

  let url = null;
  const SIZE = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

  function makeRunner() {
    const workers = [];
    let local = false;
    try {
      if (!url) url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      for (let i = 0; i < SIZE; i++) workers.push(new Worker(url));
    } catch (e) {
      local = true;
    }
    let seq = 0;
    const waiting = new Map();
    for (const w of workers) {
      w.onmessage = (e) => { const r = waiting.get(e.data.id); waiting.delete(e.data.id); w.busy = false; if (r) r(e.data); };
      w.onerror = (e) => { e.preventDefault(); local = true; };
    }
    return {
      size: local ? 1 : SIZE,
      run(buffer, name) {
        if (local || !workers.length) {
          return new Promise((resolve) => setTimeout(() => {
            try { resolve({ row: summarize(window.RL, window.RL.decode(buffer, name)) }); } catch (err) { resolve({ error: err.message }); }
          }, 0));
        }
        const w = workers.find((x) => !x.busy) || workers[0];
        w.busy = true;
        const id = ++seq;
        return new Promise((resolve) => { waiting.set(id, resolve); w.postMessage({ id, buffer, name }, [buffer]); });
      },
      close() { workers.forEach((w) => w.terminate()); },
    };
  }

  // ------------------------------------------------------------ table
  const fmtShutter = (t) => (window.RL ? window.RL.fmtShutter(t) : String(t));
  const ev = (v) => (v === null || v === undefined ? '' : v <= -99 ? '−∞' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2));
  const COLS = [
    ['File', (r) => r.path, (r) => esc(r.path)],
    ['Date', (r) => r.date, (r) => esc(r.date)],
    ['Camera', (r) => r.camera, (r) => esc(r.camera)],
    ['Lens', (r) => r.lens, (r) => `<span title="${esc(r.lens)}">${esc(r.lens)}</span>`],
    ['Focal', (r) => r.focal, (r) => (r.focal ? Math.round(r.focal) + ' mm' : '')],
    ['Shutter', (r) => r.shutter, (r) => (r.shutter ? fmtShutter(r.shutter) : '')],
    ['f/', (r) => r.aperture, (r) => (r.aperture ? r.aperture.toFixed(1) : '')],
    ['ISO', (r) => r.iso, (r) => (r.iso || '')],
    ['EC', (r) => r.ec, (r) => (r.ec ? (r.ec > 0 ? '+' : '−') + Math.abs(r.ec).toFixed(1) : r.ec === 0 ? '0' : '')],
    ['LV meter', (r) => r.lv, (r) => (r.lv !== null ? r.lv.toFixed(1) : '')],
    ['LV set', (r) => r.lvSet, (r) => (r.lvSet !== null ? r.lvSet.toFixed(1) : '')],
    ['Shutter count', (r) => r.count, (r) => (r.count ? r.count.toLocaleString('en-US') : '')],
    ['Temp', (r) => r.temp, (r) => (r.temp !== null ? r.temp + ' °C' : '')],
    ['Median G (EV)', (r) => r.medianG, (r) => ev(r.medianG)],
    ['P99.9 (EV)', (r) => r.p999, (r) => ev(r.p999)],
    ['Clipped %', (r) => r.clip, (r) => (r.clip === null ? '' : `<span class="${r.clip > 0.1 ? 'bad' : r.clip > 0 ? 'warn' : ''}">${r.clip === 0 ? '0' : r.clip < 0.001 ? '<0.001' : r.clip.toFixed(r.clip < 1 ? 3 : 2)}</span>`)],
    ['MP', (r) => r.mp, (r) => (r.mp ? r.mp.toFixed(1) : '')],
  ];

  let rows = [], sortCol = 1, sortDir = 1, scan = null, renderTimer = 0;

  function sorted() {
    const q = $('scanFilter').value.trim().toLowerCase();
    const list = q ? rows.filter((r) => [r.path, r.camera, r.lens, r.date, r.error || ''].join(' ').toLowerCase().includes(q)) : rows.slice();
    const key = COLS[sortCol][1];
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === y) return a.path < b.path ? -1 : 1;
      if (x === null || x === undefined || x === '') return 1;
      if (y === null || y === undefined || y === '') return -1;
      return (x < y ? -1 : 1) * sortDir;
    });
    return list;
  }

  function render() {
    renderTimer = 0;
    const list = sorted();
    const head = '<thead><tr>' + COLS.map(([t], i) => `<th data-c="${i}">${t}${i === sortCol ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr></thead>';
    $('scanTable').innerHTML = head + '<tbody>' + list.map((r) => {
      if (r.error) return `<tr data-i="${r.i}" class="err"><td>${esc(r.path)}</td><td colspan="${COLS.length - 1}" class="muted">${esc(r.error)}</td></tr>`;
      return `<tr data-i="${r.i}">` + COLS.map(([, , f]) => `<td>${f(r)}</td>`).join('') + '</tr>';
    }).join('') + '</tbody>';
  }
  const renderSoon = () => { if (!renderTimer) renderTimer = setTimeout(render, 250); };

  function status(t) { $('scanStatus').textContent = t; }

  async function start(files) {
    const raws = [...files].filter((f) => RAW_EXT.test(f.name)).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    rows = [];
    $('scanFilter').value = '';
    $('scanDialog').showModal();
    if (!raws.length) { status('No CRW, CR2, CR3 or TIF files in that folder.'); render(); return; }
    const runner = makeRunner();
    const job = { stop: false, runner };
    scan = job;
    $('scanStop').hidden = false;
    const t0 = performance.now();
    let next = 0, done = 0;
    const worker = async () => {
      while (!job.stop && next < raws.length) {
        const i = next++;
        const file = raws[i];
        const path = file.webkitRelativePath || file.name;
        let out;
        try { out = await runner.run(await file.arrayBuffer(), file.name); } catch (e) { out = { error: e.message }; }
        if (job.stop) break;
        rows.push(Object.assign({ i, path, file, size: file.size }, out.row || { error: out.error }));
        done++;
        status(`${done} of ${raws.length} files` + (done < raws.length ? ` (${runner.size} threads)` : ` in ${((performance.now() - t0) / 1000).toFixed(1)} s`));
        renderSoon();
      }
    };
    await Promise.all(Array.from({ length: runner.size }, worker));
    runner.close();
    if (scan === job) scan = null;
    $('scanStop').hidden = true;
    if (job.stop) status(`Stopped after ${done} of ${raws.length} files`);
    render();
  }

  function csv() {
    const list = sorted();
    const q = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const keys = ['path', 'date', 'camera', 'lens', 'focal', 'shutter', 'aperture', 'iso', 'ec', 'lv', 'lvSet', 'count', 'temp', 'medianG', 'p999', 'clip', 'mp', 'format', 'size', 'error'];
    const lines = [keys.join(',')].concat(list.map((r) => keys.map((k) => q(typeof r[k] === 'number' ? +r[k].toFixed(4) : r[k])).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'raw-folder-scan.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function init(openFile) {
    $('btnScan').onclick = () => $('folderInput').click();
    $('folderInput').onchange = () => { const f = $('folderInput').files; if (f.length) start(f); $('folderInput').value = ''; };
    $('scanStop').onclick = () => { if (scan) scan.stop = true; };
    $('scanClose').onclick = () => { if (scan) scan.stop = true; $('scanDialog').close(); };
    $('scanCsv').onclick = csv;
    $('scanFilter').oninput = render;
    $('scanTable').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-c]');
      if (th) { const c = +th.dataset.c; sortDir = c === sortCol ? -sortDir : 1; sortCol = c; render(); return; }
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const r = rows.find((x) => x.i === +tr.dataset.i);
      if (r && !r.error) { $('scanDialog').close(); openFile(r.file); }
    });
  }

  window.FolderScan = { init, summarize, start };
})();
