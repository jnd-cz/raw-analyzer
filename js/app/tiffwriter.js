/*
 * Little-endian TIFF writer for the image export, Exif blocks and DNG.
 *
 * An IFD is { entries: [entry], next: ifd | null }. Entry forms:
 *   { tag, type, value }           value: string (ASCII), number or array (BYTE,
 *                                  SHORT, LONG, SSHORT, SLONG), [[num, den]...]
 *                                  (RATIONAL, SRATIONAL), Uint8Array (UNDEFINED)
 *   { tag, type: 4, ifds: [ifd] }  offsets of other IFDs (SubIFDs, Exif IFD)
 *   { tag, type: 4, blocks: [u8] } offsets of data blocks (strips, tiles)
 * Falsy entries are skipped. build() lays out the header and every IFD first
 * and the data blocks after them, so big image data is never copied: the result
 * is a list of parts for a Blob.
 */
(function () {
  'use strict';

  const te = new TextEncoder();
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8 };

  function valueBytes(e, resolve) {
    const t = e.type;
    if (t === 2) return te.encode(String(e.value).replace(/[^\x20-\x7e]/g, '?') + '\0');
    if (t === 7) return e.value instanceof Uint8Array ? e.value : new Uint8Array(e.value);
    let vals = e.ifds ? e.ifds.map((x) => (resolve ? x.pos : 0)) : e.blocks ? e.blocks.map((x) => (resolve ? x.pos : 0)) : e.value;
    if (!Array.isArray(vals)) vals = [vals];
    const out = new Uint8Array(vals.length * SIZE[t]), v = new DataView(out.buffer);
    vals.forEach((x, i) => {
      switch (t) {
        case 1: out[i] = x; break;
        case 3: v.setUint16(2 * i, x, true); break;
        case 8: v.setInt16(2 * i, x, true); break;
        case 4: v.setUint32(4 * i, x, true); break;
        case 9: v.setInt32(4 * i, x, true); break;
        case 5: v.setUint32(8 * i, x[0], true); v.setUint32(8 * i + 4, x[1], true); break;
        case 10: v.setInt32(8 * i, x[0], true); v.setInt32(8 * i + 4, x[1], true); break;
      }
    });
    return out;
  }

  const even = (n) => (n + 1) & ~1;

  /** ifds: every IFD of the file, IFD0 first. Returns { parts, size }. */
  function build(ifds) {
    for (const ifd of ifds) ifd.list = ifd.entries.filter(Boolean).sort((a, b) => a.tag - b.tag);
    // pass 1: positions (value sizes do not depend on the offsets)
    let pos = 8;
    for (const ifd of ifds) {
      ifd.pos = pos;
      pos += 6 + 12 * ifd.list.length;
      for (const e of ifd.list) { const n = valueBytes(e, false).length; if (n > 4) pos += even(n); }
    }
    const blocks = [];
    for (const ifd of ifds) for (const e of ifd.list) if (e.blocks) for (const b of e.blocks) blocks.push(b);
    const headLen = even(pos);
    let bpos = headLen;
    const blockInfo = new Map();
    for (const b of blocks) { blockInfo.set(b, { pos: bpos }); bpos += even(b.byteLength); }
    // pass 2: write
    const head = new Uint8Array(headLen), dv = new DataView(head.buffer);
    head.set([0x49, 0x49, 42, 0]);
    dv.setUint32(4, ifds[0].pos, true);
    for (const ifd of ifds) {
      dv.setUint16(ifd.pos, ifd.list.length, true);
      let data = ifd.pos + 6 + 12 * ifd.list.length;
      ifd.list.forEach((e, i) => {
        const p = ifd.pos + 2 + 12 * i;
        const resolved = e.blocks ? { ...e, blocks: e.blocks.map((b) => blockInfo.get(b)) } : e;
        const bytes = valueBytes(resolved, true);
        dv.setUint16(p, e.tag, true);
        dv.setUint16(p + 2, e.type, true);
        dv.setUint32(p + 4, bytes.length / SIZE[e.type], true);
        if (bytes.length <= 4) head.set(bytes, p + 8);
        else { dv.setUint32(p + 8, data, true); head.set(bytes, data); data += even(bytes.length); }
      });
      dv.setUint32(ifd.pos + 2 + 12 * ifd.list.length, ifd.next ? ifd.next.pos : 0, true);
    }
    const parts = [head];
    for (const b of blocks) {
      parts.push(b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      if (b.byteLength & 1) parts.push(new Uint8Array(1));
    }
    return { parts, size: bpos };
  }

  /** Header + IFD0 (+ Exif IFD) as one byte array, for JPEG APP1 and PNG eXIf. */
  function exifBlock(ifd0, exif) {
    const ex = exif && exif.filter(Boolean).length ? { entries: exif } : null;
    const first = { entries: ex ? [...ifd0, { tag: 34665, type: 4, ifds: [ex] }] : ifd0 };
    return build(ex ? [first, ex] : [first]).parts[0];
  }

  window.TiffWriter = { build, exifBlock };
})();
