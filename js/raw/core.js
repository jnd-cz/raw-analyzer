/*
 * Raw Analyzer - core binary helpers and TIFF/EXIF parsing.
 *
 * Every file in js/raw/ registers a module function in RAW_MODULES. The same
 * functions run on the main thread and, stringified, inside a Web Worker, so a
 * module must only touch its RL argument (no outer variables, no DOM).
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  class RawError extends Error {}
  RL.RawError = RawError;
  RL.fail = (msg) => { throw new RawError(msg); };

  // ---------------------------------------------------------------- reader
  class Reader {
    constructor(u8, le) {
      this.u8 = u8;
      this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.le = !!le;
      this.size = u8.byteLength;
    }
    u8at(o) { return this.u8[o]; }
    u16(o) { return this.dv.getUint16(o, this.le); }
    i16(o) { return this.dv.getInt16(o, this.le); }
    u32(o) { return this.dv.getUint32(o, this.le); }
    i32(o) { return this.dv.getInt32(o, this.le); }
    f32(o) { return this.dv.getFloat32(o, this.le); }
    f64(o) { return this.dv.getFloat64(o, this.le); }
    u16be(o) { return this.dv.getUint16(o, false); }
    u32be(o) { return this.dv.getUint32(o, false); }
    ascii(o, n) {
      let s = '';
      const end = Math.min(o + n, this.size);
      for (let i = o; i < end; i++) {
        const c = this.u8[i];
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    fourcc(o) {
      return String.fromCharCode(this.u8[o], this.u8[o + 1], this.u8[o + 2], this.u8[o + 3]);
    }
    inRange(o, n) { return o >= 0 && n >= 0 && o + n <= this.size; }
  }
  RL.Reader = Reader;

  // ----------------------------------------------------------------- TIFF
  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  const TYPE_NAME = ['', 'BYTE', 'ASCII', 'SHORT', 'LONG', 'RATIONAL', 'SBYTE', 'UNDEFINED',
    'SSHORT', 'SLONG', 'SRATIONAL', 'FLOAT', 'DOUBLE', 'IFD'];
  RL.TIFF_TYPE_NAME = TYPE_NAME;

  /**
   * Reads one IFD. Offsets inside the IFD are relative to `base`
   * (the start of the TIFF header) except where the caller says otherwise.
   * Returns { entries: Map(tag -> entry), list: [entry], next }.
   */
  function readIFD(r, base, off) {
    const abs = base + off;
    if (!r.inRange(abs, 2)) return null;
    const n = r.u16(abs);
    if (n === 0 || n > 1000 || !r.inRange(abs + 2, n * 12)) return null;
    const list = [];
    const entries = new Map();
    for (let i = 0; i < n; i++) {
      const e = abs + 2 + i * 12;
      const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
      const tsize = TYPE_SIZE[type] || 0;
      if (!tsize) continue;
      const bytes = tsize * count;
      const valOff = bytes <= 4 ? e + 8 : base + r.u32(e + 8);
      if (bytes > 4 && !r.inRange(valOff, Math.min(bytes, r.size))) continue;
      const entry = { tag, type, count, valOff, bytes, r };
      list.push(entry);
      if (!entries.has(tag)) entries.set(tag, entry);
    }
    const nextPos = abs + 2 + n * 12;
    const next = r.inRange(nextPos, 4) ? r.u32(nextPos) : 0;
    return { entries, list, next, offset: abs };
  }
  RL.readIFD = readIFD;

  /** Decodes up to `max` values of an entry. ASCII returns a string. */
  function tagValues(e, max) {
    const r = e.r;
    const n = Math.min(e.count, max || e.count);
    const o = e.valOff;
    switch (e.type) {
      case 2: return r.ascii(o, e.count).trim();
      case 1: case 7: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.u8[o + i]; return a; }
      case 6: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = (r.u8[o + i] << 24) >> 24; return a; }
      case 3: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.u16(o + 2 * i); return a; }
      case 8: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.i16(o + 2 * i); return a; }
      case 4: case 13: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.u32(o + 4 * i); return a; }
      case 9: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.i32(o + 4 * i); return a; }
      case 5: { const a = new Array(n); for (let i = 0; i < n; i++) { const d = r.u32(o + 8 * i + 4); a[i] = d ? r.u32(o + 8 * i) / d : 0; } return a; }
      case 10: { const a = new Array(n); for (let i = 0; i < n; i++) { const d = r.i32(o + 8 * i + 4); a[i] = d ? r.i32(o + 8 * i) / d : 0; } return a; }
      case 11: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.f32(o + 4 * i); return a; }
      case 12: { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = r.f64(o + 8 * i); return a; }
    }
    return [];
  }
  RL.tagValues = tagValues;
  RL.tagValue = (e) => { const v = tagValues(e, 1); return typeof v === 'string' ? v : v[0]; };

  /** Raw rational pair, for exact shutter speed display. */
  RL.tagRational = (e) => {
    if (e.type !== 5 && e.type !== 10) return null;
    const r = e.r;
    return e.type === 5 ? [r.u32(e.valOff), r.u32(e.valOff + 4)] : [r.i32(e.valOff), r.i32(e.valOff + 4)];
  };

  /** Parses "II*\0"/"MM\0*" header at `base`; returns a little/big endian Reader. */
  RL.tiffHeader = function (u8, base) {
    const a = u8[base], b = u8[base + 1];
    let le;
    if (a === 0x49 && b === 0x49) le = true;
    else if (a === 0x4d && b === 0x4d) le = false;
    else return null;
    const r = new Reader(u8, le);
    const magic = r.u16(base + 2);
    if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352) return null;
    return { r, ifd0: r.u32(base + 4) };
  };

  // ------------------------------------------------------ bit helpers
  RL.clz32 = Math.clz32;
});
