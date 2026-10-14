/*
 * Image export: demosaic + develop in the worker pool, then encode as JPEG
 * (browser encoder), PNG 8/16 bit or 16-bit TIFF (own writers, deflate via
 * CompressionStream). Files carry an ICC profile for the chosen colour space and
 * basic Exif (camera, exposure, lens, date).
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const te = new TextEncoder();

  // ------------------------------------------------------------ colour spaces
  const SRGB_XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
  const XYZ_ADOBE = [[2.0413690, -0.5649464, -0.3446944], [-0.9692660, 1.8760108, 0.0415560], [0.0134474, -0.1183897, 1.0154096]];
  const mul3 = (a, b) => a.map((r) => b[0].map((_, j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
  const SPACES = {
    srgb: {
      label: 'sRGB', desc: 'sRGB (IEC 61966-2.1 compatible)', fromSrgb: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      luma: [0.2126729, 0.7151522, 0.0721750], curve: 'srgb', exif: 1,
      colorants: [[0.4360747, 0.2225045, 0.0139322], [0.3850649, 0.7168786, 0.0971045], [0.1430804, 0.0606169, 0.7141733]],
    },
    adobe: {
      label: 'Adobe RGB (1998)', desc: 'Compatible with Adobe RGB (1998)', fromSrgb: mul3(XYZ_ADOBE, SRGB_XYZ),
      luma: [0.2973769, 0.6273491, 0.0752741], curve: 'adobe', exif: 65535,
      colorants: [[0.6097559, 0.3111242, 0.0194811], [0.2052401, 0.6256560, 0.0608902], [0.1492240, 0.0632197, 0.7448387]],
    },
  };

  // ------------------------------------------------------------ ICC profile (v2, matrix/TRC display profile)
  function iccProfile(sp) {
    const s15 = (v) => Math.round(v * 65536);
    const xyz = (x, y, z) => { const b = new Uint8Array(20), v = new DataView(b.buffer); b.set(te.encode('XYZ ')); v.setInt32(8, s15(x)); v.setInt32(12, s15(y)); v.setInt32(16, s15(z)); return b; };
    const desc = (t) => { const b = new Uint8Array(t.length + 91), v = new DataView(b.buffer); b.set(te.encode('desc')); v.setUint32(8, t.length + 1); b.set(te.encode(t), 12); return b; };
    const text = (t) => { const b = new Uint8Array(t.length + 9); b.set(te.encode('text')); b.set(te.encode(t), 8); return b; };
    let curv;
    if (sp.curve === 'srgb') {
      curv = new Uint8Array(12 + 1024 * 2);
      const v = new DataView(curv.buffer);
      v.setUint32(8, 1024);
      for (let i = 0; i < 1024; i++) {
        const x = i / 1023;
        v.setUint16(12 + 2 * i, Math.round(65535 * (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))));
      }
    } else {
      curv = new Uint8Array(14);
      const v = new DataView(curv.buffer);
      v.setUint32(8, 1);
      v.setUint16(12, 563); // gamma 2.19921875 as u8Fixed8
    }
    curv.set(te.encode('curv'));
    const c = sp.colorants;
    const tags = [
      ['desc', desc(sp.desc)], ['cprt', text('No copyright, use freely')], ['wtpt', xyz(0.9642, 1, 0.8249)],
      ['rXYZ', xyz(...c[0])], ['gXYZ', xyz(...c[1])], ['bXYZ', xyz(...c[2])], ['rTRC', curv], ['gTRC', curv], ['bTRC', curv],
    ];
    const tableLen = 4 + 12 * tags.length;
    let off = 128 + tableLen;
    const placed = new Map();
    const entries = tags.map(([sig, data]) => {
      if (!placed.has(data)) { placed.set(data, off); off += (data.length + 3) & ~3; }
      return [sig, placed.get(data), data.length];
    });
    const out = new Uint8Array(off), v = new DataView(out.buffer);
    v.setUint32(0, off);
    v.setUint32(8, 0x02100000);
    out.set(te.encode('mntrRGB XYZ '), 12);
    const d = new Date();
    [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].forEach((x, i) => v.setUint16(24 + 2 * i, x));
    out.set(te.encode('acsp'), 36);
    v.setInt32(68, s15(0.9642)); v.setInt32(72, s15(1)); v.setInt32(76, s15(0.8249));
    v.setUint32(128, tags.length);
    entries.forEach(([sig, o, len], i) => { out.set(te.encode(sig), 132 + 12 * i); v.setUint32(136 + 12 * i, o); v.setUint32(140 + 12 * i, len); });
    for (const [data, o] of placed) out.set(data, o);
    return out;
  }

  // ------------------------------------------------------------ TIFF / Exif structures (little endian)
  const TSZ = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  function valueBytes(e) {
    const { type } = e;
    if (type === 2) return te.encode(String(e.value).replace(/[^\x20-\x7e]/g, '?') + '\0');
    if (type === 7) return e.value;
    const vals = Array.isArray(e.value) ? e.value : [e.value];
    const b = new Uint8Array(vals.length * TSZ[type]), v = new DataView(b.buffer);
    vals.forEach((x, i) => {
      if (type === 3) v.setUint16(2 * i, x, true);
      else if (type === 4) v.setUint32(4 * i, x, true);
      else { v.setUint32(8 * i, x[0], true); v.setUint32(8 * i + 4, x[1], true); }
    });
    return b;
  }
  const ifdSize = (es) => 6 + 12 * es.length + es.reduce((s, e) => s + (e.bytes.length > 4 ? (e.bytes.length + 1) & ~1 : 0), 0);
  function writeIFD(out, at, es) {
    const v = new DataView(out.buffer, out.byteOffset);
    v.setUint16(at, es.length, true);
    let data = at + 6 + 12 * es.length;
    es.forEach((e, i) => {
      const p = at + 2 + 12 * i;
      v.setUint16(p, e.tag, true); v.setUint16(p + 2, e.type, true);
      v.setUint32(p + 4, e.bytes.length / TSZ[e.type], true);
      if (e.bytes.length <= 4) out.set(e.bytes, p + 8);
      else { v.setUint32(p + 8, data, true); out.set(e.bytes, data); data += (e.bytes.length + 1) & ~1; }
    });
    v.setUint32(at + 2 + 12 * es.length, 0, true);
  }
  /**
   * Header + IFD0 (+ Exif IFD). fill(len) may change values of IFD0 entries once
   * the block length is known (strip offsets); value sizes must stay the same.
   */
  function tiffBlock(ifd0, exif, fill) {
    const prep = (list) => list.filter(Boolean).sort((a, b) => a.tag - b.tag);
    ifd0 = prep(ifd0); exif = prep(exif);
    const ptr = exif.length ? { tag: 34665, type: 4, value: 0 } : null;
    if (ptr) ifd0 = prep([...ifd0, ptr]);
    const bytesAll = () => { for (const e of [...ifd0, ...exif]) e.bytes = valueBytes(e); };
    bytesAll();
    const s0 = ifdSize(ifd0), s1 = exif.length ? ifdSize(exif) : 0;
    const len = 8 + s0 + s1;
    if (ptr) ptr.value = 8 + s0;
    if (fill) fill(len);
    bytesAll();
    const out = new Uint8Array(len);
    out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    writeIFD(out, 8, ifd0);
    if (exif.length) writeIFD(out, 8 + s0, exif);
    return out;
  }

  const rational = (x, den) => [Math.round(x * den), den];
  function metaTags(img, sp) {
    const f = img.facts || {};
    const date = f.date ? String(f.date).replace(/^(\d{4})[-:](\d{2})[-:](\d{2})[T ]/, '$1:$2:$3 ').slice(0, 19) : null;
    const lens = f.lens || (img.lens && (img.lens.source === 'id' || img.lens.source === 'lowbyte') ? img.lens.name : null);
    const ifd0 = [
      f.make && { tag: 271, type: 2, value: f.make },
      f.model && { tag: 272, type: 2, value: f.model },
      { tag: 305, type: 2, value: 'Raw Analyzer' },
      date && { tag: 306, type: 2, value: date },
      f.artist && { tag: 315, type: 2, value: f.artist },
      f.copyright && { tag: 33432, type: 2, value: f.copyright },
    ];
    const t = +f.exposureTime;
    const exif = [
      t > 0 && { tag: 33434, type: 5, value: [t < 1 ? [1, Math.round(1 / t)] : rational(t, 10)] },
      +f.fnumber > 0 && { tag: 33437, type: 5, value: [rational(+f.fnumber, 10)] },
      +f.iso > 0 && { tag: 34855, type: 3, value: Math.min(65535, Math.round(+f.iso)) },
      { tag: 36864, type: 7, value: te.encode('0231') },
      date && { tag: 36867, type: 2, value: date },
      +f.focal > 0 && { tag: 37386, type: 5, value: [rational(+f.focal, 10)] },
      { tag: 40961, type: 3, value: sp.exif },
      lens && { tag: 42036, type: 2, value: lens },
    ];
    return { ifd0, exif };
  }

  // ------------------------------------------------------------ PNG
  const CRC = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
  function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(te.encode(type), 4);
    out.set(data, 8);
    let c = -1;
    for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
    v.setUint32(8 + data.length, (c ^ -1) >>> 0);
    return out;
  }
  const deflate = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

  // ------------------------------------------------------------ dialog
  let ctxFn = null, running = null;
  const ORIENT_TEXT = { 3: 'rotated 180°', 6: 'rotated 90° clockwise', 8: 'rotated 90° counter-clockwise' };

  function prefs(save) {
    const ids = ['exFormat', 'exQuality', 'exSpace', 'exAlgo'];
    try {
      if (save) localStorage.setItem('rawAnalyzer.export', JSON.stringify(ids.map((id) => $(id).value)));
      else { const v = JSON.parse(localStorage.getItem('rawAnalyzer.export') || 'null'); if (v) ids.forEach((id, i) => { if (v[i] != null) $(id).value = v[i]; }); }
    } catch (e) { /* storage unavailable */ }
  }

  function geometry(c) {
    const area = $('exArea').value === 'selection' && c.selection ? c.selection : null;
    const A = c.img.active;
    const rect = area
      ? { x0: Math.max(A.left, area.x0), y0: Math.max(A.top, area.y0), x1: Math.min(A.right, area.x1), y1: Math.min(A.bottom, area.y1) }
      : { x0: A.left, y0: A.top, x1: A.right, y1: A.bottom };
    const o = +(c.img.facts && c.img.facts.orientation) || 1;
    const orient = $('exRotate').checked && ORIENT_TEXT[o] ? o : 1;
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    return { rect, orient, ow: orient === 6 || orient === 8 ? h : w, oh: orient === 6 || orient === 8 ? w : h };
  }

  function updateForm() {
    const c = ctxFn();
    if (!c || !c.img) return;
    const fmt = $('exFormat').value;
    $('exQualityLabel').hidden = $('exQualityRow').hidden = fmt !== 'jpeg';
    $('exQualityOut').textContent = $('exQuality').value;
    const g = geometry(c);
    const notes = [
      `${g.ow} × ${g.oh} px (${(g.ow * g.oh / 1e6).toFixed(1)} MP)` + (g.orient !== 1 ? ', ' + ORIENT_TEXT[g.orient] : '') + '.',
      `White balance: ${c.wbLabel}. Exposure: ${c.exposure > 0 ? '+' : ''}${c.exposure.toFixed(1)} EV. Highlights are clipped where the least sensitive channel saturates; overlays are not included.`,
    ];
    if (!c.img.colorMatrix) notes.push('No colour matrix for this camera, so the colours are raw camera RGB.');
    if (c.img.colors4 && $('exAlgo').value !== 'bilinear') notes.push('CMYG sensor: bilinear interpolation is used (PPG and AHD need an RGB Bayer pattern).');
    notes.push(`Runs on ${Demosaic.threads} thread${Demosaic.threads > 1 ? 's' : ''}.`);
    $('exNote').textContent = notes.join(' ');
  }

  function setBusy(on) {
    for (const id of ['exFormat', 'exQuality', 'exSpace', 'exAlgo', 'exArea', 'exRotate', 'exGo']) $(id).disabled = on;
    $('exProgress').hidden = !on;
    $('exCancel').textContent = on ? 'Stop' : 'Cancel';
  }

  function progress(p, label) {
    const el = $('exProgress');
    el.querySelector('.bar').style.setProperty('--p', Math.round(p * 100) + '%');
    el.querySelector('.label').textContent = label;
  }

  async function run() {
    const c = ctxFn();
    const fmt = $('exFormat').value, sp = SPACES[$('exSpace').value], algo = $('exAlgo').value;
    const g = geometry(c);
    const p = Demosaic.params(c.img, c.levels, c.wb, algo);
    const M = c.matrix.map((r) => r.slice());
    const dev = {
      M: sp.fromSrgb.map((r) => M[0].map((_, j) => r[0] * M[0][j] + r[1] * M[1][j] + r[2] * M[2][j])),
      scale: Math.pow(2, c.exposure) * p.wbMin / 65535,
      luma: sp.luma, curve: sp.curve, orient: g.orient,
      format: fmt === 'jpeg' ? 'rgba8' : fmt,
    };
    const gen = Demosaic.newGen();
    const job = { gen, cancelled: false };
    running = job;
    const t0 = performance.now();
    const stripH = 256;
    const icc = iccProfile(sp);
    const meta = metaTags(c.img, sp);
    const label = (q) => `${Math.round(q * 100)}%`;
    progress(0, 'Starting');

    let canvas, cx, pngWriter, pngOut;
    const tiffStrips = [];
    if (fmt === 'jpeg') {
      canvas = document.createElement('canvas');
      canvas.width = g.ow; canvas.height = g.oh;
      cx = canvas.getContext('2d');
      if (!cx) throw new Error('the browser cannot create a canvas this large');
    } else if (fmt !== 'tiff16') {
      const cs = new CompressionStream('deflate');
      pngWriter = cs.writable.getWriter();
      pngOut = new Response(cs.readable).arrayBuffer();
    }
    let y = 0;
    await Demosaic.developArea(c.img, g.rect, c.img.active, p, dev, {
      stripH, gen, compress: fmt === 'tiff16', cancelled: () => job.cancelled,
      onProgress: (q) => progress(q * 0.92, label(q * 0.92)),
      onStrip: (k, r) => {
        if (fmt === 'jpeg') { cx.putImageData(new ImageData(r.data, r.w, r.h), 0, y); y += r.h; }
        else if (fmt === 'tiff16') tiffStrips.push(r.data);
        else pngWriter.write(r.data);
      },
    });
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    progress(0.94, 'Encoding');

    const parts = [];
    let ext, type;
    if (fmt === 'jpeg') {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', +$('exQuality').value / 100));
      if (!blob) throw new Error('JPEG encoding failed (image too large for the browser canvas?)');
      const jpg = new Uint8Array(await blob.arrayBuffer());
      // keep the browser's header segments except its own Exif and ICC profile
      // (Chrome embeds sRGB), then insert ours after a JFIF APP0
      const head = [];
      let at = 2, app0 = null;
      while (at + 4 <= jpg.length && jpg[at] === 0xff && jpg[at + 1] >= 0xe0 && jpg[at + 1] <= 0xef) {
        const len = (jpg[at + 2] << 8) | jpg[at + 3], s = jpg.subarray(at, at + 2 + len);
        const id = String.fromCharCode(...s.subarray(4, 15));
        if (s[1] === 0xe0 && !app0) app0 = s;
        else if (!(s[1] === 0xe1 && id.startsWith('Exif')) && !(s[1] === 0xe2 && id === 'ICC_PROFILE')) head.push(s);
        at += 2 + len;
      }
      const tiff = tiffBlock(meta.ifd0, meta.exif);
      const seg = (marker, head, body) => {
        const len = 2 + head.length + body.length;
        const s = new Uint8Array(2 + len);
        s.set([0xff, marker, len >> 8, len & 255]); s.set(head, 4); s.set(body, 4 + head.length);
        return s;
      };
      parts.push(jpg.subarray(0, 2), ...(app0 ? [app0] : []), seg(0xe1, te.encode('Exif\0\0'), tiff),
        seg(0xe2, Uint8Array.from([...te.encode('ICC_PROFILE\0'), 1, 1]), icc), ...head, jpg.subarray(at));
      ext = '.jpg'; type = 'image/jpeg';
    } else if (fmt === 'tiff16') {
      const counts = tiffStrips.map((s) => s.length);
      const n = counts.length;
      const ifd0 = [
        { tag: 256, type: 4, value: g.ow }, { tag: 257, type: 4, value: g.oh },
        { tag: 258, type: 3, value: [16, 16, 16] }, { tag: 259, type: 3, value: 8 }, { tag: 262, type: 3, value: 2 },
        { tag: 273, type: 4, value: new Array(n).fill(0) }, { tag: 274, type: 3, value: 1 }, { tag: 277, type: 3, value: 3 },
        { tag: 278, type: 4, value: stripH }, { tag: 279, type: 4, value: counts },
        { tag: 282, type: 5, value: [[300, 1]] }, { tag: 283, type: 5, value: [[300, 1]] },
        { tag: 284, type: 3, value: 1 }, { tag: 296, type: 3, value: 2 }, { tag: 317, type: 3, value: 2 },
        { tag: 34675, type: 7, value: icc },
        ...meta.ifd0,
      ];
      const head = tiffBlock(ifd0, meta.exif, (len) => {
        let o = len;
        ifd0[5].value = counts.map((c2) => { const r = o; o += c2; return r; });
      });
      parts.push(head, ...tiffStrips);
      ext = '.tif'; type = 'image/tiff';
    } else {
      await pngWriter.close();
      const z = new Uint8Array(await pngOut);
      const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
      v.setUint32(0, g.ow); v.setUint32(4, g.oh);
      ihdr.set([fmt === 'png16' ? 16 : 8, 2, 0, 0, 0], 8);
      const iccp = await deflate(icc);
      const name = te.encode(sp.label.replace(/[^\x20-\x7e]/g, '') + '\0\0');
      const iccChunk = new Uint8Array(name.length + iccp.length);
      iccChunk.set(name); iccChunk.set(iccp, name.length);
      parts.push(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('iCCP', iccChunk),
        pngChunk('eXIf', tiffBlock(meta.ifd0, meta.exif)));
      const CH = 1 << 22;
      for (let i = 0; i < z.length; i += CH) parts.push(pngChunk('IDAT', z.subarray(i, Math.min(z.length, i + CH))));
      parts.push(pngChunk('IEND', new Uint8Array(0)));
      ext = '.png'; type = 'image/png';
    }
    const blob = new Blob(parts, { type });
    const name = c.baseName + (g.rect.x0 !== c.img.active.left || g.rect.x1 !== c.img.active.right || g.rect.y0 !== c.img.active.top || g.rect.y1 !== c.img.active.bottom ? '_crop' : '') + ext;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return { name, size: blob.size, ms: performance.now() - t0 };
  }

  function init(getContext) {
    ctxFn = getContext;
    prefs(false);
    for (const id of ['exFormat', 'exQuality', 'exSpace', 'exAlgo', 'exArea', 'exRotate']) $(id).addEventListener('input', () => { updateForm(); prefs(true); });
    $('exCancel').onclick = () => {
      if (running) { running.cancelled = true; Demosaic.cancel(running.gen); return; }
      $('exportDialog').close();
    };
    $('exportDialog').addEventListener('cancel', (e) => { if (running) e.preventDefault(); });
    $('exGo').onclick = () => {
      setBusy(true);
      run().then((r) => {
        running = null;
        setBusy(false);
        $('exportDialog').close();
        if (getContext().onDone) getContext().onDone(`Saved ${r.name} (${(r.size / 1048576).toFixed(1)} MB) in ${(r.ms / 1000).toFixed(1)} s`);
      }, (e) => {
        running = null;
        setBusy(false);
        if (e.cancelled) { updateForm(); return; }
        console.error(e);
        $('exNote').textContent = 'Export failed: ' + e.message;
      });
    };
  }

  function open() {
    const c = ctxFn();
    if (!c || !c.img) return;
    const selOpt = $('exArea').querySelector('option[value=selection]');
    selOpt.disabled = !c.selection;
    $('exArea').value = c.selection ? 'selection' : 'active';
    const o = +(c.img.facts && c.img.facts.orientation) || 1;
    $('exRotateRow').hidden = !ORIENT_TEXT[o];
    $('exRotateRow').previousElementSibling.hidden = !ORIENT_TEXT[o];
    if (c.img.colors4) $('exAlgo').value = 'bilinear';
    updateForm();
    $('exportDialog').showModal();
  }

  window.ImageExport = { init, open, iccProfile, SPACES };
})();
