/*
 * DNG writer: the undemosaiced raw frame as a DNG 1.4 file that raw converters
 * (Lightroom, Camera Raw, darktable, RawTherapee, LibRaw) open directly.
 *
 * IFD0 holds a small sRGB preview and the DNG colour tags (camera colour matrix
 * for D65, as-shot neutral, unique camera model); its SubIFD holds the full raw
 * frame, 16 bit uncompressed, with the CFA pattern, black and white levels, the
 * image area (ActiveArea) and the masked border areas.
 */
(function () {
  'use strict';

  // XYZ -> sRGB, used as the camera matrix when the camera has none (raw = sRGB)
  const XYZ_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252];
  const srat = (v) => [Math.round(v * 10000), 10000];
  const urat = (v) => [Math.round(v * 1e6), 1e6];

  /** Small sRGB preview (long side 256 px), averaged from the raw data. */
  function preview(img, levels, wb, M, exposure) {
    const A = img.active, aw = A.right - A.left, ah = A.bottom - A.top;
    const s = 256 / Math.max(aw, ah);
    const tw = Math.max(1, Math.round(aw * s)), th = Math.max(1, Math.round(ah * s));
    const cell = Math.max(2, Math.floor(1 / s));
    const nc = img.colors4 ? 4 : 3;
    const g = Math.pow(2, exposure);
    const k = [0, 1, 2, 3].map((c) => (g * (nc === 3 && c === 3 ? wb[1] : wb[c])) / Math.max(1, levels.white - levels.black[c]));
    const hi = g * Math.min(...wb.slice(0, nc));
    const enc = (v) => { v = v <= 0 ? 0 : v >= 1 ? 1 : v; return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
    const out = new Uint8Array(tw * th * 3);
    const { raw, width: W, cfa } = img;
    const step = Math.max(1, Math.floor(cell / 8)) * 2; // sample at most ~4x4 blocks per preview pixel
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const x0 = A.left + Math.floor(tx / s), y0 = A.top + Math.floor(ty / s);
        const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
        for (let y = y0; y < Math.min(A.bottom, y0 + cell); y += step) {
          for (let x = x0; x < Math.min(A.right, x0 + cell); x += step) {
            for (let p = 0; p < 4; p++) {
              const yy = y + (p >> 1), xx = x + (p & 1);
              if (yy >= A.bottom || xx >= A.right) continue;
              const c = cfa[(yy & 1) * 2 + (xx & 1)];
              sum[c] += raw[yy * W + xx]; n[c]++;
            }
          }
        }
        const q = [0, 1, 2, 3].map((c) => (n[c] ? Math.min(hi, (sum[c] / n[c] - levels.black[c]) * k[c]) : 0));
        let r, gg, b;
        if (nc === 4) {
          r = M[0][0] * q[0] + M[0][1] * q[1] + M[0][2] * q[2] + M[0][3] * q[3];
          gg = M[1][0] * q[0] + M[1][1] * q[1] + M[1][2] * q[2] + M[1][3] * q[3];
          b = M[2][0] * q[0] + M[2][1] * q[1] + M[2][2] * q[2] + M[2][3] * q[3];
        } else {
          const G = n[3] ? (q[1] + q[3]) / 2 : q[1];
          r = M[0][0] * q[0] + M[0][1] * G + M[0][2] * q[2];
          gg = M[1][0] * q[0] + M[1][1] * G + M[1][2] * q[2];
          b = M[2][0] * q[0] + M[2][1] * G + M[2][2] * q[2];
        }
        const o = (ty * tw + tx) * 3;
        out[o] = enc(r); out[o + 1] = enc(gg); out[o + 2] = enc(b);
      }
    }
    return { data: out, w: tw, h: th };
  }

  /**
   * o: { img, levels, wb (current multipliers), matrix (camera -> sRGB, for the
   *      preview), exposure, orient, meta: { ifd0, exif } }
   * Returns Blob parts.
   */
  function build(o) {
    const { img, levels, wb } = o;
    const A = img.active, W = img.width, H = img.height;
    const nc = img.colors4 ? 4 : 3;
    // CFA pattern and black levels at the image-area origin, as DNG plane indices
    const pos = [0, 1, 2, 3].map((p) => img.cfa[((A.top + (p >> 1)) & 1) * 2 + ((A.left + (p & 1)) & 1)]);
    const plane = pos.map((c) => (nc === 3 && c === 3 ? 1 : c));
    const black = pos.map((c) => Math.round(levels.black[c]));
    const cm = img.colorMatrix && img.colorMatrix.length === nc * 3 ? img.colorMatrix : nc === 3 ? XYZ_SRGB : null;
    if (nc === 4) throw new Error('DNG is not written for 4-colour (CMYG) sensors: DNG readers do not handle their colour filters reliably. Export a TIFF instead.');
    const mult = nc === 4 ? wb.slice(0, 4) : [wb[0], wb[1], wb[2]];
    const inv = mult.map((m) => 1 / Math.max(1e-6, m));
    const mx = Math.max(...inv);
    const neutral = inv.map((v) => v / mx);
    const model = [img.facts.make, img.facts.model].filter(Boolean).join(' ').replace(/^(Canon) Canon /, '$1 ') || 'Canon camera';
    const masked = img.masked && img.masked.rects ? Object.values(img.masked.rects).flatMap((r) => [r.y0, r.x0, r.y1, r.x1]) : [];

    const rawData = new Uint8Array(img.raw.buffer, img.raw.byteOffset, W * H * 2);
    const rawIfd = { entries: [
      { tag: 254, type: 4, value: 0 },
      { tag: 256, type: 4, value: W }, { tag: 257, type: 4, value: H },
      { tag: 258, type: 3, value: 16 }, { tag: 259, type: 3, value: 1 }, { tag: 262, type: 3, value: 32803 },
      { tag: 273, type: 4, blocks: [rawData] }, { tag: 277, type: 3, value: 1 },
      { tag: 278, type: 4, value: H }, { tag: 279, type: 4, value: rawData.byteLength }, { tag: 284, type: 3, value: 1 },
      { tag: 33421, type: 3, value: [2, 2] }, { tag: 33422, type: 1, value: plane },
      { tag: 50710, type: 1, value: nc === 4 ? [1, 4, 3, 5] : [0, 1, 2] }, { tag: 50711, type: 3, value: 1 },
      { tag: 50713, type: 3, value: [2, 2] }, { tag: 50714, type: 4, value: black },
      { tag: 50717, type: 4, value: Math.round(levels.white) },
      { tag: 50718, type: 5, value: [[1, 1], [1, 1]] },
      { tag: 50719, type: 4, value: [0, 0] }, { tag: 50720, type: 4, value: [A.right - A.left, A.bottom - A.top] },
      { tag: 50829, type: 4, value: [A.top, A.left, A.bottom, A.right] },
      masked.length && { tag: 50830, type: 4, value: masked },
    ] };
    const pv = preview(img, levels, wb, o.matrix, o.exposure || 0);
    const exif = { entries: o.meta.exif.filter((e) => e && e.tag !== 40961) };
    const ifd0 = { entries: [
      { tag: 254, type: 4, value: 1 },
      { tag: 256, type: 4, value: pv.w }, { tag: 257, type: 4, value: pv.h },
      { tag: 258, type: 3, value: [8, 8, 8] }, { tag: 259, type: 3, value: 1 }, { tag: 262, type: 3, value: 2 },
      { tag: 273, type: 4, blocks: [pv.data] }, { tag: 274, type: 3, value: o.orient || 1 }, { tag: 277, type: 3, value: 3 },
      { tag: 278, type: 4, value: pv.h }, { tag: 279, type: 4, value: pv.data.length }, { tag: 284, type: 3, value: 1 },
      { tag: 330, type: 4, ifds: [rawIfd] }, { tag: 34665, type: 4, ifds: [exif] },
      { tag: 50706, type: 1, value: [1, 4, 0, 0] }, { tag: 50707, type: 1, value: [1, 1, 0, 0] },
      { tag: 50708, type: 2, value: model },
      { tag: 50721, type: 10, value: cm.map(srat) },
      { tag: 50728, type: 5, value: neutral.map(urat) },
      { tag: 50778, type: 3, value: 21 }, // CalibrationIlluminant1: D65
      ...o.meta.ifd0,
    ] };
    return TiffWriter.build([ifd0, rawIfd, exif]).parts;
  }

  window.Dng = { build };
})();
