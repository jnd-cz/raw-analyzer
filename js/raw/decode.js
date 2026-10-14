/*
 * Top level decoding: format detection, raw unpacking, metadata collection
 * and the derived values the analyzer needs (active area, CFA, levels, WB).
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  const CH = { R: 0, G: 1, B: 2, G2: 3 };
  // CFA patterns as channel ids for positions (0,0) (0,1) (1,0) (1,1)
  const CFA = {
    RGGB: [CH.R, CH.G, CH.G2, CH.B],
    GRBG: [CH.G, CH.R, CH.B, CH.G2],
    GBRG: [CH.G, CH.B, CH.R, CH.G2],
    BGGR: [CH.B, CH.G, CH.G2, CH.R],
  };
  RL.CFA = CFA;

  const isJpeg = (u8, o) => u8[o] === 0xff && u8[o + 1] === 0xd8;

  // dcraw "filters" bytes: CFA at (0,0) (0,1) (1,0) (1,1)
  const FILTER_CODES = { 0x94: CFA.RGGB, 0x49: CFA.GBRG, 0x16: CFA.BGGR, 0x61: CFA.GRBG };

  /**
   * CR2 CFA layout at the raw frame origin. Canon's pattern is fixed relative
   * to the image area corner (LibRaw table), so an odd margin shifts it: the
   * EOS 5D Mark II (top margin 51) starts its raw frame with a G-B row.
   */
  function canonCfa(w, h) {
    const e = (RL.CANON_GEOMETRY || []).find((r) => r[0] === w && r[1] === h);
    if (!e) return null;
    const base = FILTER_CODES[e[4] || 0x94] || CFA.RGGB;
    const left = e[2], top = e[3];
    return [0, 1].flatMap((r) => [0, 1].map((c) => base[((r + top) & 1) * 2 + ((c + left) & 1)]));
  }

  /** Which diagonal of the 2x2 blocks holds the two greens (their values agree best). */
  function greenDiagonal(raw, W, H) {
    let dMain = 0, dAnti = 0, n = 0;
    const step = Math.max(2, ((Math.sqrt(W * H / 400000)) | 0) & ~1);
    for (let y = 0; y + 1 < H; y += step) {
      for (let x = 0; x + 1 < W; x += step) {
        const o = y * W + x;
        const a = raw[o], b = raw[o + 1], c = raw[o + W], d = raw[o + W + 1];
        if (a > 12000 || b > 12000 || c > 12000 || d > 12000) continue;
        dMain += Math.abs(a - d);
        dAnti += Math.abs(b - c);
        n++;
      }
    }
    if (n < 1000 || !(dMain + dAnti)) return null;
    return { diag: dMain < dAnti ? 'main' : 'anti', ratio: Math.max(dMain, dAnti) / Math.max(1, Math.min(dMain, dAnti)) };
  }

  function addThumb(res, u8, label, off, len, w, h) {
    if (!(off > 0) || !(len > 64) || off + len > u8.length || !isJpeg(u8, off)) return;
    if (res.thumbs.some((t) => t.offset === off)) return;
    res.thumbs.push({ label, offset: off, length: len, width: w || 0, height: h || 0, mime: 'image/jpeg', data: u8.slice(off, off + len) });
  }

  function fact(res, key, value) {
    if (value === undefined || value === null || value === '' || (typeof value === 'number' && !isFinite(value))) return;
    if (res.facts[key] === undefined) res.facts[key] = value;
  }

  function vals(ifd, tag, max) {
    const e = ifd && ifd.entries.get(tag);
    return e ? RL.tagValues(e, max) : null;
  }
  function val(ifd, tag) {
    const e = ifd && ifd.entries.get(tag);
    return e ? RL.tagValue(e) : undefined;
  }

  // ------------------------------------------------------- EXIF + Canon
  function readExifFacts(res, ifd0, exif, gps) {
    if (ifd0) {
      fact(res, 'make', val(ifd0, 0x010f));
      fact(res, 'model', val(ifd0, 0x0110));
      fact(res, 'date', val(ifd0, 0x0132));
      fact(res, 'artist', val(ifd0, 0x013b));
      fact(res, 'copyright', val(ifd0, 0x8298));
      fact(res, 'orientation', val(ifd0, 0x0112));
    }
    if (exif) {
      const et = exif.entries.get(0x829a);
      if (et) fact(res, 'exposureTime', RL.tagValue(et));
      fact(res, 'fnumber', val(exif, 0x829d));
      fact(res, 'iso', val(exif, 0x8827));
      fact(res, 'date', val(exif, 0x9003));
      fact(res, 'ec', val(exif, 0x9204));
      fact(res, 'brightnessValue', val(exif, 0x9203)); // APEX Bv, rarely written by Canon
      fact(res, 'focal', val(exif, 0x920a));
      fact(res, 'focal35', val(exif, 0xa405));
      const prog = val(exif, 0x8822);
      if (prog !== undefined) fact(res, 'programRaw', prog);
      const met = val(exif, 0x9207);
      if (met !== undefined) fact(res, 'meteringRaw', met);
      const fl = val(exif, 0x9209);
      if (fl !== undefined) fact(res, 'flash', fl & 1 ? 'Fired' : 'Did not fire');
      fact(res, 'lens', val(exif, 0xa434));
      fact(res, 'lensSerial', val(exif, 0xa435));
      fact(res, 'serial', val(exif, 0xa431));
      fact(res, 'owner', val(exif, 0xa430));
      const sub = val(exif, 0x9291);
      if (sub) fact(res, 'subsec', sub);
    }
    if (gps) {
      const lat = vals(gps, 0x0002), lon = vals(gps, 0x0004);
      if (lat && lon && lat.length === 3 && lon.length === 3 && (lat[0] || lon[0])) {
        const la = (lat[0] + lat[1] / 60 + lat[2] / 3600) * (val(gps, 0x0001) === 'S' ? -1 : 1);
        const lo = (lon[0] + lon[1] / 60 + lon[2] / 3600) * (val(gps, 0x0003) === 'W' ? -1 : 1);
        fact(res, 'gps', la.toFixed(6) + ', ' + lo.toFixed(6));
      }
    }
  }

  function readCanonMakernote(res, mn) {
    if (!mn) return;
    const cs = vals(mn, 0x0001);
    if (cs) res.canon.cs = RL.canonCameraSettings(cs);
    const si = vals(mn, 0x0004);
    if (si) res.canon.si = RL.canonShotInfo(si);
    // raw records for the shutter count (decoded once the model is known)
    res.canon.fileInfo = mn.entries.get(0x0093) || res.canon.fileInfo;
    res.canon.cameraInfo = mn.entries.get(0x000d) || res.canon.cameraInfo;
    fact(res, 'imageType', val(mn, 0x0006));
    const fw = val(mn, 0x0007);
    if (fw) fact(res, 'firmware', String(fw).replace(/^Firmware( Version)?\s*/i, ''));
    const own = val(mn, 0x0009);
    if (own && /\S/.test(own)) fact(res, 'owner', own.replace(/[^\x20-\x7e].*$/, '').trim());
    const sn = val(mn, 0x000c);
    if (sn) fact(res, 'serial', String(sn));
    fact(res, 'internalSerial', val(mn, 0x0096));
    const lens = val(mn, 0x0095);
    if (lens && /\S/.test(lens)) fact(res, 'lens', lens.replace(/[^\x20-\x7e].*$/, '').trim());
    const mid = val(mn, 0x0010);
    if (mid) fact(res, 'modelId', '0x' + (mid >>> 0).toString(16));
    const sens = vals(mn, 0x00e0);
    if (sens) res.canon.sensor = RL.canonSensorInfo(sens);
    // ColorData: LibRaw switches on the tag count and reads 16 bit words,
    // whatever the declared type (some PowerShots store it as UNDEFINED)
    const cde = mn.entries.get(0x4001);
    if (cde && cde.count > 500 && !res.canon.colorData) {
      const r = cde.r, n = Math.min(cde.count, ((r.size - cde.valOff) >> 1));
      const words = new Array(n);
      for (let i = 0; i < n; i++) words[i] = r.u16(cde.valOff + 2 * i);
      res.canon.colorData = RL.canonColorData(words, cde.count);
    }
    const fl = vals(mn, 0x0002);
    if (fl && fl.length >= 2 && fl[1]) res.canon.focalLen = fl[1];
  }

  function exifGroups(res, ifd0, exif, gps, mn, extra) {
    if (ifd0) res.groups.push({ name: 'IFD0', rows: RL.describeIFD(ifd0, RL.TAGS.EXIF, 'exif') });
    if (exif) res.groups.push({ name: 'EXIF', rows: RL.describeIFD(exif, RL.TAGS.EXIF, 'exif') });
    if (gps) res.groups.push({ name: 'GPS', rows: RL.describeIFD(gps, RL.TAGS.GPS, 'gps') });
    if (mn) res.groups.push({ name: 'Canon MakerNote', rows: RL.describeIFD(mn, RL.TAGS.CANON, 'canon') });
    if (extra) for (const g of extra) res.groups.push(g);
  }

  // ------------------------------------------------------------- TIFF / CR2
  function decodeTiffRaw(u8, res, progress) {
    const th = RL.tiffHeader(u8, 0);
    const r = th.r;
    const isCr2 = u8[8] === 0x43 && u8[9] === 0x52;
    res.format = isCr2 ? 'CR2' : 'TIFF';
    if (isCr2) res.info.push(['CR2 version', u8[10] + '.' + u8[11]]);

    const ifds = [];
    let off = th.ifd0;
    const seen = new Set();
    while (off && ifds.length < 10 && !seen.has(off)) {
      seen.add(off);
      const ifd = RL.readIFD(r, 0, off);
      if (!ifd) break;
      ifds.push(ifd);
      off = ifd.next;
    }
    if (!ifds.length) RL.fail('No TIFF directories found');
    // SubIFDs
    for (const ifd of ifds.slice()) {
      const s = vals(ifd, 0x014a);
      if (s) for (const o of s) { const sub = RL.readIFD(r, 0, o); if (sub) ifds.push(sub); }
    }
    const ifd0 = ifds[0];
    const exifOff = val(ifd0, 0x8769);
    const exif = exifOff ? RL.readIFD(r, 0, exifOff) : null;
    const gpsOff = val(ifd0, 0x8825);
    const gps = gpsOff ? RL.readIFD(r, 0, gpsOff) : null;
    const mnEntry = exif && exif.entries.get(0x927c);
    const mn = mnEntry ? RL.readIFD(r, 0, mnEntry.valOff) : null;

    readExifFacts(res, ifd0, exif, gps);
    readCanonMakernote(res, mn);

    // thumbnails / previews
    ifds.forEach((ifd, i) => {
      const so = val(ifd, 0x0111), sb = val(ifd, 0x0117);
      const comp = val(ifd, 0x0103);
      const lj = so && sb && comp === 6 && isJpeg(u8, so) ? RL.ljpegInfo(u8, so) : null;
      if (lj && lj.algo !== 0xc3)
        addThumb(res, u8, i === 0 ? 'Preview JPEG' : 'JPEG (IFD' + i + ')', so, sb, val(ifd, 0x0100), val(ifd, 0x0101));
      const jo = val(ifd, 0x0201), jl = val(ifd, 0x0202);
      if (jo && jl) addThumb(res, u8, 'Thumbnail (IFD' + i + ')', jo, jl);
      // uncompressed 8 bit RGB thumbnail (EOS-1D/1Ds TIF)
      const bps = vals(ifd, 0x0102), w = val(ifd, 0x0100), h = val(ifd, 0x0101);
      if (comp === 1 && val(ifd, 0x0106) === 2 && bps && bps[0] === 8 && val(ifd, 0x0115) === 3 && so && w * h * 3 <= (sb || 0) && w * h < 4e6)
        res.thumbs.push({ label: 'RGB thumbnail (IFD' + i + ')', mime: 'rgb8', offset: so, length: w * h * 3, width: w, height: h, data: u8.slice(so, so + w * h * 3) });
    });

    // locate the raw data
    let rawOffset = 0, slices = null, rawW = 0, rawH = 0, cfa = CFA.RGGB, jh = null, rawIfd = null;
    const mnRaw = mn && mn.entries.get(0x0081);
    if (mnRaw && mnRaw.type === 4) {
      // EOS-1D / 1Ds: raw data offset stored in the maker note
      rawOffset = RL.tagValue(mnRaw);
      rawH = r.u16(rawOffset + 41) * 2;
      rawW = r.u16(rawOffset + 43);
      cfa = CFA.GRBG;
      res.format = 'TIF (EOS-1D raw)';
      jh = RL.ljpegInfo(u8, rawOffset);
    } else {
      for (let i = ifds.length - 1; i >= 0; i--) {
        const ifd = ifds[i];
        const so = val(ifd, 0x0111);
        if (!so || so >= u8.length) continue;
        const info = RL.ljpegInfo(u8, so);
        if (info && info.algo === 0xc3) { rawIfd = ifd; rawOffset = so; jh = info; break; }
      }
      if (!rawIfd) RL.fail('No lossless JPEG raw data found in this TIFF file');
      const s = vals(rawIfd, 0xc640);
      if (s && s.length >= 3 && s[0]) slices = s;
      const total = jh.wide * jh.clrs * jh.high;
      const tw = val(rawIfd, 0x0100), tht = val(rawIfd, 0x0101);
      const sensor = res.canon.sensor;
      if (tw && tht && tw * tht === total) { rawW = tw; rawH = tht; }
      else if (sensor && sensor.width * sensor.height === total) { rawW = sensor.width; rawH = sensor.height; }
      else {
        rawW = jh.wide * jh.clrs; rawH = jh.high;
        if (rawW > 4 * rawH && !(jh.clrs & 1)) { rawW >>= 1; rawH <<= 1; }
      }
      if (val(rawIfd, 0xc6c5) > 1 || jh.sraw) RL.fail('This is a Canon sRAW/mRAW file (YCbCr data), which has no raw sensor values to analyze');
    }
    if (!jh) RL.fail('Unsupported raw data layout');
    if (!(rawW > 0 && rawH > 0 && rawW * rawH < 4e8)) RL.fail('Implausible raw dimensions');

    const raw = new Uint16Array(rawW * rawH);
    RL.decodeLJ92(u8, rawOffset, raw, rawW, rawH, slices, progress);
    res.raw = raw;
    res.width = rawW;
    res.height = rawH;
    if (!mnRaw) {
      // CR2: CFA from the geometry table, cross-checked against the pixel data
      const tableCfa = canonCfa(rawW, rawH);
      const gd = greenDiagonal(raw, rawW, rawH);
      const greensMain = (p) => p[0] === CH.G || p[0] === CH.G2;
      let source;
      if (tableCfa && !(gd && gd.ratio > 1.5 && greensMain(tableCfa) !== (gd.diag === 'main'))) {
        cfa = tableCfa;
        source = 'LibRaw geometry table' + (gd ? ', confirmed by pixel data' : '');
      } else if (gd) {
        cfa = gd.diag === 'main' ? CFA.GBRG : CFA.RGGB;
        source = 'detected from pixel data (greens on the ' + gd.diag + ' diagonal)' + (tableCfa ? ', overriding the table' : '');
      } else source = 'default';
      res.info.push(['CFA layout source', source]);
    }
    res.cfa = cfa;
    res.bits = jh.bits;
    res.info.push(['Compression', 'Lossless JPEG (SOF3), predictor ' + jh.psv]);
    res.info.push(['LJ92 frame', `${jh.wide} x ${jh.high}, ${jh.clrs} component(s), ${jh.bits} bit`]);
    if (slices) res.info.push(['CR2 slices', `${slices[0]} x ${slices[1]} px + ${slices[2]} px`]);
    res.info.push(['Raw data offset', rawOffset + ' (0x' + rawOffset.toString(16) + ')']);

    exifGroups(res, ifd0, exif, gps, mn, ifds.slice(1).map((ifd, i) => ({
      name: 'IFD' + (i + 1), rows: RL.describeIFD(ifd, RL.TAGS.EXIF, 'exif') })));

    // EOS-1D/1Ds white balance table
    const wbt = mn && vals(mn, 0x00a4);
    if (mnRaw && wbt && res.canon.si) {
      const i = (res.canon.si.wbIndex || 0) * 24;
      if (i + 2 < wbt.length) res.wbAsShot = [wbt[i], wbt[i + 1], wbt[i + 2], wbt[i + 1]];
    }
  }

  // ----------------------------------------------------------------- CRW
  function decodeCrw(u8, res, progress) {
    const ciff = RL.parseCiff(u8);
    const r = ciff.r;
    res.format = 'CRW';
    let sensor = null, table = 0, rawRec = null, cs = null, shot = null, colorBal = null, focalRaw = 0;
    const rows = [];
    const u16s = (rec, n) => { const a = []; const m = Math.min(n, rec.len >> 1); for (let i = 0; i < m; i++) a.push(r.u16(rec.off + 2 * i)); return a; };

    for (const rec of ciff.recs) {
      const id = rec.id;
      let value = '';
      switch (id) {
        case 0x080a: {
          const make = r.ascii(rec.off, rec.len);
          fact(res, 'make', make);
          fact(res, 'model', r.ascii(rec.off + make.length + 1, rec.len - make.length - 1));
          value = make + ' / ' + res.facts.model;
          break;
        }
        case 0x080b: fact(res, 'firmware', r.ascii(rec.off, rec.len).replace(/^Firmware( Version)?\s*/i, '')); break;
        case 0x0810: { const o = r.ascii(rec.off, rec.len).trim(); if (/^[\x20-\x7e]+$/.test(o)) fact(res, 'owner', o); break; }
        case 0x1031: sensor = RL.canonSensorInfo(u16s(rec, 17)); break;
        case 0x1835: table = r.u32(rec.off); value = 'table ' + table; break;
        case 0x2005: rawRec = rec; value = '[' + rec.len + ' bytes]'; break;
        case 0x2007: addThumb(res, u8, 'JPEG from raw', rec.off, rec.len); break;
        case 0x2008: addThumb(res, u8, 'Thumbnail', rec.off, rec.len); break;
        case 0x102d: cs = u16s(rec, 64); break;
        case 0x102a: shot = u16s(rec, 64); break;
        case 0x10a9: colorBal = u16s(rec, 128); break;
        case 0x1818: {
          if (rec.len >= 12) {
            const ec = r.f32(rec.off), tv = r.f32(rec.off + 4), av = r.f32(rec.off + 8);
            if (isFinite(tv)) fact(res, 'exposureTime', Math.pow(2, -tv));
            if (isFinite(av) && av > 0) fact(res, 'fnumber', Math.pow(2, av / 2));
            if (isFinite(ec)) fact(res, 'ec', ec);
            value = `EC ${RL.fmtNum(ec, 2)}, Tv ${RL.fmtNum(tv, 3)}, Av ${RL.fmtNum(av, 3)}`;
          }
          break;
        }
        case 0x180e: {
          const t = r.u32(rec.off);
          fact(res, 'date', new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19));
          value = String(t);
          break;
        }
        case 0x180b: if (rec.inRecord) fact(res, 'serial', String(rec.raw32)); break;
        case 0x101c: if (rec.inRecord) res.canon.baseIso = rec.raw32 & 0xffff; break; // the body's base ISO, not the shot ISO
        case 0x1029: if (rec.inRecord) focalRaw = rec.raw32 >>> 16; else if (rec.len >= 4) focalRaw = r.u16(rec.off + 2); break;
        case 0x1834: if (rec.inRecord) fact(res, 'modelId', '0x' + (rec.raw32 >>> 0).toString(16)); break;
        case 0x1810: if (rec.len >= 16) {
          const rot = r.i32(rec.off + 12);
          value = `${r.u32(rec.off)} x ${r.u32(rec.off + 4)}, rotation ${rot}`;
          fact(res, 'orientation', { 0: 1, 90: 6, 180: 3, 270: 8 }[((rot % 360) + 360) % 360]); // as EXIF Orientation
          break;
        }
      }
      if (!value) {
        if (rec.inRecord) value = '0x' + (rec.raw32 >>> 0).toString(16).padStart(8, '0');
        else if (rec.dataType === 0x0800) value = r.ascii(rec.off, Math.min(rec.len, 128));
        else if (rec.dataType === 0x1000) { const a = u16s(rec, 17); value = a.slice(0, 16).join(', ') + ((rec.len >> 1) > 16 ? ', ... (' + (rec.len >> 1) + ' values)' : ''); }
        else if (rec.dataType === 0x1800) { const n = Math.min(rec.len >> 2, 8); const a = []; for (let i = 0; i < n; i++) a.push(r.u32(rec.off + 4 * i)); value = a.join(', '); }
        else if (rec.dataType === 0x2800 || rec.dataType === 0x3000) value = '(directory)';
        else value = '[' + rec.len + ' bytes]';
      }
      rows.push({ id: '0x' + rec.type.toString(16).padStart(4, '0'), name: (rec.depth ? '  '.repeat(rec.depth) : '') + (RL.TAGS.CIFF[id] || 'Record 0x' + id.toString(16)),
        type: rec.inRecord ? 'in-record' : ['BYTE', 'ASCII', 'SHORT', 'LONG', 'STRUCT', 'DIR', 'DIR', '?'][rec.dataType >> 11], count: rec.len, value });
    }
    res.groups.push({ name: 'CIFF records', rows });

    if (cs) res.canon.cs = RL.canonCameraSettings(cs);
    if (shot && shot.length > 7) {
      if (shot[1] + shot[2]) fact(res, 'iso', Math.round(Math.pow(2, (shot[1] + shot[2]) / 32 - 5) * 100));
      // CanonShotInfo target aperture / exposure time (LibRaw parse_ciff 0x102a)
      if (shot[4] && shot[4] !== 0xffe0 && shot[4] !== 0x7fff) fact(res, 'fnumber', Math.pow(2, shot[4] / 64));
      if (shot[5]) fact(res, 'exposureTime', Math.pow(2, -((shot[5] << 16) >> 16) / 32));
      res.canon.si = RL.canonShotInfo(shot);
    }
    if (res.canon.baseIso) fact(res, 'iso', res.canon.baseIso);
    if (focalRaw) fact(res, 'focal', focalRaw / ((cs && cs[25]) || 1));
    res.canon.sensor = sensor;

    // ColorBalance (D60, 10D, 300D): Auto, Daylight, Shade, Cloudy, Tungsten, Fluorescent, Flash, [Custom, Kelvin], black
    if (colorBal && colorBal.length > 8) {
      const nWB = ((colorBal[0] - 2) / 8 | 0) - 1;
      const rec = (k) => { const o = 1 + 4 * k; return [colorBal[o], colorBal[o + 1], colorBal[o + 3], colorBal[o + 2]]; };
      const slot = { 0: 0, 1: 1, 8: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 9: 8 };
      const wbi = res.canon.si ? res.canon.si.wbIndex : 0;
      let k = slot[wbi];
      if (k === undefined || k >= nWB) k = 0;
      if (nWB >= 1) res.wbAsShot = rec(k);
      if (nWB >= 7) {
        const b = 1 + 4 * nWB;
        if (b + 3 < colorBal.length) res.canon.blackRGGB = [colorBal[b], colorBal[b + 1], colorBal[b + 2], colorBal[b + 3]];
      }
    }

    // raw size: SensorInfo, else the dcraw table of early CIFF cameras
    let rawW = 0, rawH = 0;
    if (sensor && sensor.width && sensor.height) { rawW = sensor.width; rawH = sensor.height; }
    if (!rawW) RL.fail('CRW file without SensorInfo record is not supported');
    const base = rawRec ? rawRec.off - 26 : 0;
    const raw = new Uint16Array(rawW * rawH);
    const dec = RL.decodeCanonCrw(u8, base, raw, rawW, rawH, table, progress);
    res.raw = raw;
    res.width = rawW;
    res.height = rawH;
    res.cfa = CFA.RGGB;
    res.bits = dec.lowbits ? 12 : 10;
    res.info.push(['Compression', 'Canon CRW Huffman, decoder table ' + table + (dec.lowbits ? ', with low-order bits' : ', 10 bit (no low bits)')]);
    if (rawRec) res.info.push(['Raw data offset', rawRec.off + ', ' + rawRec.len + ' bytes']);
  }

  // ----------------------------------------------------------------- CR3
  function decodeCr3(u8, res, progress) {
    const c = RL.parseCr3(u8);
    res.format = 'CR3';
    const tiffAt = (box, name) => {
      if (!box) return null;
      const th = RL.tiffHeader(u8, box.offset);
      if (!th) return null;
      const ifd = RL.readIFD(th.r, box.offset, th.ifd0);
      return ifd;
    };
    const ifd0 = tiffAt(c.cmt.CMT1);
    const exif = tiffAt(c.cmt.CMT2);
    const mn = tiffAt(c.cmt.CMT3);
    const gps = tiffAt(c.cmt.CMT4);
    readExifFacts(res, ifd0, exif, gps);
    readCanonMakernote(res, mn);
    const ctmdGroups = [];
    for (const blk of c.ctmd) {
      const ifd = tiffAt(blk);
      if (!ifd) continue;
      readCanonMakernote(res, ifd);
      ctmdGroups.push({ name: 'CTMD record ' + blk.type, rows: RL.describeIFD(ifd, RL.TAGS.CANON, 'canon') });
    }
    for (const t of c.thumbs) addThumb(res, u8, t.label, t.offset, t.length, t.width, t.height);

    const t = c.rawTrack;
    if (!t) RL.fail('No supported CRX raw track found in this CR3 file');
    const hdr = t.hdr;
    const off = t.offsets[0], size = t.sampleSize;
    res.raw = RL.decodeCrx(u8, hdr, off, size, progress);
    res.width = hdr.f_width;
    res.height = hdr.f_height;
    res.cfa = [CFA.RGGB, CFA.GRBG, CFA.GBRG, CFA.BGGR][hdr.cfaLayout] || CFA.RGGB;
    res.bits = hdr.encType === 3 ? hdr.medianBits : hdr.nBits;
    res.info.push(['Compression', hdr.imageLevels ? `CRX wavelet (C-RAW), ${hdr.imageLevels} level(s)` : 'CRX lossless']);
    res.info.push(['CRX header', `version 0x${hdr.version.toString(16)}, ${hdr.nPlanes} planes, enc type ${hdr.encType}, ${hdr.nBits} bit`]);
    const tiles = Math.ceil(hdr.f_width / hdr.tileWidth) * Math.ceil(hdr.f_height / hdr.tileHeight);
    res.info.push(['Tiles', `${tiles} (${hdr.tileWidth} x ${hdr.tileHeight})`]);
    res.info.push(['Raw track', `#${t.index + 1}, offset ${off}, ${size} bytes`]);
    if (c.compressor) res.info.push(['Compressor', c.compressor]);
    exifGroups(res, ifd0, exif, gps, mn, [...ctmdGroups, {
      name: 'CR3 boxes',
      rows: c.boxes.map((b) => ({ id: '', name: b.path, type: 'box', count: b.size, value: 'offset ' + b.offset })),
    }]);
  }

  // ------------------------------------------------------------ finalize
  function chanHistStats(h, n) {
    if (!n) return null;
    let acc = 0, lo = -1, hi = -1, med = -1;
    const pl = n * 0.005, ph = n * 0.995, pm = n * 0.5;
    for (let v = 0; v < h.length; v++) {
      if (!h[v]) continue;
      acc += h[v];
      if (lo < 0 && acc > pl) lo = v;
      if (med < 0 && acc > pm) med = v;
      if (hi < 0 && acc >= ph) { hi = v; break; }
    }
    let s = 0, s2 = 0, m = 0;
    for (let v = lo; v <= hi; v++) { const k = h[v]; if (k) { s += k * v; s2 += k * v * v; m += k; } }
    const mean = s / m;
    return { mean, median: med, sd: Math.sqrt(Math.max(0, s2 / m - mean * mean)), n };
  }

  /**
   * Finds where the optically black border really ends. Between the masked
   * columns and the nominal image area Canon sensors have a strip of exposed
   * pixels, so walk 2x2 blocks away from the edge until the level changes.
   */
  function blackRun(blockMean, start, end) {
    start = (start + 1) & ~1;
    if (end - start < 12) return null;
    const b = [];
    for (let i = start; i + 2 <= end; i += 2) b.push(blockMean(i));
    const tolOf = (v) => Math.max(4, v * 0.006);
    // the black level is the densest cluster of block levels (borders can
    // also hold blanking columns near 0 or other dark-but-different columns)
    let ref = b[0], bestCount = -1;
    for (const v of b) {
      const t = tolOf(v);
      let n = 0;
      for (const w of b) if (Math.abs(w - v) <= t) n++;
      if (n > bestCount || (n === bestCount && v < ref)) { bestCount = n; ref = v; }
    }
    const tol = tolOf(ref);
    // longest run of 2-pixel blocks at that level
    let best = null, s = -1;
    for (let k = 0; k <= b.length; k++) {
      const ok = k < b.length && Math.abs(b[k] - ref) <= tol;
      if (ok && s < 0) s = k;
      if (!ok && s >= 0) {
        if (!best || k - s > best[1] - best[0]) best = [s, k];
        s = -1;
      }
    }
    if (!best || best[1] - best[0] < 4) return null;
    return { from: start + best[0] * 2 + 2, to: start + best[1] * 2 - 2, level: ref };
  }

  function measureMasked(res) {
    const { raw, width: W, active: A, cfa } = res;
    const rows = Math.max(1, A.bottom - A.top), cols = Math.max(1, A.right - A.left);
    const ys = Math.max(2, ((rows / 600) | 0) & ~1), xs = Math.max(2, ((cols / 600) | 0) & ~1);
    const colMean = (x) => {
      let s = 0, n = 0;
      for (let y = A.top & ~1; y + 1 < A.bottom; y += ys) {
        const o = y * W + x;
        s += raw[o] + raw[o + 1] + raw[o + W] + raw[o + W + 1];
        n += 4;
      }
      return s / n;
    };
    const rowMean = (y) => {
      let s = 0, n = 0;
      for (let x = A.left & ~1; x + 1 < A.right; x += xs) {
        const o = y * W + x;
        s += raw[o] + raw[o + 1] + raw[o + W] + raw[o + W + 1];
        n += 4;
      }
      return s / n;
    };
    // Canon puts the optically black strip on the left (or top); a few
    // PowerShots (Pro1) have it on the right. Use right/bottom only as fallback.
    const H = res.height;
    // an optically black strip is flat along its length; lit pixels follow the scene
    const flat = (r) => {
      if (!r || r.x1 - r.x0 < 2 || r.y1 - r.y0 < 2) return null;
      const vertical = r.y1 - r.y0 >= r.x1 - r.x0;
      const len = vertical ? r.y1 - r.y0 : r.x1 - r.x0;
      const segs = [];
      for (let k = 0; k < 16; k++) {
        const a = Math.floor((k * len) / 16), e = Math.floor(((k + 1) * len) / 16);
        let s = 0, n = 0;
        for (let i = a; i < e; i += 3) {
          if (vertical) { const o = (r.y0 + i) * W; for (let x = r.x0; x < r.x1; x++) { s += raw[o + x]; n++; } }
          else for (let y = r.y0; y < r.y1; y += 2) { s += raw[y * W + r.x0 + i]; n++; }
        }
        if (n) segs.push(s / n);
      }
      const mean = segs.reduce((p, q) => p + q, 0) / segs.length;
      return Math.max(...segs) - Math.min(...segs) <= Math.max(6, mean * 0.01) ? r : null;
    };
    // fixed preference (left like LibRaw and RawDigger, then top, right, bottom)
    const L = blackRun(colMean, 0, A.left);
    let rect = flat(L && { x0: L.from, x1: L.to, y0: A.top, y1: A.bottom });
    if (!rect) { const T = blackRun(rowMean, 0, A.top); rect = flat(T && { x0: A.left, x1: A.right, y0: T.from, y1: T.to }); }
    if (!rect) { const R = blackRun(colMean, A.right, W - 1); rect = flat(R && { x0: R.from, x1: R.to, y0: A.top, y1: A.bottom }); }
    if (!rect) { const B = blackRun(rowMean, A.bottom, H - 1); rect = flat(B && { x0: A.left, x1: A.right, y0: B.from, y1: B.to }); }
    if (!rect || rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return null;
    const hist = [new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536)];
    const cnt = [0, 0, 0, 0];
    for (let y = rect.y0; y < rect.y1; y++) {
      const row = y * W;
      const c0 = cfa[(y & 1) * 2], c1 = cfa[(y & 1) * 2 + 1];
      for (let x = rect.x0; x < rect.x1; x++) {
        const c = x & 1 ? c1 : c0;
        hist[c][raw[row + x]]++;
        cnt[c]++;
      }
    }
    return { rect, ch: hist.map((h, i) => chanHistStats(h, cnt[i])) };
  }

  /** Per channel histograms of the image area (borders can hold hot or odd pixels). */
  function channelHistograms(res) {
    const { raw, width: W, cfa } = res;
    const A = res.active;
    const hist = [new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536), new Uint32Array(65536)];
    const count = [0, 0, 0, 0];
    const x0 = A.left, x1 = A.right;
    for (let y = A.top; y < A.bottom; y++) {
      const he = hist[cfa[(y & 1) * 2 + (x0 & 1)]], ho = hist[cfa[(y & 1) * 2 + ((x0 + 1) & 1)]];
      const o = y * W;
      let x = x0;
      for (; x + 1 < x1; x += 2) { he[raw[o + x]]++; ho[raw[o + x + 1]]++; }
      if (x < x1) he[raw[o + x]]++;
    }
    for (let c = 0; c < 4; c++) for (let v = 0; v < 65536; v++) count[c] += hist[c][v];
    return { hist, count };
  }

  /** Returns the level where clipped pixels start piling up, or null. */
  function detectSaturation(h, n, bitMax) {
    let M = -1;
    for (let v = 65535; v >= 0; v--) if (h[v]) { M = v; break; }
    if (M < bitMax * 0.5) return null;
    const win = Math.max(2, Math.round(bitMax * 0.004));
    let C = 0, Cb = 0, peak = 0;
    for (let v = Math.max(0, M - win); v <= M; v++) { C += h[v]; peak = Math.max(peak, h[v]); }
    for (let v = Math.max(0, M - 2 * win); v < Math.max(0, M - win); v++) Cb += h[v];
    if (C < Math.max(16, n * 5e-6) || C < 4 * Cb) return null;
    for (let v = Math.max(0, M - win); v <= M; v++) if (h[v] >= peak * 0.15) return v;
    return M;
  }

  /**
   * Noise estimate without a masked border: in the darkest 1% of 2x2 blocks,
   * the difference of same-colour neighbours two pixels apart has a variance
   * of 2 sigma^2 (signal mostly cancels out).
   */
  function estimateNoise(res) {
    const { raw, width: W, active: A, cfa } = res;
    const x0 = (A.left + 1) & ~1, y0 = (A.top + 1) & ~1;
    const sums = new Uint32Array(262144);
    let n = 0;
    for (let y = y0; y + 1 < A.bottom; y += 4) {
      for (let x = x0; x + 1 < A.right; x += 2) {
        const o = y * W + x;
        sums[(raw[o] + raw[o + 1] + raw[o + W] + raw[o + W + 1]) >> 2]++;
        n++;
      }
    }
    let acc = 0, T = 0;
    for (; T < sums.length; T++) { acc += sums[T]; if (acc >= n * 0.01) break; }
    const pos = [0, 1, W, W + 1];
    const s2 = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
    let zeros = 0, total = 0;
    for (let y = y0; y + 1 < A.bottom; y += 2) {
      for (let x = x0; x + 3 < A.right; x += 2) {
        const o = y * W + x;
        if (((raw[o] + raw[o + 1] + raw[o + W] + raw[o + W + 1]) >> 2) > T) continue;
        const o2 = o + 2;
        if (((raw[o2] + raw[o2 + 1] + raw[o2 + W] + raw[o2 + W + 1]) >> 2) > T) continue;
        for (let p = 0; p < 4; p++) {
          const a = raw[o + pos[p]], b = raw[o2 + pos[p]];
          const c = cfa[p];
          s2[c] += (a - b) * (a - b);
          cnt[c]++;
          if (a === 0) zeros++;
          total++;
        }
      }
    }
    // values truncated at the black level (EOS-1D) make the estimate meaningless
    if (cnt.some((k) => k < 500) || zeros > total * 0.25) return null;
    return s2.map((s, c) => Math.sqrt(s / cnt[c] / 2));
  }

  /** Names the greens consistently: G sits in the red row, G2 in the blue row. */
  function normalizeGreens(cfa) {
    const redRow = cfa.indexOf(CH.R) < 2 ? 0 : 1;
    return cfa.map((c, i) => (c === CH.G || c === CH.G2 ? ((i >> 1) === redRow ? CH.G : CH.G2) : c));
  }

  function finalize(res) {
    const W = res.width, H = res.height;
    // CMYG sensors (PowerShot G1, Pro90 IS, 600, A50...): LibRaw lists a 4 colour
    // matrix for them. Channel slots 0..3 then stand for G, M, C, Y.
    const entry0 = RL.canonColorEntry(res.facts.model, res.facts.modelId);
    res.colors4 = !!(entry0 && entry0.matrix.length === 12);
    if (res.colors4) {
      res.channelNames = ['G', 'M', 'C', 'Y'];
      res.info.push(['Colour filters', 'CMYG (cyan, magenta, yellow, green) instead of RGB Bayer']);
    } else {
      res.channelNames = ['R', 'G', 'B', 'G2'];
      res.cfa = normalizeGreens(res.cfa);
    }
    const f = res.facts;
    if (f.make) f.make = String(f.make).trim();
    if (f.model) f.model = String(f.model).trim();

    // active (image) area
    const s = res.canon.sensor;
    let A = { left: 0, top: 0, right: W, bottom: H };
    if (s && s.right > s.left && s.bottom > s.top && s.right < W && s.bottom < H &&
      (!s.width || (s.width === W && s.height === H))) {
      A = { left: s.left, top: s.top, right: s.right + 1, bottom: s.bottom + 1 };
    }
    res.active = A;

    // levels
    const entry = RL.canonColorEntry(f.model, f.modelId);
    res.colorEntry = entry;
    if (entry && (entry.matrix.length === 9 || entry.matrix.length === 12)) res.colorMatrix = entry.matrix.map((v) => v / 10000);
    const bitMax = (1 << res.bits) - 1;
    res.masked = measureMasked(res);
    const cd = res.canon.colorData;
    const rggbToCh = (q) => [q[0], q[1], q[3], q[2]];
    let black = null, blackSource = '';
    const metaBlack = cd && cd.blackRGGB;
    // metadata black must agree with the masked border (the 1000D stores 1023 in
    // 14 bit units for 12 bit data; the 400D, 50D and 5D Mark III store per-channel
    // values a few DN off); otherwise trust the measurement. The border mean comes
    // from thousands of pixels, so the test uses its standard error, not the pixel σ
    // (at high ISO 3σ would let an 8 DN error through).
    const maskedOk = res.masked && res.masked.ch.every((c) => c);
    const agrees = (q) => !maskedOk || rggbToCh(q).every((b, c) => {
      const m = res.masked.ch[c];
      return Math.abs(b - m.mean) <= Math.max(1.5, 4 * m.sd / Math.sqrt(m.n));
    });
    if (metaBlack && Math.max(...metaBlack) < bitMax && agrees(metaBlack)) { black = rggbToCh(metaBlack); blackSource = 'camera metadata'; }
    else if (metaBlack && maskedOk && Math.max(...metaBlack) < bitMax) {
      black = res.masked.ch.map((c) => Math.round(c.mean));
      blackSource = 'masked pixels (camera metadata ' + metaBlack.join('/') + ' disagrees)';
    }
    else if (res.masked && res.masked.ch.every((c) => c)) { black = res.masked.ch.map((c) => Math.round(c.mean)); blackSource = 'masked pixels'; }
    else if (entry && entry.black) { black = [entry.black, entry.black, entry.black, entry.black]; blackSource = 'camera table'; }
    else { black = [0, 0, 0, 0]; blackSource = 'none (assumed 0)'; }
    res.black = black;
    res.blackSource = blackSource;

    // saturation: a pile-up of pixels at the top of a channel's histogram
    // means clipping. Newer bodies clip at one exact value, the D30/D60 era
    // sensors spread the clipped pixels over a few codes.
    const full = channelHistograms(res);
    let max = 0;
    for (const h of full.hist) for (let v = 65535; v > max; v--) if (h[v]) { max = v; break; }
    let atMax = 0;
    for (const h of full.hist) atMax += h[max];
    res.maxValue = max;
    res.maxCount = atMax;
    const sat = full.hist.map((h, c) => detectSaturation(h, full.count[c], bitMax));
    res.satDetected = sat;
    const detected = sat.filter((v) => v !== null);
    let white = bitMax, whiteSource = 'bit depth';
    if (detected.length) { white = Math.min(...detected); whiteSource = 'clipping detected in data'; }
    else if (entry && entry.white && entry.white <= bitMax) { white = entry.white; whiteSource = 'camera table'; }
    res.white = white;
    res.whiteSource = whiteSource;

    // noise floor: read noise from the masked border, or estimated from the
    // darkest flat parts of the image when the sensor has no masked area
    if (res.masked && res.masked.ch.every((c) => c && c.sd > 0)) {
      res.noise = { sigma: res.masked.ch.map((c) => c.sd), source: 'masked border (read noise)' };
    } else {
      const est = estimateNoise(res);
      res.noise = est ? { sigma: est, source: 'estimated from the darkest image areas' } : null;
    }
    if (cd && cd.specularWhite) res.info.push(['Canon white levels', `normal ${cd.normalWhite}, specular ${cd.specularWhite}`]);
    if (cd && cd.blackRGGB) res.info.push(['Canon black levels (RGGB)', cd.blackRGGB.join(', ')]);
    if (cd) res.info.push(['ColorData', `version ${cd.version}, ${cd.length} values`]);
    if (res.canon.blackRGGB) res.info.push(['ColorBalance black (raw order)', res.canon.blackRGGB.join(', ')]);

    if (!res.wbAsShot && cd && cd.asShotRGGB && cd.asShotRGGB[0]) res.wbAsShot = rggbToCh(cd.asShotRGGB);

    // summary
    const cs = res.canon.cs || {};
    const si = res.canon.si || {};
    const sum = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '') sum.push([k, String(v)]); };
    add('Camera', [f.make && !String(f.model || '').startsWith(f.make) ? f.make : '', f.model].filter(Boolean).join(' '));
    const lr = RL.canonLens(cs.lensType, cs.shortFocal, cs.longFocal, cs.maxApertureValue);
    res.lens = lr;
    const optics = (cs.focalRange || '') + (cs.maxAperture ? ' ' + cs.maxAperture : '');
    let lensText = f.lens;
    if (!lensText) {
      if (lr.source === 'id' || lr.source === 'lowbyte') lensText = lr.name;
      else if (lr.source === 'optics' && /PowerShot|IXUS|IXY/i.test(f.model || '')) lensText = 'Built-in ' + optics + ' zoom';
      else if (lr.source === 'optics') lensText = optics + (lr.candidates.length ? ' lens, likely ' + lr.candidates.slice(0, 3).join(' or ') : ' lens');
      else lensText = optics || (res.canon.cs && !cs.lensType ? 'No lens data recorded (non-electronic or adapted lens)' : '');
    }
    add('Lens', lensText);
    if (lr.id > 0 && lr.id !== 0xffff) {
      let idText = String(lr.id);
      if (lr.source === 'lowbyte') idText += ' = low byte of ' + lr.fullIds.map((i) => `${i} (0x${i.toString(16).toUpperCase()})`).join(' / ') +
        '. This body records only the lower 8 bits of the lens ID; identified by matching the recorded focal range and aperture';
      else if (lr.source === 'optics') idText += lr.idName ? ` (ExifTool lists "${lr.idName}", which does not match the recorded ${optics}; older bodies use a different numbering)` : ' (unknown ID, lens guessed from focal range and aperture)';
      else if (f.lens && lr.name && lr.name !== f.lens) idText += ' (' + lr.name + ')';
      add('Lens ID', idText);
    }
    if (lr.source === 'optics' && lr.candidates.length > 3) add('Other candidates', lr.candidates.slice(3, 10).join(', '));
    add('Date', f.date ? f.date + (f.subsec ? '.' + f.subsec : '') : '');
    add('Shutter', f.exposureTime ? RL.fmtShutter(f.exposureTime) : '');
    add('Aperture', f.fnumber ? 'f/' + RL.fmtNum(f.fnumber, 1) : '');
    add('ISO', f.iso ? f.iso + (si.realISO && Math.abs(si.realISO - f.iso) > 1 ? ' (actual ' + si.realISO + ')' : '') : (si.realISO || ''));
    add('Exposure comp.', f.ec !== undefined ? (f.ec > 0 ? '+' : '') + RL.fmtNum(f.ec, 2) + ' EV' : '');
    // scene brightness: the camera's meter reading (Canon MeasuredEV, a light value)
    // or EXIF BrightnessValue, next to the light value the exposure settings imply
    const iso = f.iso || si.realISO;
    const lvSet = f.fnumber && f.exposureTime && iso ? Math.log2(f.fnumber * f.fnumber / f.exposureTime * 100 / iso) : null;
    let lvMeas = null, lvSrc = '';
    if (si.measuredEV !== undefined) { lvMeas = si.measuredEV; lvSrc = 'camera meter (Canon MeasuredEV)'; }
    else if (typeof f.brightnessValue === 'number' && isFinite(f.brightnessValue)) { lvMeas = f.brightnessValue + 5; lvSrc = 'EXIF BrightnessValue + 5'; }
    if (lvMeas !== null || lvSet !== null) {
      const b = { measured: lvMeas, source: lvSrc, settings: lvSet, measured2: si.measuredEV2 };
      const parts = [];
      if (lvMeas !== null) {
        parts.push(`LV ${lvMeas.toFixed(1)} measured, ${RL.describeLV(lvMeas)}`);
        if (/PowerShot|IXUS|IXY/i.test(f.model || '') && lvSrc.startsWith('camera')) parts.push('PowerShot meters may read up to 1 EV low');
      }
      if (lvSet !== null) parts.push(`exposure set for LV ${lvSet.toFixed(1)}` + (lvMeas === null ? ' (' + RL.describeLV(lvSet) + ')' : ''));
      if (lvMeas !== null && lvSet !== null) {
        // with exposure compensation the camera aims at LV(meter) - EC
        const dev = lvSet - (lvMeas - (f.ec || 0));
        b.deviation = dev;
        if (Math.abs(dev) >= 1) parts.push(`${Math.abs(dev).toFixed(1)} EV ${dev > 0 ? 'less' : 'more'} exposure than the meter suggested (manual exposure, flash or a locked reading)`);
      }
      b.text = parts.join('; ');
      res.scene = b;
      add('Scene brightness', b.text);
    }
    if (si.temperature !== undefined && /EOS/.test(f.model || '') && !/EOS-1DS?$/i.test(f.model || '')) {
      res.cameraTemp = si.temperature;
      add('Camera temperature', si.temperature + ' °C');
    }
    const sc = RL.canonShutterCount(f.model, res.format, res.canon.fileInfo, res.canon.cameraInfo);
    // the raw entries reference the whole file buffer: do not send them back from the worker
    delete res.canon.fileInfo;
    delete res.canon.cameraInfo;
    if (sc) {
      res.shutterCount = sc;
      add('Shutter count', sc.value ? sc.value.toLocaleString('en-US') + (sc.note ? ' (' + sc.note + ')' : '') : 'not available: ' + sc.note);
    }
    add('Focal length', f.focal ? RL.fmtNum(f.focal, 1) + ' mm' + (f.focal35 ? ' (' + f.focal35 + ' mm in 35mm)' : '') : '');
    add('Mode', cs.exposureMode || '');
    add('Metering', cs.metering || '');
    add('Focus', cs.focusMode || '');
    add('Flash', f.flash || '');
    add('White balance', si.wbIndex !== undefined ? (RL.CANON_WB[si.wbIndex] || 'index ' + si.wbIndex) : '');
    add('Quality', cs.quality || '');
    add('Serial number', f.serial || f.internalSerial || '');
    add('Owner', f.owner || '');
    add('Artist', f.artist || '');
    add('Copyright', f.copyright || '');
    add('Firmware', f.firmware || '');
    add('GPS', f.gps || '');
    res.summary = sum;
  }

  // ---------------------------------------------------------------- entry
  RL.decode = function (buffer, fileName, progress) {
    const u8 = new Uint8Array(buffer);
    const res = {
      fileName, fileSize: u8.length, format: '', facts: {}, canon: {}, thumbs: [], groups: [], info: [],
      raw: null, width: 0, height: 0, cfa: CFA.RGGB, bits: 12, wbAsShot: null,
    };
    const P = progress || (() => {});
    const t0 = Date.now();
    if (u8.length > 14 && String.fromCharCode(...u8.subarray(6, 14)) === 'HEAPCCDR') decodeCrw(u8, res, P);
    else if (RL.isCr3(u8)) decodeCr3(u8, res, P);
    else if (RL.tiffHeader(u8, 0)) decodeTiffRaw(u8, res, P);
    else RL.fail('Unrecognized file. Supported: Canon CRW, CR2, CR3 and EOS-1D/1Ds TIF raw files.');
    res.decodeMs = Date.now() - t0;
    finalize(res);
    return res;
  };
});
