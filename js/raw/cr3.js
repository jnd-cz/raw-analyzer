/*
 * Canon CR3 container (ISO base media file format) parsing.
 * Layout knowledge from LibRaw's parseCR3 (LGPL 2.1 / CDDL 1.0).
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  const UUID_CANON = '85c0b687820f11e08111f4ce462b6a48';
  const UUID_PREVIEW = 'eaf42b5e1c984b88b9fbb7dc406e4d16';
  const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';

  const hex = (u8, o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += u8[o + i].toString(16).padStart(2, '0');
    return s;
  };

  RL.isCr3 = (u8) => u8.length > 12 && String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp' &&
    String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'crx ';

  RL.parseCr3 = function (u8) {
    const r = new RL.Reader(u8, false);
    const res = { tracks: [], cmt: {}, thumbs: [], boxes: [], compressor: '', xmp: null };
    let track = null;

    function walk(start, end, path, depth) {
      let o = start;
      while (o + 8 <= end && depth < 12) {
        let size = r.u32be(o);
        const type = r.fourcc(o + 4);
        let hdr = 8;
        if (size === 1) {
          size = r.u32be(o + 8) * 4294967296 + r.u32be(o + 12);
          hdr = 16;
        } else if (size === 0) size = end - o;
        if (size < hdr || o + size > end) break;
        const c = o + hdr, cEnd = o + size;
        const p = path ? path + '/' + type : type;
        if (depth <= 3) res.boxes.push({ path: p, offset: o, size });

        if (type === 'moov' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'dinf') {
          walk(c, cEnd, p, depth + 1);
        } else if (type === 'trak') {
          track = { index: res.tracks.length, handler: '', format: '', hdr: null, cmp1: null, sampleSize: 0, sampleSizes: null, offsets: [] };
          res.tracks.push(track);
          walk(c, cEnd, p, depth + 1);
          track = null;
        } else if (type === 'hdlr' && track) {
          track.handler = r.fourcc(c + 8);
        } else if (type === 'stsd' && track) {
          walk(c + 8, cEnd, p, depth + 1);
        } else if (type === 'CRAW' && track) {
          track.format = 'CRAW';
          walk(c + 82, cEnd, p, depth + 1);
        } else if (type === 'CTMD' && track) {
          track.format = 'CTMD';
        } else if (type === 'CMP1' && track) {
          const n = Math.min(cEnd - c, 85);
          track.cmp1 = { offset: c, size: n };
          track.hdr = RL.crxParseHeader(u8, c, n);
        } else if (type === 'JPEG' && track) {
          track.isJpeg = true;
        } else if (type === 'stsz' && track) {
          const ss = r.u32be(c + 4), cnt = r.u32be(c + 8);
          track.sampleCount = cnt;
          if (ss) track.sampleSize = ss;
          else if (cnt > 0) track.sampleSize = r.u32be(c + 12);
        } else if (type === 'co64' && track) {
          const cnt = r.u32be(c + 4);
          for (let i = 0; i < Math.min(cnt, 64); i++)
            track.offsets.push(r.u32be(c + 8 + 8 * i) * 4294967296 + r.u32be(c + 12 + 8 * i));
        } else if (type === 'stco' && track) {
          const cnt = r.u32be(c + 4);
          for (let i = 0; i < Math.min(cnt, 64); i++) track.offsets.push(r.u32be(c + 8 + 4 * i));
        } else if (type === 'uuid') {
          const id = hex(u8, c, 16);
          if (id === UUID_CANON && path === 'moov') {
            walk(c + 16, cEnd, p, depth + 1);
          } else if (id === UUID_PREVIEW && cEnd - c > 48) {
            if (r.fourcc(c + 16 + 12) === 'PRVW') {
              const x = c + 16;
              res.thumbs.push({ label: 'Preview (PRVW)', offset: x + 32, length: cEnd - (x + 32),
                width: r.u16be(x + 22), height: r.u16be(x + 24) });
            }
          } else if (id === UUID_XMP) {
            res.xmp = { offset: c + 16, length: cEnd - c - 16 };
          }
        } else if (/^CMT[1-4]$/.test(type)) {
          res.cmt[type] = { offset: c, size: cEnd - c };
        } else if (type === 'THMB' && cEnd - c > 16) {
          res.thumbs.push({ label: 'Thumbnail (THMB)', offset: c + 16, length: cEnd - c - 16,
            width: r.u16be(c + 4), height: r.u16be(c + 6) });
        } else if (type === 'CNCV') {
          res.compressor = r.ascii(c, cEnd - c);
        }
        o += size;
      }
    }
    walk(0, u8.length, '', 0);

    // pick the biggest raw track (crx_header MediaType == 1)
    let best = null, bestBits = 0;
    for (const t of res.tracks) {
      if (!t.hdr || !t.offsets.length || !t.sampleSize) continue;
      const bits = t.hdr.nBits * t.hdr.f_width * t.hdr.f_height;
      if (bits > bestBits) { bestBits = bits; best = t; }
    }
    res.rawTrack = best;
    // CTMD timed metadata: records 7/8/9 hold maker note TIFF blocks (ColorData etc.)
    res.ctmd = [];
    for (const t of res.tracks) {
      if (t.format !== 'CTMD' || !t.offsets.length || !t.sampleSize) continue;
      const base = t.offsets[0], size = t.sampleSize;
      const le = new RL.Reader(u8, true);
      let rel = 0;
      while (rel + 6 < size && base + rel + 6 <= u8.length) {
        const szItem = le.u32(base + rel), tItem = le.u16(base + rel + 4);
        if (szItem < 1 || rel + szItem > size) break;
        if (tItem === 7 || tItem === 8 || tItem === 9) {
          let inBox = rel + 12;
          while (inBox + 8 < rel + szItem) {
            const lTag = le.u32(base + inBox), tag = le.u32(base + inBox + 4);
            if (lTag < 8 || inBox + lTag > rel + szItem) break;
            if (tag === 0x927c) res.ctmd.push({ type: tItem, offset: base + inBox + 8, size: lTag - 8 });
            inBox += lTag;
          }
        }
        rel += szItem;
      }
    }
    // the JPEG track is a full size preview
    for (const t of res.tracks) {
      if (t.isJpeg && t.offsets.length && t.sampleSize)
        res.thumbs.unshift({ label: 'Full size JPEG', offset: t.offsets[0], length: t.sampleSize, width: 0, height: 0 });
    }
    return res;
  };
});
