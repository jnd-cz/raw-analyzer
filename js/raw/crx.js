/*
 * Canon CRX (CR3) raw decoder, lossless and C-RAW (wavelet) variants.
 *
 * Ported from LibRaw src/decoders/crx.cpp:
 *   Copyright (C) 2018-2019 Alexey Danilchenko
 *   Copyright (C) 2019 Alex Tutubalin, LibRaw LLC
 *   LGPL 2.1 / CDDL 1.0
 *
 * Pointers of the C code are expressed as (typed array, index) pairs. Buffers
 * that LibRaw allocates contiguously are kept contiguous here as well, so any
 * edge reads behave the same way.
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  const E_HAS_TILES_ON_THE_RIGHT = 1;
  const E_HAS_TILES_ON_THE_LEFT = 2;
  const E_HAS_TILES_ON_THE_BOTTOM = 4;
  const E_HAS_TILES_ON_THE_TOP = 8;

  const exCoefNumTbl = [
    1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0,
    0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0,
    0, 0, 1, 2, 2, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 2, 2,
    1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 1, 1, 1,
    1, 2, 2, 1, 1, 1, 1, 2, 2, 1, 1, 0, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const q_step_tbl = [0x28, 0x2D, 0x33, 0x39, 0x40, 0x48, 0, 0];
  const JS = [1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 8, 8, 8, 8, 0x10, 0x10, 0x20, 0x20, 0x40, 0x40,
    0x80, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000];
  const J = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 5, 5, 6, 6, 7, 7, 8, 9, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F];

  const fail = () => { throw new RL.RawError('CR3 (CRX) data is corrupt or uses an unsupported variant'); };
  const abs32 = (x) => { x |= 0; const m = x >> 31; return ((x ^ m) - m) | 0; };
  const constrain = (x, l, u) => (x < l ? l : (x > u ? u : x));
  const idiv = (a, b) => (a / b) | 0; // C integer division (truncation)

  // ------------------------------------------------------------ bitstream
  function bsInit(u8, off, size) {
    if (off < 0 || off >= u8.length) fail();
    return { u8, pos: off, end: Math.min(off + size, u8.length), bitData: 0, bitsLeft: 0 };
  }

  function getZeros(bs) {
    let result = 0;
    if (bs.bitData) {
      const nz = 31 - Math.clz32(bs.bitData);
      result = 31 - nz;
      bs.bitData = (bs.bitData << (32 - nz)) >>> 0;
      bs.bitsLeft -= 32 - nz;
    } else {
      let bitsLeft = bs.bitsLeft;
      const u8 = bs.u8;
      let next = 0;
      for (;;) {
        while (bs.pos + 4 <= bs.end) {
          const p = bs.pos;
          next = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
          bs.pos = p + 4;
          if (next) {
            const nz = 31 - Math.clz32(next);
            result = bitsLeft + 31 - nz;
            bs.bitData = nz === 0 ? 0 : (next << (32 - nz)) >>> 0;
            bs.bitsLeft = nz;
            return result;
          }
          bitsLeft += 32;
        }
        if (bs.end < bs.pos + 1) break;
        next = u8[bs.pos++];
        if (next) break;
        bitsLeft += 8;
      }
      const nz = next ? 31 - Math.clz32(next) : 0;
      result = bitsLeft + 7 - nz;
      bs.bitData = nz === 0 ? 0 : (next << (32 - nz)) >>> 0;
      bs.bitsLeft = nz;
    }
    return result;
  }

  function getBits(bs, bits) {
    let bitsLeft = bs.bitsLeft;
    let bitData = bs.bitData;
    if (bitsLeft < bits) {
      const u8 = bs.u8;
      if (bs.pos + 4 <= bs.end) {
        const p = bs.pos;
        const nextWord = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
        bs.pos = p + 4;
        bs.bitsLeft = 32 - (bits - bitsLeft);
        const result = (((nextWord >>> bitsLeft) | bitData) >>> 0) >>> (32 - bits);
        bs.bitData = (nextWord << (bits - bitsLeft)) >>> 0;
        return result;
      }
      do {
        if (bs.pos >= bs.end) break;
        bitsLeft += 8;
        const nextByte = u8[bs.pos++];
        bitData = (bitData | (nextByte << (32 - bitsLeft))) >>> 0;
      } while (bitsLeft < bits);
    }
    const result = bitData >>> (32 - bits);
    bs.bitData = bits >= 32 ? 0 : (bitData << bits) >>> 0;
    bs.bitsLeft = bitsLeft - bits;
    return result;
  }

  function readCode(bs, kParam) {
    let bitCode = getZeros(bs);
    if (bitCode >= 41) bitCode = getBits(bs, 21);
    else if (kParam) bitCode = (getBits(bs, kParam) | (bitCode << kParam)) >>> 0;
    return bitCode;
  }

  function predictK(prevK, bitCode, maxVal) {
    const newK = prevK - (bitCode < ((1 << prevK) >> 1) ? 1 : 0) +
      ((bitCode >> prevK) > 2 ? 1 : 0) + ((bitCode >> prevK) > 5 ? 1 : 0);
    return !maxVal || newK < maxVal ? newK : maxVal;
  }

  function readRunLength(p, length) {
    // shared "nSyms" run decoding; returns -1 on error
    let nSyms = 1;
    while (getBits(p.bs, 1)) {
      nSyms += JS[p.sParam];
      if (nSyms > length) { nSyms = length; break; }
      if (p.sParam < 31) ++p.sParam;
      if (nSyms === length) break;
    }
    if (nSyms < length) {
      if (J[p.sParam]) nSyms += getBits(p.bs, J[p.sParam]);
      if (p.sParam > 0) --p.sParam;
      if (nSyms > length) return -1;
    }
    return nSyms;
  }

  // ------------------------------------------------------- line decoders
  function decodeSymbolL1(p, doMedianPrediction, notEOL) {
    const P = p.P;
    if (doMedianPrediction) {
      const a0 = P[p.l0], a1 = P[p.l0 + 1], b0 = P[p.l1];
      const delta = (a1 - a0) | 0;
      const idx = (((a0 < b0) ^ (delta < 0)) << 1) + ((b0 < a1) ^ (delta < 0));
      P[p.l1 + 1] = idx < 2 ? delta + b0 : (idx === 2 ? b0 : a1);
    } else {
      P[p.l1 + 1] = P[p.l0 + 1];
    }
    let bitCode = readCode(p.bs, p.kParam);
    P[p.l1 + 1] += (-(bitCode & 1)) ^ (bitCode >>> 1);
    if (notEOL) {
      const nextDelta = ((P[p.l0 + 2] - P[p.l0 + 1]) << 1) | 0;
      bitCode = ((bitCode + abs32(nextDelta)) >>> 0) >>> 1;
      ++p.l0;
    }
    p.kParam = predictK(p.kParam, bitCode, 15);
    ++p.l1;
  }

  function decodeLineL1(p) {
    const P = p.P;
    let length = p.w;
    P[p.l1] = P[p.l0 + 1];
    for (; length > 1; --length) {
      if (P[p.l1] !== P[p.l0 + 1] || P[p.l1] !== P[p.l0 + 2]) {
        decodeSymbolL1(p, 1, 1);
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = readRunLength(p, length);
          if (nSyms < 0) return -1;
          length -= nSyms;
          p.l0 += nSyms;
          while (nSyms-- > 0) { P[p.l1 + 1] = P[p.l1]; ++p.l1; }
        }
        if (length > 0) decodeSymbolL1(p, 0, length > 1 ? 1 : 0);
      }
    }
    if (length === 1) decodeSymbolL1(p, 1, 0);
    P[p.l1 + 1] = P[p.l1] + 1;
    return 0;
  }

  function decodeSymbolL1Rounded(p, doSym, doCode) {
    const P = p.P;
    let sym = P[p.l0 + 1];
    if (doSym) {
      const a0 = P[p.l0], a1 = P[p.l0 + 1], b0 = P[p.l1];
      const deltaH = (a1 - a0) | 0;
      const idx = (((a0 < b0) ^ (deltaH < 0)) << 1) + ((b0 < a1) ^ (deltaH < 0));
      sym = idx < 2 ? deltaH + b0 : (idx === 2 ? b0 : a1);
    }
    const bitCode = readCode(p.bs, p.kParam);
    let code = (-(bitCode & 1)) ^ (bitCode >>> 1);
    P[p.l1 + 1] = Math.imul(p.rbm * 2, code) + (code >> 31) + sym;
    if (doCode) {
      if (P[p.l0 + 2] > P[p.l0 + 1])
        code = (P[p.l0 + 2] - P[p.l0 + 1] + p.rbm - 1) >> p.roundedBits;
      else
        code = -((P[p.l0 + 1] - P[p.l0 + 2] + p.rbm) >> p.roundedBits);
      p.kParam = predictK(p.kParam, ((bitCode + 2 * abs32(code)) >>> 0) >>> 1, 15);
    } else {
      p.kParam = predictK(p.kParam, bitCode, 15);
    }
    ++p.l1;
  }

  function decodeLineRounded(p) {
    const P = p.P;
    let valueReached = 0;
    P[p.l0] = P[p.l0 + 1];
    P[p.l1] = P[p.l0 + 1];
    let length = p.w;
    for (; length > 1; --length) {
      if (abs32(P[p.l0 + 2] - P[p.l0 + 1]) > p.rbm) {
        decodeSymbolL1Rounded(p, 1, 1);
        ++p.l0;
        valueReached = 1;
      } else if (valueReached || abs32(P[p.l0] - P[p.l1]) > p.rbm) {
        decodeSymbolL1Rounded(p, 1, 1);
        ++p.l0;
        valueReached = 0;
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = 1;
          while (getBits(p.bs, 1)) {
            nSyms += JS[p.sParam];
            if (nSyms > length) { nSyms = length; break; }
            if (p.sParam < 31) ++p.sParam;
            if (nSyms === length) break;
          }
          if (nSyms < length) {
            if (J[p.sParam]) nSyms += getBits(p.bs, J[p.sParam]);
            if (p.sParam > 0) --p.sParam;
          }
          if (nSyms > length) return -1;
        }
        length -= nSyms;
        p.l0 += nSyms;
        while (nSyms-- > 0) { P[p.l1 + 1] = P[p.l1]; ++p.l1; }
        if (length > 1) {
          decodeSymbolL1Rounded(p, 0, 1);
          ++p.l0;
          valueReached = abs32(P[p.l0 + 1] - P[p.l0]) > p.rbm ? 1 : 0;
        } else if (length === 1) {
          decodeSymbolL1Rounded(p, 0, 0);
        }
      }
    }
    if (length === 1) decodeSymbolL1Rounded(p, 1, 0);
    P[p.l1 + 1] = P[p.l1] + 1;
    return 0;
  }

  function decodeLineNoRefPrevLine(p) {
    const P = p.P, l0 = p.l0, l1 = p.l1, l2 = p.l2, w = p.w;
    let i = 0;
    for (; i < w - 1; i++) {
      if (P[l0 + i + 2] | P[l0 + i + 1] | P[l1 + i]) {
        const bitCode = readCode(p.bs, p.kParam);
        P[l1 + i + 1] = (-(bitCode & 1)) ^ (bitCode >>> 1);
        p.kParam = predictK(p.kParam, bitCode, 0);
        if (P[l2 + i + 1] - p.kParam <= 1) {
          if (p.kParam >= 15) p.kParam = 15;
        } else ++p.kParam;
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = 1;
          if (i !== w - 1) {
            while (getBits(p.bs, 1)) {
              nSyms += JS[p.sParam];
              if (i + nSyms > w) { nSyms = w - i; break; }
              if (p.sParam < 31) ++p.sParam;
              if (i + nSyms === w) break;
            }
            if (i + nSyms < w) {
              if (J[p.sParam]) nSyms += getBits(p.bs, J[p.sParam]);
              if (p.sParam > 0) --p.sParam;
            }
            if (i + nSyms > w) return -1;
          }
        } else if (i > w) return -1;

        if (nSyms > 0) {
          P.fill(0, l1 + i + 1, l1 + i + 1 + nSyms);
          P.fill(0, l2 + i, l2 + i + nSyms);
          i += nSyms;
        }

        if (i >= w - 1) {
          if (i === w - 1) {
            const bitCode = readCode(p.bs, p.kParam);
            P[l1 + i + 1] = (-((bitCode + 1) & 1)) ^ ((bitCode + 1) >>> 1);
            p.kParam = predictK(p.kParam, bitCode, 15);
            P[l2 + i] = p.kParam;
          }
          continue;
        } else {
          const bitCode = readCode(p.bs, p.kParam);
          P[l1 + i + 1] = (-((bitCode + 1) & 1)) ^ ((bitCode + 1) >>> 1);
          p.kParam = predictK(p.kParam, bitCode, 0);
          if (P[l2 + i + 1] - p.kParam <= 1) {
            if (p.kParam >= 15) p.kParam = 15;
          } else ++p.kParam;
        }
      }
      P[l2 + i] = p.kParam;
    }
    if (i === w - 1) {
      const bitCode = readCode(p.bs, p.kParam);
      P[l1 + i + 1] = (-(bitCode & 1)) ^ (bitCode >> 1);
      p.kParam = predictK(p.kParam, bitCode, 15);
      P[l2 + i] = p.kParam;
    }
    return 0;
  }

  function decodeTopLine(p) {
    const P = p.P;
    P[p.l1] = 0;
    let length = p.w;
    for (; length > 1; --length) {
      if (P[p.l1]) {
        P[p.l1 + 1] = P[p.l1];
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = readRunLength(p, length);
          if (nSyms < 0) return -1;
        }
        length -= nSyms;
        while (nSyms-- > 0) { P[p.l1 + 1] = P[p.l1]; ++p.l1; }
        if (length <= 0) break;
        P[p.l1 + 1] = 0;
      }
      const bitCode = readCode(p.bs, p.kParam);
      P[p.l1 + 1] += (-(bitCode & 1)) ^ (bitCode >>> 1);
      p.kParam = predictK(p.kParam, bitCode, 15);
      ++p.l1;
    }
    if (length === 1) {
      P[p.l1 + 1] = P[p.l1];
      const bitCode = readCode(p.bs, p.kParam);
      P[p.l1 + 1] += (-(bitCode & 1)) ^ (bitCode >>> 1);
      p.kParam = predictK(p.kParam, bitCode, 15);
      ++p.l1;
    }
    P[p.l1 + 1] = P[p.l1] + 1;
    return 0;
  }

  function decodeTopLineRounded(p) {
    const P = p.P;
    P[p.l1] = 0;
    let length = p.w;
    for (; length > 1; --length) {
      if (abs32(P[p.l1]) > p.rbm) {
        P[p.l1 + 1] = P[p.l1];
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = readRunLength(p, length);
          if (nSyms < 0) return -1;
        }
        length -= nSyms;
        while (nSyms-- > 0) { P[p.l1 + 1] = P[p.l1]; ++p.l1; }
        if (length <= 0) break;
        P[p.l1 + 1] = 0;
      }
      const bitCode = readCode(p.bs, p.kParam);
      const sVal = (-(bitCode & 1)) ^ (bitCode >>> 1);
      P[p.l1 + 1] += Math.imul(p.rbm * 2, sVal) + (sVal >> 31);
      p.kParam = predictK(p.kParam, bitCode, 15);
      ++p.l1;
    }
    if (length === 1) {
      const bitCode = readCode(p.bs, p.kParam);
      const sVal = (-(bitCode & 1)) ^ (bitCode >>> 1);
      P[p.l1 + 1] += Math.imul(p.rbm * 2, sVal) + (sVal >> 31);
      p.kParam = predictK(p.kParam, bitCode, 15);
      ++p.l1;
    }
    P[p.l1 + 1] = P[p.l1] + 1;
    return 0;
  }

  function decodeTopLineNoRefPrevLine(p) {
    const P = p.P;
    P[p.l0] = 0;
    P[p.l1] = 0;
    let length = p.w;
    for (; length > 1; --length) {
      if (P[p.l1]) {
        const bitCode = readCode(p.bs, p.kParam);
        P[p.l1 + 1] = (-(bitCode & 1)) ^ (bitCode >>> 1);
        p.kParam = predictK(p.kParam, bitCode, 15);
      } else {
        let nSyms = 0;
        if (getBits(p.bs, 1)) {
          nSyms = readRunLength(p, length);
          if (nSyms < 0) return -1;
        }
        length -= nSyms;
        while (nSyms-- > 0) {
          P[p.l2] = 0;
          P[p.l1 + 1] = 0;
          ++p.l1;
          ++p.l2;
        }
        if (length <= 0) break;
        const bitCode = readCode(p.bs, p.kParam);
        P[p.l1 + 1] = (-((bitCode + 1) & 1)) ^ ((bitCode + 1) >>> 1);
        p.kParam = predictK(p.kParam, bitCode, 15);
      }
      P[p.l2] = p.kParam;
      ++p.l2;
      ++p.l1;
    }
    if (length === 1) {
      const bitCode = readCode(p.bs, p.kParam);
      P[p.l1 + 1] = (-(bitCode & 1)) ^ (bitCode >>> 1);
      p.kParam = predictK(p.kParam, bitCode, 15);
      P[p.l2] = p.kParam;
      ++p.l1;
    }
    P[p.l1 + 1] = 0;
    return 0;
  }

  /** crxDecodeLine(param, bandBuf): decodes one line into B[bufOff..]. */
  function decodeBandLine(p, B, bufOff) {
    if (!p) return -1;
    if (p.curLine >= p.h) return -1;
    const lineLength = p.w + 2;
    let lineStart, rc;
    if (p.curLine === 0) {
      p.sParam = 0;
      p.kParam = 0;
      if (p.supportsPartial) {
        if (p.rbm <= 0) {
          p.l0 = 0; p.l1 = lineLength;
          lineStart = p.l1 + 1;
          rc = decodeTopLine(p);
        } else {
          p.roundedBits = 1;
          if (p.rbm & ~1) { while (p.rbm >> p.roundedBits) ++p.roundedBits; }
          p.l0 = 0; p.l1 = lineLength;
          lineStart = p.l1 + 1;
          rc = decodeTopLineRounded(p);
        }
      } else {
        p.l2 = p.npOff;
        p.l0 = 0; p.l1 = lineLength;
        lineStart = p.l1 + 1;
        rc = decodeTopLineNoRefPrevLine(p);
      }
    } else {
      if (!p.supportsPartial) p.l2 = p.npOff;
      if (p.curLine & 1) { p.l1 = 0; p.l0 = lineLength; } else { p.l0 = 0; p.l1 = lineLength; }
      lineStart = p.l1 + 1;
      if (!p.supportsPartial) rc = decodeLineNoRefPrevLine(p);
      else if (p.rbm <= 0) rc = decodeLineL1(p);
      else rc = decodeLineRounded(p);
    }
    if (rc) return -1;
    B.set(p.P.subarray(lineStart, lineStart + p.w), bufOff);
    ++p.curLine;
    return 0;
  }

  // ---------------------------------------------------- quantization
  function updateQparam(band) {
    const bs = band.bandParam.bs;
    let bitCode = getZeros(bs);
    if (bitCode >= 23) bitCode = getBits(bs, 8);
    else if (band.kParam) bitCode = (getBits(bs, band.kParam) | (bitCode << band.kParam)) >>> 0;
    band.qParam += (-(bitCode & 1)) ^ (bitCode >>> 1);
    band.kParam = predictK(band.kParam, bitCode, 0);
    if (band.kParam > 7) return -1;
    return 0;
  }

  function getSubbandRow(band, row) {
    return row < band.rowStartAddOn ? 0
      : (row < band.height - band.rowEndAddOn ? row - band.rowEndAddOn
        : band.height - band.rowEndAddOn - band.rowStartAddOn - 1);
  }

  function decodeLineWithIQuantization(B, band, qStep) {
    if (!band.dataSize) {
      B.fill(0, band.bufOff, band.bufOff + band.width);
      return 0;
    }
    if (band.supportsPartial && !qStep && updateQparam(band)) return -1;
    if (decodeBandLine(band.bandParam, B, band.bufOff)) return -1;
    if (band.width <= 0) return 0;
    const o = band.bufOff;
    if (qStep) {
      const tbl = qStep.tbl;
      const rowBase = qStep.off + qStep.width * getSubbandRow(band, band.bandParam.curLine - 1);
      const mult = band.qStepMult >>> 0;
      const qv = (t) => constrain((band.qStepBase + ((Math.imul(t, mult) >>> 0) >>> 3)) | 0, 1, 0x168000);
      for (let i = 0; i < band.colStartAddOn; ++i)
        B[o + i] = Math.imul(B[o + i], qv(tbl[rowBase]));
      for (let i = band.colStartAddOn; i < band.width - band.colEndAddOn; ++i)
        B[o + i] = Math.imul(B[o + i], qv(tbl[rowBase + ((i - band.colStartAddOn) >> band.levelShift)]));
      const lastIdx = (band.width - band.colEndAddOn - band.colStartAddOn - 1) >> band.levelShift;
      for (let i = band.width - band.colEndAddOn; i < band.width; ++i)
        B[o + i] = Math.imul(B[o + i], qv(tbl[rowBase + lastIdx]));
    } else {
      const qp = band.qParam;
      let qScale = q_step_tbl[Math.max(0, qp % 6)] >> (6 - idiv(qp, 6));
      if (idiv(qp, 6) >= 6) qScale = Math.imul(q_step_tbl[qp % 6], 1 << (idiv(qp, 6) + 26));
      if (qScale !== 1)
        for (let i = 0; i < band.width; ++i) B[o + i] = Math.imul(B[o + i], qScale);
    }
    return 0;
  }

  // ------------------------------------------------------ inverse DWT 5/3
  function horizontal53(B, la, lb, wv, tileFlag) {
    let b0 = wv.s0, b1 = wv.s1, b2 = wv.s2, b3 = wv.s3;
    if (wv.width <= 1) {
      B[la] = B[b0];
      B[lb] = B[b2];
      return;
    }
    if (tileFlag & E_HAS_TILES_ON_THE_LEFT) {
      B[la] = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      B[lb] = B[b2] - ((B[b3] + B[b3 + 1] + 2) >> 2);
      ++b1; ++b3;
    } else {
      B[la] = B[b0] - ((B[b1] + 1) >> 1);
      B[lb] = B[b2] - ((B[b3] + 1) >> 1);
    }
    ++b0; ++b2;
    for (let i = 0; i < wv.width - 3; i += 2) {
      let delta = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      B[la + 1] = B[b1] + ((delta + B[la]) >> 1);
      B[la + 2] = delta;
      delta = B[b2] - ((B[b3] + B[b3 + 1] + 2) >> 2);
      B[lb + 1] = B[b3] + ((delta + B[lb]) >> 1);
      B[lb + 2] = delta;
      ++b0; ++b1; ++b2; ++b3;
      la += 2; lb += 2;
    }
    if (tileFlag & E_HAS_TILES_ON_THE_RIGHT) {
      const deltaA = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      B[la + 1] = B[b1] + ((deltaA + B[la]) >> 1);
      const deltaB = B[b2] - ((B[b3] + B[b3 + 1] + 2) >> 2);
      B[lb + 1] = B[b3] + ((deltaB + B[lb]) >> 1);
      if (wv.width & 1) {
        B[la + 2] = deltaA;
        B[lb + 2] = deltaB;
      }
    } else if (wv.width & 1) {
      B[la + 1] = B[b1] + ((B[la] + B[b0] - ((B[b1] + 1) >> 1)) >> 1);
      B[la + 2] = B[b0] - ((B[b1] + 1) >> 1);
      B[lb + 1] = B[b3] + ((B[lb] + B[b2] - ((B[b3] + 1) >> 1)) >> 1);
      B[lb + 2] = B[b2] - ((B[b3] + 1) >> 1);
    } else {
      B[la + 1] = B[la] + B[b1];
      B[lb + 1] = B[lb] + B[b3];
    }
  }

  /** One horizontal L band pass (used by several branches). */
  function horizontalL(B, l, b0, b1, wv, tileFlag, hTail) {
    if (wv.width <= 1) { B[l] = B[b0]; return; }
    if (tileFlag & E_HAS_TILES_ON_THE_LEFT) {
      B[l] = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      ++b1;
    } else {
      B[l] = B[b0] - ((B[b1] + 1) >> 1);
    }
    ++b0;
    for (let i = 0; i < wv.width - 3; i += 2) {
      const delta = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      B[l + 1] = B[b1] + ((B[l] + delta) >> 1);
      B[l + 2] = delta;
      ++b0; ++b1;
      l += 2;
    }
    if (tileFlag & E_HAS_TILES_ON_THE_RIGHT) {
      const delta = B[b0] - ((B[b1] + B[b1 + 1] + 2) >> 2);
      B[l + 1] = B[b1] + ((B[l] + delta) >> 1);
      if (hTail || (wv.width & 1)) B[l + 2] = delta;
    } else if (wv.width & 1) {
      const delta = B[b0] - ((B[b1] + 1) >> 1);
      B[l + 1] = B[b1] + ((B[l] + delta) >> 1);
      B[l + 2] = delta;
    } else {
      B[l + 1] = B[b1] + B[l];
    }
  }

  function idwt53FilterGetLine(comp, level) {
    const wv = comp.wvlt[level];
    const result = wv.lb[(wv.fltTapH - wv.curH + 5) % 5 + 3];
    wv.curH--;
    return result;
  }

  function idwt53FilterDecode(comp, level, qStep) {
    const wv = comp.wvlt[level];
    if (wv.curH) return 0;
    const B = comp.B;
    const sb = 3 * level;
    const bands = comp.subBands;
    const qStepLevel = qStep ? qStep[level] : null;
    if (wv.height - 3 <= wv.curLine && !(comp.tileFlag & E_HAS_TILES_ON_THE_BOTTOM)) {
      if (wv.height & 1) {
        if (level) {
          if (idwt53FilterDecode(comp, level - 1, qStep)) return -1;
        } else if (decodeLineWithIQuantization(B, bands[sb], qStepLevel)) return -1;
        if (decodeLineWithIQuantization(B, bands[sb + 1], qStepLevel)) return -1;
      }
    } else {
      if (level) {
        if (idwt53FilterDecode(comp, level - 1, qStep)) return -1;
      } else if (decodeLineWithIQuantization(B, bands[sb], qStepLevel)) return -1;
      if (decodeLineWithIQuantization(B, bands[sb + 1], qStepLevel) ||
        decodeLineWithIQuantization(B, bands[sb + 2], qStepLevel) ||
        decodeLineWithIQuantization(B, bands[sb + 3], qStepLevel)) return -1;
    }
    return 0;
  }

  function idwt53FilterTransform(comp, level) {
    const wv = comp.wvlt[level];
    const B = comp.B;
    const tileFlag = comp.tileFlag;
    if (wv.curH) return 0;

    if (wv.curLine >= wv.height - 3) {
      if (!(tileFlag & E_HAS_TILES_ON_THE_BOTTOM)) {
        if (wv.height & 1) {
          if (level) {
            if (!comp.wvlt[level - 1].curH)
              if (idwt53FilterTransform(comp, level - 1)) return -1;
            wv.s0 = idwt53FilterGetLine(comp, level - 1);
          }
          const lineBufH0 = wv.lb[wv.fltTapH + 3];
          const lineBufH1 = wv.lb[(wv.fltTapH + 1) % 5 + 3];
          const lineBufH2 = wv.lb[(wv.fltTapH + 2) % 5 + 3];
          const lineBufL0 = wv.lb[0];
          const lineBufL1 = wv.lb[1];
          wv.lb[1] = wv.lb[2];
          wv.lb[2] = lineBufL1;

          // process L bands
          horizontalL(B, lineBufL0, wv.s0, wv.s1, wv, tileFlag, false);

          // process H bands
          const L0 = wv.lb[0], L1 = wv.lb[1];
          for (let i = 0; i < wv.width; i++) {
            const delta = B[L0 + i] - ((B[L1 + i] + 1) >> 1);
            B[lineBufH1 + i] = B[L1 + i] + ((delta + B[lineBufH0 + i]) >> 1);
            B[lineBufH2 + i] = delta;
          }
          wv.curH += 3;
          wv.curLine += 3;
          wv.fltTapH = (wv.fltTapH + 3) % 5;
        } else {
          const lineBufL2 = wv.lb[2];
          const lineBufH0 = wv.lb[wv.fltTapH + 3];
          const lineBufH1 = wv.lb[(wv.fltTapH + 1) % 5 + 3];
          wv.lb[1] = lineBufL2;
          wv.lb[2] = wv.lb[1];
          for (let i = 0; i < wv.width; i++)
            B[lineBufH1 + i] = B[lineBufH0 + i] + B[lineBufL2 + i];
          wv.curH += 2;
          wv.curLine += 2;
          wv.fltTapH = (wv.fltTapH + 2) % 5;
        }
      }
    } else {
      if (level) {
        if (!comp.wvlt[level - 1].curH && idwt53FilterTransform(comp, level - 1)) return -1;
        wv.s0 = idwt53FilterGetLine(comp, level - 1);
      }
      const lineBufL0 = wv.lb[0];
      const lineBufL1 = wv.lb[1];
      const lineBufH0 = wv.lb[wv.fltTapH + 3];
      const lineBufH1 = wv.lb[(wv.fltTapH + 1) % 5 + 3];
      const lineBufH2 = wv.lb[(wv.fltTapH + 2) % 5 + 3];
      wv.lb[1] = wv.lb[2];
      wv.lb[2] = lineBufL1;

      // process L bands
      horizontal53(B, lineBufL0, lineBufL1, wv, tileFlag);

      // process H bands
      const L0 = wv.lb[0], L1 = wv.lb[1], L2 = wv.lb[2];
      for (let i = 0; i < wv.width; i++) {
        const delta = B[L0 + i] - ((B[L2 + i] + B[L1 + i] + 2) >> 2);
        B[lineBufH1 + i] = B[L1 + i] + ((delta + B[lineBufH0 + i]) >> 1);
        B[lineBufH2 + i] = delta;
      }
      if (wv.curLine >= wv.height - 3 && (wv.height & 1)) {
        wv.curH += 3;
        wv.curLine += 3;
        wv.fltTapH = (wv.fltTapH + 3) % 5;
      } else {
        wv.curH += 2;
        wv.curLine += 2;
        wv.fltTapH = (wv.fltTapH + 2) % 5;
      }
    }
    return 0;
  }

  function idwt53FilterInitialize(comp, level, qStep) {
    if (level === 0) return 0;
    const B = comp.B;
    const tileFlag = comp.tileFlag;
    const bands = comp.subBands;
    for (let curLevel = 0, curBand = 0; curLevel < level; curLevel++, curBand += 3) {
      const qStepLevel = qStep ? qStep[curLevel] : null;
      const wv = comp.wvlt[curLevel];
      if (curLevel) wv.s0 = idwt53FilterGetLine(comp, curLevel - 1);
      else if (decodeLineWithIQuantization(B, bands[curBand], qStepLevel)) return -1;

      let lineBufH0 = wv.lb[wv.fltTapH + 3];
      if (wv.height > 1) {
        if (decodeLineWithIQuantization(B, bands[curBand + 1], qStepLevel) ||
          decodeLineWithIQuantization(B, bands[curBand + 2], qStepLevel) ||
          decodeLineWithIQuantization(B, bands[curBand + 3], qStepLevel)) return -1;

        const lineBufL0 = wv.lb[0];
        const lineBufL1 = wv.lb[1];
        const lineBufL2 = wv.lb[2];

        if (tileFlag & E_HAS_TILES_ON_THE_TOP) {
          horizontal53(B, lineBufL0, wv.lb[1], wv, tileFlag);
          if (decodeLineWithIQuantization(B, bands[curBand + 3], qStepLevel) ||
            decodeLineWithIQuantization(B, bands[curBand + 2], qStepLevel)) return -1;
          // process L band
          horizontalL(B, lineBufL2, wv.s2, wv.s3, wv, tileFlag, false);
          // process H band
          for (let i = 0; i < wv.width; i++)
            B[lineBufH0 + i] = B[lineBufL0 + i] - ((B[lineBufL1 + i] + B[lineBufL2 + i] + 2) >> 2);
        } else {
          horizontal53(B, lineBufL0, wv.lb[2], wv, tileFlag);
          for (let i = 0; i < wv.width; i++)
            B[lineBufH0 + i] = B[lineBufL0 + i] - ((B[lineBufL2 + i] + 1) >> 1);
        }
        if (idwt53FilterDecode(comp, curLevel, qStep) || idwt53FilterTransform(comp, curLevel)) return -1;
      } else {
        if (decodeLineWithIQuantization(B, bands[curBand + 1], qStepLevel)) return -1;
        // process H band (note: the RIGHT tail always writes [2] here, like LibRaw)
        horizontalL(B, lineBufH0, wv.s0, wv.s1, wv, tileFlag, true);
        ++wv.curLine;
        ++wv.curH;
        wv.fltTapH = (wv.fltTapH + 1) % 5;
      }
    }
    return 0;
  }

  // ----------------------------------------------------- setup and output
  function paramInit(img, mdatOffset, dataSize, width, height, supportsPartial, rbm) {
    const paramLength = 2 * width + 4;
    const progr = supportsPartial ? 0 : width;
    return {
      P: new Int32Array(paramLength + progr + 4),
      npOff: paramLength,
      w: width, h: height,
      roundedBits: 0, curLine: 0, rbm, supportsPartial,
      l0: 0, l1: 0, l2: paramLength,
      sParam: 0, kParam: 0,
      bs: bsInit(img.u8, mdatOffset, dataSize),
    };
  }

  function setupSubbandData(img, comp, tile, mdatOffset) {
    const toSubbands = 3 * img.levels + 1;
    const bands = comp.subBands;
    let size = 0;
    for (let k = 0; k < toSubbands; k++) {
      bands[k].bufOff = size;
      size += bands[k].width;
    }
    // LibRaw places the wavelet structs between band buffers and line buffers
    let lineOff = 0;
    if (img.levels) {
      lineOff = ((size + 1) & ~1) + 28 * img.levels;
      size = lineOff;
      for (let level = 0; level < img.levels; ++level)
        size += 8 * (level < img.levels - 1 ? bands[3 * (level + 1) + 2].width : tile.width);
    }
    const B = new Int32Array(size + 8);
    comp.B = B;

    const subbandMdatOffset = img.mdatOffset + mdatOffset;
    for (let k = 0; k < toSubbands; k++) bands[k].mdatOffset = subbandMdatOffset + bands[k].dataOffset;

    if (img.levels) {
      comp.wvlt = [];
      let pd = lineOff;
      for (let level = 0; level < img.levels; ++level) {
        const band = 3 * level + 1;
        let height, tw;
        if (level >= img.levels - 1) { height = tile.height; tw = tile.width; }
        else { height = bands[band + 3].height; tw = bands[band + 4].width; }
        const lb = [];
        for (let k = 0; k < 8; k++) lb.push(pd + k * tw);
        comp.wvlt.push({
          s0: level === 0 ? bands[0].bufOff : 0,
          s1: bands[band].bufOff, s2: bands[band + 1].bufOff, s3: bands[band + 2].bufOff,
          lb, curLine: 0, curH: 0, fltTapH: 0, height, width: tw,
        });
        pd += 8 * tw;
      }
    }

    for (let k = 0; k < toSubbands; k++) {
      const b = bands[k];
      if (b.dataSize) {
        let supportsPartial = false, rbm = 0;
        if (comp.supportsPartial && k === 0) { rbm = comp.roundedBitsMask; supportsPartial = true; }
        b.bandParam = paramInit(img, b.mdatOffset, b.dataSize, b.width, b.height, supportsPartial, rbm);
      }
    }
  }

  function convertPlaneLine(img, imageRow, imageCol, plane, B, lineOff, lineLength) {
    const out = img.out;
    if (img.encType === 1) {
      let maxVal = 1 << (img.nBits - 1);
      const minVal = -maxVal;
      --maxVal;
      let o = img.outBufs[plane] + 4 * img.planeWidth * imageRow + 2 * imageCol;
      for (let i = 0; i < lineLength; i++, o += 2) out[o] = constrain(B[lineOff + i], minVal, maxVal);
    } else if (img.encType === 3) {
      const o = plane * img.planeWidth * img.planeHeight + img.planeWidth * imageRow + imageCol;
      for (let i = 0; i < lineLength; i++) img.planeBuf[o + i] = B[lineOff + i];
    } else if (img.nPlanes === 4) {
      const median = 1 << (img.nBits - 1);
      const maxVal = (1 << img.nBits) - 1;
      let o = img.outBufs[plane] + 4 * img.planeWidth * imageRow + 2 * imageCol;
      for (let i = 0; i < lineLength; i++, o += 2) out[o] = constrain(median + B[lineOff + i], 0, maxVal);
    } else if (img.nPlanes === 1) {
      const maxVal = (1 << img.nBits) - 1;
      const median = 1 << (img.nBits - 1);
      const o = img.planeWidth * imageRow + imageCol;
      for (let i = 0; i < lineLength; i++) out[o + i] = constrain(median + B[lineOff + i], 0, maxVal);
    }
  }

  function convertPlaneLineE3(img, imageRow) {
    const pw = img.planeWidth;
    const planeSize = pw * img.planeHeight;
    const pb = img.planeBuf;
    const p0 = imageRow * pw, p1 = p0 + planeSize, p2 = p1 + planeSize, p3 = p2 + planeSize;
    const median = (1 << (img.medianBits - 1)) << 10;
    const maxVal = (1 << img.medianBits) - 1;
    const rawLineOffset = 4 * pw * imageRow;
    const out = img.out, ob = img.outBufs;
    for (let i = 0; i < pw; i++) {
      let gr = median + (pb[p0 + i] << 10) - 168 * pb[p1 + i] - 585 * pb[p3 + i];
      if (gr < 0) gr = -(((abs32(gr) + 512) >> 9) & ~1);
      else gr = ((abs32(gr) + 512) >> 9) & ~1;
      let val = (median + (pb[p0 + i] << 10) + 1510 * pb[p3 + i] + 512) >> 10;
      out[ob[0] + rawLineOffset + 2 * i] = constrain(val, 0, maxVal);
      val = (pb[p2 + i] + gr + 1) >> 1;
      out[ob[1] + rawLineOffset + 2 * i] = constrain(val, 0, maxVal);
      val = (gr - pb[p2 + i] + 1) >> 1;
      out[ob[2] + rawLineOffset + 2 * i] = constrain(val, 0, maxVal);
      val = (median + (pb[p0 + i] << 10) + 1927 * pb[p1 + i] + 512) >> 10;
      out[ob[3] + rawLineOffset + 2 * i] = constrain(val, 0, maxVal);
    }
  }

  function decodePlane(img, planeNumber, progress) {
    let imageRow = 0;
    for (let tRow = 0; tRow < img.tileRows; tRow++) {
      let imageCol = 0;
      for (let tCol = 0; tCol < img.tileCols; tCol++) {
        const tile = img.tiles[tRow * img.tileCols + tCol];
        const comp = tile.comps[planeNumber];
        const tileMdatOffset = tile.dataOffset + tile.mdatQPDataSize + tile.mdatExtraSize + comp.dataOffset;
        setupSubbandData(img, comp, tile, tileMdatOffset);
        if (img.levels) {
          if (idwt53FilterInitialize(comp, img.levels, tile.qStep)) return -1;
          for (let i = 0; i < tile.height; ++i) {
            if (idwt53FilterDecode(comp, img.levels - 1, tile.qStep) ||
              idwt53FilterTransform(comp, img.levels - 1)) return -1;
            const lineOff = idwt53FilterGetLine(comp, img.levels - 1);
            convertPlaneLine(img, imageRow + i, imageCol, planeNumber, comp.B, lineOff, tile.width);
          }
        } else {
          const band = comp.subBands[0];
          if (!band.dataSize) {
            comp.B.fill(0, band.bufOff, band.bufOff + band.width);
            return 0;
          }
          for (let i = 0; i < tile.height; ++i) {
            if (decodeBandLine(band.bandParam, comp.B, band.bufOff)) return -1;
            convertPlaneLine(img, imageRow + i, imageCol, planeNumber, comp.B, band.bufOff, tile.width);
          }
        }
        comp.B = null; // free tile buffers early
        for (const b of comp.subBands) b.bandParam = null;
        imageCol += tile.width;
        if (progress) progress((planeNumber + (tRow * img.tileCols + tCol + 1) / (img.tileRows * img.tileCols)) / img.nPlanes);
      }
      imageRow += img.tiles[tRow * img.tileCols].height;
    }
    return 0;
  }

  // --------------------------------------------------------- header parsing
  function readQP(bs, kParam) {
    let qp = getZeros(bs);
    if (qp >= 23) qp = getBits(bs, 8);
    else if (kParam) qp = (getBits(bs, kParam) | (qp << kParam)) >>> 0;
    return qp;
  }

  function decodeGolombTop(bs, width, L, o, kp) {
    L[o] = 0;
    while (width-- > 0) {
      L[o + 1] = L[o];
      const qp = readQP(bs, kp.k);
      L[o + 1] += (-(qp & 1)) ^ (qp >>> 1);
      kp.k = predictK(kp.k, qp, 7);
      ++o;
    }
    L[o + 1] = L[o] + 1;
  }

  function decodeGolombNormal(bs, width, L, o0, o1, kp) {
    L[o1] = L[o0 + 1];
    let deltaH = L[o0 + 1] - L[o0];
    while (width-- > 0) {
      // crxPrediction(left, top, deltaH, deltaV)
      const left = L[o1], top = L[o0 + 1], deltaV = L[o0] - L[o1];
      const sel = (((deltaV < 0) ^ (deltaH < 0)) << 1) + ((left < top) ^ (deltaH < 0));
      L[o1 + 1] = sel < 2 ? left + deltaH : (sel === 2 ? left : top);
      const qp = readQP(bs, kp.k);
      L[o1 + 1] += (-(qp & 1)) ^ (qp >>> 1);
      if (width) {
        deltaH = L[o0 + 2] - L[o0 + 1];
        kp.k = predictK(kp.k, ((qp + 2 * abs32(deltaH)) >>> 0) >>> 1, 7);
        ++o0;
      } else {
        kp.k = predictK(kp.k, qp, 7);
      }
      ++o1;
    }
    L[o1 + 1] = L[o1] + 1;
  }

  function qstepValue(q) {
    if (idiv(q, 6) >= 6) return (q_step_tbl[q % 6] << ((idiv(q, 6) - 6) & 0x1f)) >>> 0;
    return q_step_tbl[Math.max(0, q % 6)] >> (6 - idiv(q, 6));
  }

  function makeQStep(img, tile, qpTable) {
    if (img.levels > 3 || img.levels < 1) return -1;
    const qpWidth = (tile.width >> 3) + ((tile.width & 7) !== 0 ? 1 : 0);
    const qpHeight = (tile.height >> 1) + (tile.height & 1);
    const qpHeight4 = (tile.height >> 2) + ((tile.height & 3) !== 0 ? 1 : 0);
    const qpHeight8 = (tile.height >> 3) + ((tile.height & 7) !== 0 ? 1 : 0);
    let totalHeight = qpHeight;
    if (img.levels > 1) totalHeight += qpHeight4;
    if (img.levels > 2) totalHeight += qpHeight8;
    const tbl = new Uint32Array(totalHeight * qpWidth);
    const steps = [];
    let t = 0;
    if (img.levels >= 3) {
      steps.push({ tbl, off: t, width: qpWidth, height: qpHeight8 });
      for (let qpRow = 0; qpRow < qpHeight8; ++qpRow) {
        let r0 = qpWidth * Math.min(4 * qpRow, qpHeight - 1);
        let r1 = qpWidth * Math.min(4 * qpRow + 1, qpHeight - 1);
        let r2 = qpWidth * Math.min(4 * qpRow + 2, qpHeight - 1);
        let r3 = qpWidth * Math.min(4 * qpRow + 3, qpHeight - 1);
        for (let qpCol = 0; qpCol < qpWidth; ++qpCol, ++t) {
          let quantVal = qpTable[r0++] + qpTable[r1++] + qpTable[r2++] + qpTable[r3++];
          quantVal = ((quantVal < 0 ? 3 : 0) + quantVal) >> 2;
          tbl[t] = qstepValue(quantVal);
        }
      }
    }
    if (img.levels >= 2) {
      steps.push({ tbl, off: t, width: qpWidth, height: qpHeight4 });
      for (let qpRow = 0; qpRow < qpHeight4; ++qpRow) {
        let r0 = qpWidth * Math.min(2 * qpRow, qpHeight - 1);
        let r1 = qpWidth * Math.min(2 * qpRow + 1, qpHeight - 1);
        for (let qpCol = 0; qpCol < qpWidth; ++qpCol, ++t) {
          const quantVal = idiv(qpTable[r0++] + qpTable[r1++], 2);
          tbl[t] = qstepValue(quantVal);
        }
      }
    }
    steps.push({ tbl, off: t, width: qpWidth, height: qpHeight });
    let q = 0;
    for (let qpRow = 0; qpRow < qpHeight; ++qpRow)
      for (let qpCol = 0; qpCol < qpWidth; ++qpCol, ++t, ++q) tbl[t] = qstepValue(qpTable[q]);
    tile.qStep = steps;
    return 0;
  }

  function setupSubbandIdx(hdr, band, level, colStartIdx, bandWidthExCoef, rowStartIdx, bandHeightExCoef) {
    if (hdr.version === 0x200) {
      band.rowStartAddOn = rowStartIdx;
      band.rowEndAddOn = bandHeightExCoef;
      band.colStartAddOn = colStartIdx;
      band.colEndAddOn = bandWidthExCoef;
      band.levelShift = 3 - level;
    } else {
      band.rowStartAddOn = band.rowEndAddOn = band.colStartAddOn = band.colEndAddOn = band.levelShift = 0;
    }
  }

  function processSubbands(hdr, img, tile, comp) {
    let bi = img.subbandCount - 1; // last band
    const bands = comp.subBands;
    let bandHeight = tile.height;
    let bandWidth = tile.width;
    let bandWidthExCoef = 0, bandHeightExCoef = 0;
    if (img.levels) {
      const rowEx = 0x30 * (img.levels - 1) + 6 * (tile.width & 7);
      const colEx = 0x30 * (img.levels - 1) + 6 * (tile.height & 7);
      for (let level = 0; level < img.levels; ++level) {
        const widthOddPixel = bandWidth & 1;
        const heightOddPixel = bandHeight & 1;
        bandWidth = (widthOddPixel + bandWidth) >> 1;
        bandHeight = (heightOddPixel + bandHeight) >> 1;
        let bwEx0 = 0, bwEx1 = 0, bhEx0 = 0, bhEx1 = 0, colStartIdx = 0, rowStartIdx = 0;
        if (tile.tileFlag & E_HAS_TILES_ON_THE_RIGHT) {
          bwEx0 = exCoefNumTbl[rowEx + 2 * level];
          bwEx1 = exCoefNumTbl[rowEx + 2 * level + 1];
        }
        if (tile.tileFlag & E_HAS_TILES_ON_THE_LEFT) { ++bwEx0; colStartIdx = 1; }
        if (tile.tileFlag & E_HAS_TILES_ON_THE_BOTTOM) {
          bhEx0 = exCoefNumTbl[colEx + 2 * level];
          bhEx1 = exCoefNumTbl[colEx + 2 * level + 1];
        }
        if (tile.tileFlag & E_HAS_TILES_ON_THE_TOP) { ++bhEx0; rowStartIdx = 1; }

        const b0 = bands[bi], b1 = bands[bi - 1], b2 = bands[bi - 2];
        b0.width = bandWidth + bwEx0 - widthOddPixel;
        b0.height = bandHeight + bhEx0 - heightOddPixel;
        setupSubbandIdx(hdr, b0, level + 1, colStartIdx, bwEx0 - colStartIdx, rowStartIdx, bhEx0 - rowStartIdx);
        b1.width = bandWidth + bwEx1;
        b1.height = bandHeight + bhEx0 - heightOddPixel;
        setupSubbandIdx(hdr, b1, level + 1, 0, bwEx1, rowStartIdx, bhEx0 - rowStartIdx);
        b2.width = bandWidth + bwEx0 - widthOddPixel;
        b2.height = bandHeight + bhEx1;
        setupSubbandIdx(hdr, b2, level + 1, colStartIdx, bwEx0 - colStartIdx, 0, bhEx1);
        bi -= 3;
      }
      bandWidthExCoef = bandHeightExCoef = 0;
      if (tile.tileFlag & E_HAS_TILES_ON_THE_RIGHT) bandWidthExCoef = exCoefNumTbl[rowEx + 2 * img.levels - 1];
      if (tile.tileFlag & E_HAS_TILES_ON_THE_BOTTOM) bandHeightExCoef = exCoefNumTbl[colEx + 2 * img.levels - 1];
    }
    const b = bands[bi];
    b.width = bandWidthExCoef + bandWidth;
    b.height = bandHeightExCoef + bandHeight;
    if (img.levels) setupSubbandIdx(hdr, b, img.levels, 0, bandWidthExCoef, 0, bandHeightExCoef);
    return 0;
  }

  function readSubbandHeaders(img, comp, st) {
    if (!img.subbandCount) return 0;
    const u8 = img.u8;
    const be2 = (o) => (u8[o] << 8) | u8[o + 1];
    const be4 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
    let subbandOffset = 0;
    for (let cur = 0; cur < img.subbandCount; cur++) {
      const band = comp.subBands[cur];
      if (st.size < 4) return -1;
      const hdrSign = be2(st.p), hdrSize = be2(st.p + 2);
      if (st.size < hdrSize + 4) return -1;
      if ((hdrSign !== 0xFF03 || hdrSize !== 8) && (hdrSign !== 0xFF13 || hdrSize !== 16)) return -1;
      const subbandSize = be4(st.p + 4) | 0;
      if (cur !== ((u8[st.p + 8] & 0xF0) >> 4)) { band.dataSize = subbandSize; return -1; }
      band.dataOffset = subbandOffset;
      band.kParam = 0;
      band.bandParam = null;
      if (hdrSign === 0xFF03) {
        const bitData = be4(st.p + 8);
        band.dataSize = subbandSize - (bitData & 0x7FFFF);
        band.supportsPartial = (bitData & 0x8000000) !== 0;
        band.qParam = (bitData >>> 19) & 0xFF;
        band.qStepBase = 0;
        band.qStepMult = 0;
      } else {
        if (be2(st.p + 8) & 0xFFF) return -1;
        if (be2(st.p + 18)) return -1;
        band.supportsPartial = false;
        band.qParam = 0;
        band.dataSize = subbandSize - be2(st.p + 16);
        band.qStepBase = be4(st.p + 12) | 0;
        band.qStepMult = be2(st.p + 10);
      }
      subbandOffset += subbandSize;
      st.p += hdrSize + 4;
      st.size -= hdrSize + 4;
    }
    return 0;
  }

  function readImageHeaders(hdr, img, mdatPtr, mdatHdrSize) {
    const u8 = img.u8;
    const be2 = (o) => (u8[o] << 8) | u8[o + 1];
    const be3 = (o) => (u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2];
    const be4 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
    const nTiles = img.tileRows * img.tileCols;
    if (!nTiles) return -1;

    img.tiles = [];
    for (let curTile = 0; curTile < nTiles; curTile++) {
      const tile = { tileFlag: 0, tileNumber: curTile, tileSize: 0, comps: [], qStep: null };
      if ((curTile + 1) % img.tileCols) {
        tile.width = hdr.tileWidth;
        if (img.tileCols > 1) {
          tile.tileFlag = E_HAS_TILES_ON_THE_RIGHT;
          if (curTile % img.tileCols) tile.tileFlag |= E_HAS_TILES_ON_THE_LEFT;
        }
      } else {
        tile.width = img.planeWidth - hdr.tileWidth * (img.tileCols - 1);
        if (img.tileCols > 1) tile.tileFlag = E_HAS_TILES_ON_THE_LEFT;
      }
      if (curTile < nTiles - img.tileCols) {
        tile.height = hdr.tileHeight;
        if (img.tileRows > 1) {
          tile.tileFlag |= E_HAS_TILES_ON_THE_BOTTOM;
          if (curTile >= img.tileCols) tile.tileFlag |= E_HAS_TILES_ON_THE_TOP;
        }
      } else {
        tile.height = img.planeHeight - hdr.tileHeight * (img.tileRows - 1);
        if (img.tileRows > 1) tile.tileFlag |= E_HAS_TILES_ON_THE_TOP;
      }
      for (let c = 0; c < img.nPlanes; c++) {
        const bands = [];
        for (let b = 0; b < img.subbandCount; b++)
          bands.push({ supportsPartial: false, qParam: 4, bandParam: null, dataSize: 0, width: 0, height: 0, kParam: 0,
            qStepBase: 0, qStepMult: 0, dataOffset: 0, rowStartAddOn: 0, rowEndAddOn: 0, colStartAddOn: 0, colEndAddOn: 0, levelShift: 0 });
        tile.comps.push({ compNumber: c, supportsPartial: true, tileFlag: tile.tileFlag, subBands: bands, B: null, wvlt: null });
      }
      img.tiles.push(tile);
    }

    let tileOffset = 0;
    const st = { p: mdatPtr, size: mdatHdrSize };
    for (let curTile = 0; curTile < nTiles; ++curTile) {
      const tile = img.tiles[curTile];
      if (st.size < 4) return -1;
      let hdrSign = be2(st.p), hdrSize = be2(st.p + 2);
      if ((hdrSign !== 0xFF01 || hdrSize !== 8) && (hdrSign !== 0xFF11 || (hdrSize !== 8 && hdrSize !== 16))) return -1;
      if (st.size < hdrSize + 4) return -1;
      const tailSign = be2(st.p + 10);
      if ((hdrSize === 8 && tailSign) || (hdrSize === 16 && tailSign !== 0x4000)) return -1;
      if (be2(st.p + 8) !== curTile) return -1;
      st.size -= hdrSize + 4;
      tile.tileSize = be4(st.p + 4);
      tile.dataOffset = tileOffset;
      tile.qStep = null;
      if (hdrSize === 16) {
        if (be2(st.p + 18) !== 0) return -1;
        tile.hasQPData = true;
        tile.mdatQPDataSize = be4(st.p + 12);
        tile.mdatExtraSize = be2(st.p + 16);
      } else {
        tile.hasQPData = false;
        tile.mdatQPDataSize = 0;
        tile.mdatExtraSize = 0;
      }
      st.p += hdrSize + 4;
      tileOffset += tile.tileSize;

      let compOffset = 0;
      for (let compNum = 0; compNum < img.nPlanes; ++compNum) {
        const comp = tile.comps[compNum];
        if (st.size < 0xC) return -1;
        hdrSign = be2(st.p);
        hdrSize = be2(st.p + 2);
        if ((hdrSign !== 0xFF02 && hdrSign !== 0xFF12) || hdrSize !== 8) return -1;
        if (compNum !== (u8[st.p + 8] >> 4)) return -1;
        if (be3(st.p + 9) !== 0) return -1;
        comp.compSize = be4(st.p + 4);
        const compHdrRoundedBits = (u8[st.p + 8] >> 1) & 3;
        comp.supportsPartial = (u8[st.p + 8] & 8) !== 0;
        comp.dataOffset = compOffset;
        comp.tileFlag = tile.tileFlag;
        compOffset += comp.compSize;
        st.size -= 0xC;
        st.p += 0xC;
        comp.roundedBitsMask = 0;
        if (compHdrRoundedBits) {
          if (img.levels || !comp.supportsPartial) return -1;
          comp.roundedBitsMask = 1 << (compHdrRoundedBits - 1);
        }
        if (readSubbandHeaders(img, comp, st) || processSubbands(hdr, img, tile, comp)) return -1;
      }
    }

    if (hdr.version !== 0x200) return 0;

    for (let curTile = 0; curTile < nTiles; ++curTile) {
      const tile = img.tiles[curTile];
      if (!tile.hasQPData) continue;
      const bs = bsInit(u8, img.mdatOffset + tile.dataOffset, tile.mdatQPDataSize);
      const qpWidth = (tile.width >> 3) + ((tile.width & 7) !== 0 ? 1 : 0);
      const qpHeight = (tile.height >> 1) + (tile.height & 1);
      const totalQP = qpHeight * qpWidth;
      const qpTable = new Int32Array(totalQP + 2 * (qpWidth + 2));
      const lineBuf = totalQP;
      const kp = { k: 0 };
      let cur = 0;
      for (let qpRow = 0; qpRow < qpHeight; ++qpRow) {
        const line0 = qpRow & 1 ? lineBuf + qpWidth + 2 : lineBuf;
        const line1 = qpRow & 1 ? lineBuf : lineBuf + qpWidth + 2;
        if (qpRow) decodeGolombNormal(bs, qpWidth, qpTable, line0, line1, kp);
        else decodeGolombTop(bs, qpWidth, qpTable, line1, kp);
        for (let qpCol = 0; qpCol < qpWidth; ++qpCol) qpTable[cur++] = qpTable[line1 + qpCol + 1] + 4;
      }
      if (makeQStep(img, tile, qpTable)) return -1;
    }
    return 0;
  }

  // ------------------------------------------------------------- public
  /** crxParseImageHeader: parses the CMP1 box payload. Returns hdr or null. */
  RL.crxParseHeader = function (u8, o, size) {
    if (size < 32) return null;
    const be2 = (p) => (u8[p] << 8) | u8[p + 1];
    const be4 = (p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
    const hdr = {
      version: be2(o + 4),
      f_width: be4(o + 8),
      f_height: be4(o + 12),
      tileWidth: be4(o + 16),
      tileHeight: be4(o + 20),
      nBits: u8[o + 24],
      nPlanes: u8[o + 25] >> 4,
      cfaLayout: u8[o + 25] & 0xF,
      encType: u8[o + 26] >> 4,
      imageLevels: u8[o + 26] & 0xF,
      hasTileCols: u8[o + 27] >> 7,
      hasTileRows: (u8[o + 27] >> 6) & 1,
      mdatHdrSize: be4(o + 28),
    };
    const extHeader = size > 32 ? u8[o + 32] >> 7 : 0;
    let useMedianBits = 0;
    hdr.medianBits = hdr.nBits;
    if (extHeader && size >= 56 && hdr.nPlanes === 4) useMedianBits = (u8[o + 56] >> 6) & 1;
    if (useMedianBits && size >= 84) hdr.medianBits = u8[o + 84];

    if ((hdr.version !== 0x100 && hdr.version !== 0x200) || !hdr.mdatHdrSize) return null;
    if (hdr.encType === 1) {
      if (hdr.nBits > 15) return null;
    } else {
      if (hdr.encType && hdr.encType !== 3) return null;
      if (hdr.nBits > 14) return null;
    }
    if (hdr.nPlanes === 1) {
      if (hdr.cfaLayout || hdr.encType || hdr.nBits !== 8) return null;
    } else if (hdr.nPlanes !== 4 || (hdr.f_width & 1) || (hdr.f_height & 1) || (hdr.tileWidth & 1) ||
      (hdr.tileHeight & 1) || hdr.cfaLayout > 3 || hdr.nBits === 8) return null;
    if (hdr.tileWidth > hdr.f_width || hdr.tileHeight > hdr.f_height) return null;
    if (hdr.imageLevels > 3 || hdr.hasTileCols > 1 || hdr.hasTileRows > 1) return null;
    return hdr;
  };

  /**
   * Decodes a CRX frame (crxLoadRaw). `hdr` from crxParseHeader, the frame
   * starts at dataOffset in u8. Returns Uint16Array(f_width * f_height).
   */
  RL.decodeCrx = function (u8, hdr0, dataOffset, dataSize, progress) {
    const hdr = Object.assign({}, hdr0);
    const rawW = hdr.f_width, rawH = hdr.f_height;
    if (hdr.nPlanes === 4) {
      hdr.f_width >>= 1;
      hdr.f_height >>= 1;
      hdr.tileWidth >>= 1;
      hdr.tileHeight >>= 1;
    }
    if (dataSize < hdr.mdatHdrSize) fail();

    const img = { u8 };
    img.planeWidth = hdr.f_width;
    img.planeHeight = hdr.f_height;
    if (hdr.tileWidth < 0x16 || hdr.tileHeight < 0x16 || img.planeWidth > 0x7FFF || img.planeHeight > 0x7FFF) fail();
    img.tileCols = idiv(img.planeWidth + hdr.tileWidth - 1, hdr.tileWidth);
    img.tileRows = idiv(img.planeHeight + hdr.tileHeight - 1, hdr.tileHeight);
    if (img.tileCols > 0xFF || img.tileRows > 0xFF ||
      img.planeWidth - hdr.tileWidth * (img.tileCols - 1) < 0x16 ||
      img.planeHeight - hdr.tileHeight * (img.tileRows - 1) < 0x16) fail();

    img.levels = hdr.imageLevels;
    img.subbandCount = 3 * img.levels + 1;
    img.nPlanes = hdr.nPlanes;
    img.nBits = hdr.nBits;
    img.encType = hdr.encType;
    img.mdatOffset = dataOffset + hdr.mdatHdrSize;
    img.mdatSize = dataSize;
    img.medianBits = hdr.medianBits;
    img.out = new Uint16Array(rawW * rawH);
    img.planeBuf = null;
    if (img.encType === 3 && img.nPlanes === 4 && img.nBits > 8)
      img.planeBuf = new Int16Array(img.planeHeight * img.planeWidth * img.nPlanes);

    const rowSize = 2 * img.planeWidth;
    if (img.nPlanes === 1) img.outBufs = [0, 0, 0, 0];
    else {
      switch (hdr.cfaLayout) {
        case 0: img.outBufs = [0, 1, rowSize, rowSize + 1]; break;          // R G / G B
        case 1: img.outBufs = [1, 0, rowSize + 1, rowSize]; break;          // G R / B G
        case 2: img.outBufs = [rowSize, rowSize + 1, 0, 1]; break;          // G B / R G
        case 3: img.outBufs = [rowSize + 1, rowSize, 1, 0]; break;          // B G / G R
      }
    }
    if (readImageHeaders(hdr, img, dataOffset, hdr.mdatHdrSize)) fail();

    for (let plane = 0; plane < img.nPlanes; ++plane)
      if (decodePlane(img, plane, progress)) fail();

    if (img.encType === 3 && img.planeBuf)
      for (let i = 0; i < img.planeHeight; ++i) convertPlaneLineE3(img, i);
    return img.out;
  };
});
