/*
 * Lossless JPEG (ITU T.81 process 14, "LJ92") decoder as used by Canon CR2
 * and the EOS-1D / 1Ds TIF raw files, including Canon's CR2 slice layout.
 *
 * Ported from dcraw / LibRaw (ljpeg_start, ljpeg_row, lossless_jpeg_load_raw).
 * dcraw (c) Dave Coffin, LibRaw (c) LibRaw LLC - LGPL 2.1 / CDDL 1.0.
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  /** Builds a dcraw-style lookup table: entry = (codeLength << 8) | value. */
  function makeDecoder(u8, p) {
    let max = 16;
    while (max && !u8[p + max - 1]) max--;
    const size = 1 << max;
    const table = new Uint16Array(size);
    let h = 0, q = p + 16;
    for (let len = 1; len <= max; len++) {
      const cnt = u8[p + len - 1];
      for (let i = 0; i < cnt; i++, q++) {
        const span = 1 << (max - len);
        for (let j = 0; j < span; j++) if (h < size) table[h++] = (len << 8) | u8[q];
      }
    }
    return { max, table, next: q };
  }
  RL.makeHuffDecoder = makeDecoder;

  /** Parses the JPEG headers. Returns null if this is not a usable stream. */
  function ljpegStart(u8, offset, infoOnly) {
    const jh = {
      bits: 0, high: 0, wide: 0, clrs: 0, psv: 0, sraw: 0, algo: 0,
      restart: Infinity, huff: new Array(20).fill(null), dataStart: 0,
    };
    let pos = offset;
    if (u8[pos] !== 0xff || u8[pos + 1] !== 0xd8) return null;
    pos += 2;
    let tag = 0, cnt = 0;
    do {
      if (pos + 4 > u8.length || cnt++ > 1024) return null;
      tag = (u8[pos] << 8) | u8[pos + 1];
      const len = ((u8[pos + 2] << 8) | u8[pos + 3]) - 2;
      pos += 4;
      if (tag <= 0xff00 || len < 0 || pos + len > u8.length) return null;
      const d = pos;
      pos += len;
      switch (tag) {
        case 0xffc3: // SOF3 lossless, Huffman
          jh.sraw = (((u8[d + 7] >> 4) * (u8[d + 7] & 15) - 1) & 3);
        // falls through
        case 0xffc1:
        case 0xffc0:
          jh.algo = tag & 0xff;
          jh.bits = u8[d];
          jh.high = (u8[d + 1] << 8) | u8[d + 2];
          jh.wide = (u8[d + 3] << 8) | u8[d + 4];
          jh.clrs = u8[d + 5] + jh.sraw;
          if (len === 9) pos++; // dcraw quirk for single component frames
          break;
        case 0xffc4: { // DHT
          if (infoOnly) break;
          let dp = d;
          while (dp < d + len) {
            const c = u8[dp++];
            if (c & -20) break;
            const dec = makeDecoder(u8, dp);
            jh.huff[c] = dec;
            dp = dec.next;
          }
          break;
        }
        case 0xffda: // SOS
          jh.psv = u8[d + 1 + u8[d] * 2];
          jh.bits -= u8[d + 3 + u8[d] * 2] & 15;
          break;
        case 0xffdd:
          jh.restart = (u8[d] << 8) | u8[d + 1];
          break;
      }
    } while (tag !== 0xffda);
    if (jh.bits > 16 || jh.clrs > 6 || !jh.bits || !jh.high || !jh.wide || !jh.clrs) return null;
    jh.dataStart = pos;
    if (infoOnly) return jh;
    if (!jh.huff[0]) return null;
    for (let c = 0; c < 19; c++) if (!jh.huff[c + 1]) jh.huff[c + 1] = jh.huff[c];
    if (jh.sraw) {
      for (let c = 0; c < 4; c++) jh.huff[2 + c] = jh.huff[1];
      for (let c = 0; c < jh.sraw; c++) jh.huff[1 + c] = jh.huff[0];
    }
    return jh;
  }
  RL.ljpegInfo = (u8, offset) => ljpegStart(u8, offset, true);

  /**
   * Decodes the stream at `offset` into `raw` (Uint16Array, rawW x rawH).
   * slices = [count, width, lastWidth] from CR2 tag 0xC640, or null.
   */
  RL.decodeLJ92 = function (u8, offset, raw, rawW, rawH, slices, progress) {
    const jh = ljpegStart(u8, offset, false);
    if (!jh) RL.fail('Invalid lossless JPEG stream');
    if (jh.sraw) RL.fail('Canon sRAW/mRAW files contain YCbCr data, not raw sensor data, and are not supported');

    const end = u8.length;
    let pos = jh.dataStart;
    // bit reader state (dcraw getbithuff with zero_after_ff = 1)
    let bitbuf = 0, vbits = 0, reset = 0;

    function getbits(nbits) {
      if (nbits === 0 || vbits < 0) return 0;
      while (!reset && vbits < nbits) {
        if (pos >= end) break;
        const c = u8[pos++];
        if (c === 0xff) {
          const c2 = pos < end ? u8[pos++] : 0;
          if (c2) { reset = 1; break; }
        }
        bitbuf = (bitbuf << 8) | c;
        vbits += 8;
      }
      const v = vbits === 0 ? 0 : ((bitbuf << (32 - vbits)) >>> (32 - nbits));
      vbits -= nbits;
      return v;
    }
    function gethuff(h) {
      const nbits = h.max;
      if (nbits === 0 || vbits < 0) return 0;
      while (!reset && vbits < nbits) {
        if (pos >= end) break;
        const c = u8[pos++];
        if (c === 0xff) {
          const c2 = pos < end ? u8[pos++] : 0;
          if (c2) { reset = 1; break; }
        }
        bitbuf = (bitbuf << 8) | c;
        vbits += 8;
      }
      const idx = vbits === 0 ? 0 : ((bitbuf << (32 - vbits)) >>> (32 - nbits));
      const e = h.table[idx];
      vbits -= e >> 8;
      return e & 0xff;
    }
    function diffOf(h) {
      const len = gethuff(h);
      if (len === 16) return -32768;
      let diff = getbits(len);
      if (len && (diff & (1 << (len - 1))) === 0) diff -= (1 << len) - 1;
      return diff;
    }

    const clrs = jh.clrs, wide = jh.wide, high = jh.high, psv = jh.psv;
    const W = wide * clrs;
    const rowBuf = new Uint16Array(W * 2);
    const vpred = new Int32Array(6);
    const huff = jh.huff;
    const jwide = W;

    const s0 = slices && slices[0] ? slices[0] : 0;
    const s1 = slices ? slices[1] : 0;
    const s2 = slices ? slices[2] : 0;
    if (s0 && !s1) RL.fail('Corrupt CR2 slice information');
    const sliceArea = s1 * rawH;

    let row = 0, col = 0;
    const tick = Math.max(1, (high / 20) | 0);

    for (let jrow = 0; jrow < high; jrow++) {
      // restart interval handling
      if (jh.restart !== 0 && (jrow * wide) % jh.restart === 0) {
        for (let c = 0; c < 6; c++) vpred[c] = 1 << (jh.bits - 1);
        if (jrow) {
          pos -= 2;
          let mark = 0, c;
          do {
            c = pos < end ? u8[pos++] : -1;
            mark = ((mark << 8) + c) & 0xffff;
          } while (c !== -1 && (mark >> 4) !== 0xffd);
        }
        bitbuf = 0; vbits = 0; reset = 0;
      }
      let r0 = (jrow & 1) * W;
      let r1 = ((jrow + 1) & 1) * W;
      const rowStart = r0;
      for (let cc = 0; cc < wide; cc++) {
        for (let c = 0; c < clrs; c++) {
          const diff = diffOf(huff[c]);
          let pred;
          if (cc) pred = rowBuf[r0 - clrs];
          else { pred = vpred[c]; vpred[c] += diff; }
          if (jrow && cc) {
            switch (psv) {
              case 1: break;
              case 2: pred = rowBuf[r1]; break;
              case 3: pred = rowBuf[r1 - clrs]; break;
              case 4: pred = pred + rowBuf[r1] - rowBuf[r1 - clrs]; break;
              case 5: pred = pred + ((rowBuf[r1] - rowBuf[r1 - clrs]) >> 1); break;
              case 6: pred = rowBuf[r1] + ((pred - rowBuf[r1 - clrs]) >> 1); break;
              case 7: pred = (pred + rowBuf[r1]) >> 1; break;
              default: pred = 0;
            }
          }
          rowBuf[r0] = pred + diff;
          r0++; r1++;
        }
      }

      // place the decoded row into the raw image (lossless_jpeg_load_raw)
      let rp = rowStart;
      for (let jcol = 0; jcol < jwide; jcol++) {
        const val = rowBuf[rp++];
        if (s0) {
          let jidx = jrow * jwide + jcol;
          let i = (jidx / sliceArea) | 0;
          let j = 0;
          if (i >= s0) { j = 1; i = s0; }
          const sw = j ? s2 : s1;
          if (!sw) RL.fail('Corrupt CR2 slice information');
          jidx -= i * sliceArea;
          row = (jidx / sw) | 0;
          col = (jidx % sw) + i * s1;
        }
        if (rawW === 3984 && (col -= 2) < 0) { row--; col += rawW; }
        if (row > rawH) RL.fail('Lossless JPEG data overflows the raw frame');
        if (row >= 0 && row < rawH && col >= 0 && col < rawW) raw[row * rawW + col] = val;
        if (++col >= rawW) { col = 0; row++; }
      }
      if (progress && jrow % tick === 0) progress(jrow / high);
    }
    return jh;
  };
});
