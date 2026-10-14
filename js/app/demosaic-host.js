/*
 * Worker pool for demosaicing and developing. The raw rectangle is cut into
 * strips with an 8 px overlap; each strip goes to the next free worker, so the
 * work spreads over the CPU cores. Every worker is a Blob worker built from the
 * demosaic module (works from file:// too). Without workers the strips run on
 * the main thread.
 */
(function () {
  'use strict';

  const MARGIN = 8; // context rows/columns around a strip (AHD needs 5)
  const MOD = self.RAW_MODULES.find((f) => f.name === 'demosaicModule');
  const SIZE = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1));

  const workerSource = () => [
    'const RL = {};',
    '(' + MOD.toString() + ')(RL);',
    `const deflate = (u8) => new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
    self.onmessage = async function (e) {
      const { id, job, dev, compress } = e.data;
      try {
        let r = RL.demosaic(job);
        if (dev) r = RL.develop(r, dev);
        if (compress) r.data = new Uint8Array(await deflate(new Uint8Array(r.data.buffer)));
        self.postMessage({ id, r }, [r.data.buffer]);
      } catch (err) {
        self.postMessage({ id, error: err && err.message ? err.message : String(err) });
      }
    };`,
  ].join('\n');

  const deflate = (u8) => new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();

  async function runLocal(msg) {
    let r = RL.demosaic(msg.job);
    if (msg.dev) r = RL.develop(r, msg.dev);
    if (msg.compress) r.data = new Uint8Array(await deflate(new Uint8Array(r.data.buffer)));
    return r;
  }

  const pool = {
    url: null, workers: [], idle: [], queue: [], tasks: new Map(), seq: 0, broken: false,
    get size() { return this.broken ? 1 : SIZE; },

    _spawn() {
      if (!this.url) this.url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
      const w = new Worker(this.url);
      w.onmessage = (e) => {
        const t = this.tasks.get(e.data.id);
        this.tasks.delete(e.data.id);
        w.busy = null;
        this.idle.push(w);
        if (t) { if (e.data.error) t.reject(new Error(e.data.error)); else t.resolve(e.data.r); }
        this._pump();
      };
      w.onerror = (e) => {
        // a worker that cannot start (blocked Blob workers): run everything locally
        e.preventDefault();
        const t = w.busy && this.tasks.get(w.busy);
        this.workers = this.workers.filter((x) => x !== w);
        this.idle = this.idle.filter((x) => x !== w);
        w.terminate();
        if (!this.workers.length) this.broken = true;
        if (t) { this.tasks.delete(w.busy); this.queue.unshift(t); }
        this._pump();
      };
      this.workers.push(w);
      this.idle.push(w);
    },

    _pump() {
      while (this.queue.length) {
        if (this.broken) {
          const t = this.queue.shift();
          // yield between strips so the page stays responsive
          setTimeout(() => runLocal(t.msg).then(t.resolve, t.reject), 0);
          continue;
        }
        if (!this.idle.length) {
          if (this.workers.length >= SIZE) return;
          try { this._spawn(); } catch (e) { console.warn('Workers unavailable, demosaicing on the main thread', e); this.broken = true; continue; }
        }
        const t = this.queue.shift();
        const w = this.idle.pop();
        w.busy = t.id;
        this.tasks.set(t.id, t);
        w.postMessage({ id: t.id, ...t.msg }, [t.msg.job.raw.buffer]);
      }
    },

    run(msg, gen) {
      return new Promise((resolve, reject) => {
        this.queue.push({ id: ++this.seq, msg, gen, resolve, reject });
        this._pump();
      });
    },

    /** Drops queued strips of an outdated request (running ones finish and are ignored). */
    cancel(gen) {
      const keep = [];
      for (const t of this.queue) { if (t.gen === gen) t.reject(Object.assign(new Error('cancelled'), { cancelled: true })); else keep.push(t); }
      this.queue = keep;
    },
  };

  // LibRaw's cam_xyz_coeff (camera -> sRGB), used by AHD for its CIELab test
  const XYZ_RGB = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
  function rgbCamLibRaw(m) {
    if (!m || m.length !== 9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const cr = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[3 * i] * XYZ_RGB[0][j] + m[3 * i + 1] * XYZ_RGB[1][j] + m[3 * i + 2] * XYZ_RGB[2][j]));
    for (const r of cr) { const s = r[0] + r[1] + r[2]; for (let j = 0; j < 3; j++) r[j] /= s; }
    const [a, b, c] = cr[0], [d, e, f] = cr[1], [g, h, i] = cr[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    const inv = [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]];
    return inv.map((r) => r.map((v) => Math.fround(v / det)));
  }

  /** Scaling for the demosaic step: black, white balance and 65535 / range per channel. */
  function params(img, levels, wb, algo) {
    const colors = img.colors4 ? 4 : 3;
    const w4 = colors === 4 ? wb.slice(0, 4) : [wb[0], wb[1], wb[2], wb[1]];
    const wmin = Math.min(...w4.slice(0, colors === 4 ? 4 : 3));
    const mul = w4.map((v, c) => (v / wmin) * 65535 / Math.max(1, levels.white - levels.black[c]));
    return { colors, black: levels.black.slice(), mul, wbMin: wmin, algo, rgbCam: rgbCamLibRaw(img.colorMatrix) };
  }

  function cut(img, bounds, x0, y0, x1, y1, p) {
    const cx0 = Math.max(bounds.left, x0 - MARGIN), cy0 = Math.max(bounds.top, y0 - MARGIN);
    const cx1 = Math.min(bounds.right, x1 + MARGIN), cy1 = Math.min(bounds.bottom, y1 + MARGIN);
    const w = cx1 - cx0, h = cy1 - cy0, RW = img.width;
    const raw = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) raw.set(img.raw.subarray((cy0 + y) * RW + cx0, (cy0 + y) * RW + cx1), y * w);
    const fc4 = [0, 1, 2, 3].map((q) => img.cfa[((cy0 + (q >> 1)) & 1) * 2 + ((cx0 + (q & 1)) & 1)]);
    return {
      raw, w, h, fc4, black: p.black, mul: p.mul, colors: p.colors, algo: p.algo, rgbCam: p.rgbCam,
      crop: { x: x0 - cx0, y: y0 - cy0, w: x1 - x0, h: y1 - y0 },
    };
  }

  let genSeq = 0;

  /**
   * Demosaics rect {x0,y0,x1,y1} (inside bounds) in parallel strips.
   * Resolves to { x0, y0, w, h, colors, data } (camera RGB, white balanced, 16 bit).
   */
  async function region(img, rect, bounds, p, gen) {
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    const sh = Math.max(32, Math.ceil(h / pool.size));
    const jobs = [];
    for (let y = rect.y0; y < rect.y1; y += sh) {
      const y1 = Math.min(rect.y1, y + sh);
      jobs.push(pool.run({ job: cut(img, bounds, rect.x0, y, rect.x1, y1, p) }, gen).then((r) => ({ y, r })));
    }
    const data = new Uint16Array(w * h * p.colors);
    for (const { y, r } of await Promise.all(jobs)) data.set(r.data, (y - rect.y0) * w * p.colors);
    return { x0: rect.x0, y0: rect.y0, w, h, colors: p.colors, data };
  }

  /**
   * Full pipeline for export. Output strips (in output orientation) are handed to
   * onStrip(index, rows, result) in order. dev is passed to RL.develop.
   */
  async function developArea(img, rect, bounds, p, dev, opts) {
    const { stripH = 256, compress = false, onStrip, onProgress, gen, cancelled } = opts;
    const o = dev.orient || 1;
    const vertical = o === 6 || o === 8;
    const len = vertical ? rect.x1 - rect.x0 : rect.y1 - rect.y0;
    const n = Math.ceil(len / stripH);
    const tasks = [];
    for (let k = 0; k < n; k++) {
      // output strip k -> source rows or columns
      let a, b;
      if (o === 3 || o === 8) { b = len - k * stripH; a = Math.max(0, b - stripH); } else { a = k * stripH; b = Math.min(len, a + stripH); }
      const job = () => (vertical
        ? cut(img, bounds, rect.x0 + a, rect.y0, rect.x0 + b, rect.y1, p)
        : cut(img, bounds, rect.x0, rect.y0 + a, rect.x1, rect.y0 + b, p));
      tasks.push(() => pool.run({ job: job(), dev, compress }, gen));
    }
    // keep a bounded number of strips in flight: raw copies are made lazily
    let next = 0, done = 0;
    const results = new Array(n);
    const pending = new Map();
    let emitted = 0;
    await new Promise((resolve, reject) => {
      const launch = () => {
        if (cancelled && cancelled()) { reject(Object.assign(new Error('cancelled'), { cancelled: true })); return; }
        while (next < n && pending.size < pool.size * 2) {
          const k = next++;
          const pr = tasks[k]().then((r) => {
            pending.delete(k);
            results[k] = r;
            done++;
            if (onProgress) onProgress(done / n);
            while (emitted < n && results[emitted]) { onStrip(emitted, results[emitted]); results[emitted] = true; emitted++; }
            if (done === n) resolve(); else launch();
          }, reject);
          pending.set(k, pr);
        }
      };
      launch();
    });
    return { strips: n };
  }

  window.Demosaic = {
    get threads() { return pool.size; },
    newGen: () => ++genSeq,
    cancel: (gen) => pool.cancel(gen),
    params, region, developArea,
  };
})();
