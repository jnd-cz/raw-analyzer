/*
 * Metadata dictionaries and formatting: TIFF/EXIF/GPS tag names, the Canon
 * maker note and the CRW (CIFF) records.
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';

  const EXIF = {
    0x00fe: 'NewSubfileType', 0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x0102: 'BitsPerSample',
    0x0103: 'Compression', 0x0106: 'PhotometricInterpretation', 0x010e: 'ImageDescription',
    0x010f: 'Make', 0x0110: 'Model', 0x0111: 'StripOffsets', 0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel', 0x0116: 'RowsPerStrip', 0x0117: 'StripByteCounts',
    0x011a: 'XResolution', 0x011b: 'YResolution', 0x011c: 'PlanarConfiguration',
    0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist',
    0x014a: 'SubIFDs', 0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength',
    0x0213: 'YCbCrPositioning', 0x02bc: 'XMP', 0x8298: 'Copyright', 0x829a: 'ExposureTime',
    0x829d: 'FNumber', 0x83bb: 'IPTC-NAA', 0x8769: 'ExifIFD', 0x8822: 'ExposureProgram',
    0x8825: 'GPSInfo', 0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType',
    0x8832: 'RecommendedExposureIndex', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
    0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
    0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
    0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
    0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal',
    0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
    0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa005: 'InteropIFD',
    0xa20e: 'FocalPlaneXResolution', 0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit',
    0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType', 0xa401: 'CustomRendered',
    0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio',
    0xa405: 'FocalLengthIn35mmFilm', 0xa406: 'SceneCaptureType', 0xa430: 'CameraOwnerName',
    0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification', 0xa433: 'LensMake', 0xa434: 'LensModel',
    0xa435: 'LensSerialNumber', 0xc5d8: 'CR2_0xC5D8', 0xc5d9: 'CR2_0xC5D9', 0xc5e0: 'CR2_0xC5E0',
    0xc640: 'CR2Slice', 0xc6c5: 'SRawType', 0xc6dc: 'CR2_0xC6DC',
  };

  const GPS = {
    0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef',
    0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef', 0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp',
    0x0008: 'GPSSatellites', 0x0009: 'GPSStatus', 0x000a: 'GPSMeasureMode', 0x000b: 'GPSDOP',
    0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x0010: 'GPSImgDirectionRef', 0x0011: 'GPSImgDirection',
    0x0012: 'GPSMapDatum', 0x001d: 'GPSDateStamp',
  };

  const CANON = {
    0x0001: 'CameraSettings', 0x0002: 'FocalLength', 0x0003: 'FlashInfo', 0x0004: 'ShotInfo',
    0x0005: 'Panorama', 0x0006: 'ImageType', 0x0007: 'FirmwareVersion', 0x0008: 'FileNumber',
    0x0009: 'OwnerName', 0x000c: 'SerialNumber', 0x000d: 'CameraInfo', 0x000e: 'FileLength',
    0x000f: 'CustomFunctions', 0x0010: 'ModelID', 0x0011: 'MovieInfo', 0x0012: 'AFInfo',
    0x0013: 'ThumbnailImageValidArea', 0x0015: 'SerialNumberFormat', 0x001a: 'SuperMacro',
    0x001c: 'DateStampMode', 0x001d: 'MyColors', 0x001e: 'FirmwareRevision', 0x0023: 'Categories',
    0x0024: 'FaceDetect1', 0x0025: 'FaceDetect2', 0x0026: 'AFInfo2', 0x0027: 'ContrastInfo',
    0x0028: 'ImageUniqueID', 0x002f: 'FaceDetect3', 0x0035: 'TimeInfo', 0x0038: 'BatteryType',
    0x003c: 'AFInfo3', 0x0081: 'RawDataOffset', 0x0083: 'OriginalDecisionDataOffset',
    0x0090: 'CustomFunctions1D', 0x0091: 'PersonalFunctions', 0x0092: 'PersonalFunctionValues',
    0x0093: 'FileInfo', 0x0094: 'AFPointsInFocus1D', 0x0095: 'LensModel', 0x0096: 'InternalSerialNumber',
    0x0097: 'DustRemovalData', 0x0098: 'CropInfo', 0x0099: 'CustomFunctions2', 0x009a: 'AspectInfo',
    0x00a0: 'ProcessingInfo', 0x00a1: 'ToneCurveTable', 0x00a2: 'SharpnessTable',
    0x00a3: 'SharpnessFreqTable', 0x00a4: 'WhiteBalanceTable', 0x00a9: 'ColorBalance',
    0x00aa: 'MeasuredColor', 0x00ae: 'ColorTemperature', 0x00b0: 'CanonFlags', 0x00b1: 'ModifiedInfo',
    0x00b2: 'ToneCurveMatching', 0x00b3: 'WhiteBalanceMatching', 0x00b4: 'ColorSpace',
    0x00b6: 'PreviewImageInfo', 0x00d0: 'VRDOffset', 0x00e0: 'SensorInfo', 0x4001: 'ColorData',
    0x4002: 'CRWParam', 0x4003: 'ColorInfo', 0x4005: 'Flavor', 0x4008: 'PictureStyleUserDef',
    0x4009: 'PictureStylePC', 0x4010: 'CustomPictureStyleFileName', 0x4013: 'AFMicroAdj',
    0x4015: 'VignettingCorr', 0x4016: 'VignettingCorr2', 0x4018: 'LightingOpt', 0x4019: 'LensInfo',
    0x4020: 'AmbienceInfo', 0x4021: 'MultiExp', 0x4024: 'FilterInfo', 0x4025: 'HDRInfo',
    0x4026: 'LogInfo', 0x4028: 'AFConfig', 0x403f: 'RawBurstModeRoll',
  };

  const CIFF = {
    0x0000: 'NullRecord', 0x0001: 'FreeBytes', 0x0032: 'CanonColorInfo1', 0x0805: 'CanonFileDescription',
    0x080a: 'CanonMakeModel', 0x080b: 'CanonFirmwareVersion', 0x080c: 'ComponentVersion',
    0x080d: 'ROMOperationMode', 0x0810: 'OwnerName', 0x0815: 'CanonImageType', 0x0816: 'OriginalFileName',
    0x0817: 'ThumbnailFileName', 0x100a: 'TargetImageType', 0x1010: 'ShutterReleaseMethod',
    0x1011: 'ShutterReleaseTiming', 0x1016: 'ReleaseSetting', 0x101c: 'BaseISO', 0x1028: 'CanonFlashInfo',
    0x1029: 'FocalLength', 0x102a: 'CanonShotInfo', 0x102c: 'CanonColorInfo2', 0x102d: 'CanonCameraSettings',
    0x1030: 'WhiteSample', 0x1031: 'SensorInfo', 0x1033: 'CustomFunctions', 0x1038: 'CanonAFInfo',
    0x1093: 'CanonFileInfo', 0x10a9: 'ColorBalance', 0x10b4: 'ColorSpace', 0x10b5: 'RawJpgInfo',
    0x1803: 'ImageFormat', 0x1804: 'RecordID', 0x1806: 'SelfTimerTime', 0x1807: 'TargetDistanceSetting',
    0x180b: 'SerialNumber', 0x180e: 'TimeStamp', 0x1810: 'ImageInfo', 0x1813: 'FlashInfo',
    0x1814: 'MeasuredEV', 0x1817: 'FileNumber', 0x1818: 'ExposureInfo', 0x1834: 'CanonModelID',
    0x1835: 'DecoderTable', 0x183b: 'SerialNumberFormat', 0x2005: 'RawData', 0x2007: 'JpgFromRaw',
    0x2008: 'ThumbnailImage', 0x2804: 'ImageDescription', 0x2807: 'CameraObject', 0x3002: 'ShootingRecord',
    0x3003: 'MeasuredInfo', 0x3004: 'CameraSpecification', 0x300a: 'ImageProps', 0x300b: 'ExifInformation',
  };

  RL.TAGS = { EXIF, GPS, CANON, CIFF };

  // ------------------------------------------------------------ enums
  const ENUM = {
    Orientation: { 1: 'Horizontal (normal)', 2: 'Mirror horizontal', 3: 'Rotate 180', 4: 'Mirror vertical',
      5: 'Mirror horizontal, rotate 270 CW', 6: 'Rotate 90 CW', 7: 'Mirror horizontal, rotate 90 CW', 8: 'Rotate 270 CW' },
    Compression: { 1: 'Uncompressed', 6: 'Old-style JPEG', 7: 'JPEG', 99: 'Lossless JPEG' },
    ExposureProgram: { 0: 'Not defined', 1: 'Manual', 2: 'Program AE', 3: 'Aperture-priority AE',
      4: 'Shutter speed priority AE', 5: 'Creative (slow speed)', 6: 'Action (high speed)', 7: 'Portrait', 8: 'Landscape' },
    MeteringMode: { 0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot',
      5: 'Multi-segment', 6: 'Partial', 255: 'Other' },
    ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 0xffff: 'Uncalibrated' },
    ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
    WhiteBalance: { 0: 'Auto', 1: 'Manual' },
    SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
    ResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm' },
    FocalPlaneResolutionUnit: { 1: 'None', 2: 'inches', 3: 'cm', 4: 'mm', 5: 'um' },
    CustomRendered: { 0: 'Normal', 1: 'Custom' },
    SensitivityType: { 0: 'Unknown', 1: 'Standard Output Sensitivity', 2: 'Recommended Exposure Index',
      3: 'ISO Speed', 4: 'SOS and REI', 5: 'SOS and ISO', 6: 'REI and ISO', 7: 'SOS, REI and ISO' },
    PhotometricInterpretation: { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 6: 'YCbCr', 32803: 'CFA' },
  };

  const CANON_EXPOSURE_MODE = { 0: 'Easy', 1: 'Program AE', 2: 'Shutter speed priority AE',
    3: 'Aperture-priority AE', 4: 'Manual', 5: 'Depth-of-field AE', 6: 'M-Depth', 7: 'Bulb', 8: 'Flexible-priority AE' };
  const CANON_METERING = { 0: 'Default', 1: 'Spot', 2: 'Average', 3: 'Evaluative', 4: 'Partial',
    5: 'Center-weighted average' };
  const CANON_QUALITY = { 1: 'Economy', 2: 'Normal', 3: 'Fine', 4: 'RAW', 5: 'Superfine', 7: 'CRAW',
    130: 'Light (RAW)', 131: 'Standard (RAW)' };
  const CANON_FOCUS = { 0: 'One-shot AF', 1: 'AI Servo AF', 2: 'AI Focus AF', 3: 'Manual Focus',
    4: 'Single', 5: 'Continuous', 6: 'Manual Focus', 16: 'Pan Focus', 256: 'One-shot AF (Live View)',
    257: 'AI Servo AF (Live View)', 258: 'AI Focus AF (Live View)', 512: 'Movie Snap Focus' };
  const CANON_WB = { 0: 'Auto', 1: 'Daylight', 2: 'Cloudy', 3: 'Tungsten', 4: 'Fluorescent', 5: 'Flash',
    6: 'Custom', 7: 'Black & White', 8: 'Shade', 9: 'Manual Temperature (Kelvin)', 14: 'Daylight Fluorescent',
    17: 'Under Water', 18: 'White Fluorescent', 20: 'Custom 2', 23: 'Auto (white priority)' };
  RL.CANON_WB = CANON_WB;

  // --------------------------------------------------------- formatting
  const fmtNum = (v, d) => {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return String(+v.toFixed(d === undefined ? 4 : d));
  };
  RL.fmtNum = fmtNum;

  const NOMINAL = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250,
    200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3];
  RL.fmtShutter = function (t) {
    if (!(t > 0)) return '';
    if (t >= 0.3) return (+t.toFixed(1)) + ' s';
    let d = 1 / t;
    const near = NOMINAL.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
    if (Math.abs(near - d) / d < 0.06) d = near;
    return '1/' + Math.round(d) + ' s';
  };

  function valueToString(e, values) {
    if (typeof values === 'string') return values;
    const n = e.count;
    let parts = values.map((v) => fmtNum(v));
    let s = parts.slice(0, 16).join(', ');
    if (n > 16) s += ', ... (' + n + ' values)';
    return s;
  }

  const EXIF_FMT = {
    0x829a: (e) => { const r = RL.tagRational(e); return r && r[0] && r[1] ? (r[0] >= r[1] ? fmtNum(r[0] / r[1], 2) + ' s' : (r[0] === 1 ? '1/' + r[1] : '1/' + fmtNum(r[1] / r[0], 1)) + ' s') : ''; },
    0x829d: (e) => 'f/' + fmtNum(RL.tagValue(e), 1),
    0x9202: (e) => 'f/' + fmtNum(Math.pow(2, RL.tagValue(e) / 2), 1),
    0x9205: (e) => 'f/' + fmtNum(Math.pow(2, RL.tagValue(e) / 2), 1),
    0x9201: (e) => RL.fmtShutter(Math.pow(2, -RL.tagValue(e))),
    0x920a: (e) => fmtNum(RL.tagValue(e), 1) + ' mm',
    0x9204: (e) => { const v = RL.tagValue(e); return (v > 0 ? '+' : '') + fmtNum(v, 2) + ' EV'; },
    0x9209: (e) => { const v = RL.tagValue(e); return (v & 1 ? 'Fired' : 'Did not fire') + ' (0x' + v.toString(16) + ')'; },
    0x9000: (e) => String.fromCharCode(...RL.tagValues(e, 4)),
    0xa000: (e) => String.fromCharCode(...RL.tagValues(e, 4)),
    0x9286: (e) => { const v = RL.tagValues(e, 264); const s = String.fromCharCode(...v.slice(8)).replace(/\0+$/, '').trim(); return s || '(empty)'; },
    0xa432: (e) => { const v = RL.tagValues(e); return v.length === 4 ? `${fmtNum(v[0])}-${fmtNum(v[1])} mm f/${fmtNum(v[2], 1)}-${fmtNum(v[3], 1)}` : valueToString(e, v); },
  };
  const EXIF_ENUM = {
    0x0112: 'Orientation', 0x0103: 'Compression', 0x8822: 'ExposureProgram', 0x9207: 'MeteringMode',
    0xa001: 'ColorSpace', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa406: 'SceneCaptureType',
    0x0128: 'ResolutionUnit', 0xa210: 'FocalPlaneResolutionUnit', 0xa401: 'CustomRendered',
    0x8830: 'SensitivityType', 0x0106: 'PhotometricInterpretation',
  };

  /** Converts an IFD into display rows. */
  RL.describeIFD = function (ifd, dict, kind) {
    const rows = [];
    if (!ifd) return rows;
    for (const e of ifd.list) {
      const name = dict[e.tag] || ('Tag 0x' + e.tag.toString(16).padStart(4, '0'));
      let value;
      try {
        if (kind === 'exif' && EXIF_FMT[e.tag]) value = EXIF_FMT[e.tag](e);
        else if (kind === 'exif' && EXIF_ENUM[e.tag]) {
          const v = RL.tagValue(e);
          const t = ENUM[EXIF_ENUM[e.tag]];
          value = t && t[v] !== undefined ? t[v] : String(v);
        } else if ((e.type === 7 || e.type === 1) && e.count > 64) {
          value = '[' + e.count + ' bytes]';
        } else {
          value = valueToString(e, RL.tagValues(e, 17));
        }
      } catch (err) {
        value = '(unreadable)';
      }
      rows.push({ id: '0x' + e.tag.toString(16).padStart(4, '0'), name, type: RL.TIFF_TYPE_NAME[e.type] || e.type, count: e.count, value });
    }
    return rows;
  };

  // ----------------------------------------------- Canon structured tags
  /** Canon's APEX-like EV encoding with 1/3 stop fractions (ExifTool CanonEv). */
  RL.canonEv = function (v) {
    v = (v << 16) >> 16;
    let sign = 1;
    if (v < 0) { v = -v; sign = -1; }
    let frac = v & 0x1f;
    v -= frac;
    if (frac === 0x0c) frac = 0x20 / 3;
    else if (frac === 0x14) frac = 0x40 / 3;
    return sign * (v + frac) / 32;
  };

  // ------------------------------------------------------- lens lookup
  const LENS_RE = /(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?mm.*?(?:[fF]\/?)(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?/;
  /** 0 = no match, 1 = wide end matches, 2 = focal range matches, 3 = focal range and aperture match */
  function lensScore(name, shortF, longF, maxAp) {
    if (/ \+ \d/.test(name)) return 0; // teleconverter combinations
    const m = LENS_RE.exec(name);
    if (!m) return 0;
    const sf = +m[1], lf = m[2] ? +m[2] : sf, sa = +m[3], la = m[4] ? +m[4] : sa;
    if (Math.abs(shortF - sf) > 0.9) return 0;
    if (Math.abs(longF - lf) > 0.9) return 1;
    if (maxAp && (maxAp < sa - 0.18 || maxAp > la + 0.18)) return 2;
    return 3;
  }

  /**
   * Resolves CameraSettings LensType with the focal range and maximum aperture
   * the camera recorded, the way ExifTool's PrintLensID does. Old bodies
   * (D30, EOS-1D/1Ds) record only the low byte of the ID, the D60 and 10D none; for
   * those the lens is guessed from the optics alone.
   */
  RL.canonLens = function (id, shortF, longF, maxAp) {
    const T = RL.CANON_LENSES || [];
    const valid = id > 0 && id !== 0xffff;
    const idRows = valid ? T.filter((r) => Math.floor(+r[0]) === id) : [];
    const idName = idRows.length ? idRows[0][1] : '';
    const haveOptics = shortF > 0 && longF > 0;
    if (idRows.length && !haveOptics) return { name: idName, id, idName, source: 'id' };
    if (idRows.length) {
      const names = [];
      idRows.forEach((r, i) => {
        // the base entry may read "Canon EF xx or Sigma Lens"
        const parts = i === 0 ? r[1].split(' or ') : [r[1]];
        for (const p of parts) if (!names.includes(p)) names.push(p);
      });
      const scored = names.map((n) => [n, lensScore(n, shortF, longF, maxAp)]);
      const best = Math.max(...scored.map((s) => s[1]));
      if (best >= 2) return { name: scored.filter((s) => s[1] === best).map((s) => s[0]).join(' or '), id, idName, source: 'id' };
    }
    if (!haveOptics) return { name: '', id, idName, source: 'none' };
    // EOS D30, 1D and 1Ds store only the low byte of the 16 bit lens ID
    // (e.g. EF 16-35mm f/2.8L III USM, ID 751 = 0x2EF, is recorded as 239 = 0xEF)
    if (valid && id < 256) {
      const hits = [];
      for (const r of T) {
        const full = Math.floor(+r[0]);
        if (full < 256 || (full & 0xff) !== id) continue;
        for (const n of r[1].split(' or ')) {
          const s = lensScore(n, shortF, longF, maxAp);
          if (s >= 2 && !hits.some((h) => h[0] === n)) hits.push([n, s, full]);
        }
      }
      if (hits.length) {
        const best = Math.max(...hits.map((h) => h[1]));
        const top = hits.filter((h) => h[1] === best);
        return { name: top.map((h) => h[0]).join(' or '), id, idName, source: 'lowbyte',
          fullIds: [...new Set(top.map((h) => h[2]))] };
      }
    }
    // the ID is unknown or contradicts the optics: search by focal range and aperture
    const seen = new Set();
    let cands = [];
    for (const r of T) {
      for (const n of r[1].split(' or ')) {
        if (seen.has(n)) continue;
        seen.add(n);
        const s = lensScore(n, shortF, longF, maxAp);
        if (s >= 2) cands.push([n, s, +r[0]]);
      }
    }
    if (cands.some((c) => c[1] === 3)) cands = cands.filter((c) => c[1] === 3);
    // Canon lenses first, then by ID (older lenses have lower IDs)
    cands.sort((a, b) => (/^Canon/.test(b[0]) - /^Canon/.test(a[0])) || a[2] - b[2]);
    return { name: '', id, idName, source: 'optics', candidates: cands.map((c) => c[0]) };
  };

  /** CameraSettings (makernote 0x0001 / CIFF 0x102d) highlights. */
  RL.canonCameraSettings = function (cs) {
    const out = {};
    if (!cs || cs.length < 26) return out;
    const s16 = (v) => (v << 16) >> 16;
    out.quality = CANON_QUALITY[cs[3]];
    out.focusMode = CANON_FOCUS[cs[7]];
    out.metering = CANON_METERING[cs[17]];
    out.exposureMode = CANON_EXPOSURE_MODE[cs[20]];
    out.lensType = cs[22];
    const units = cs[25] || 1;
    if (cs[23] && cs[24]) {
      out.shortFocal = cs[24] / units;
      out.longFocal = cs[23] / units;
      const lo = out.shortFocal, hi = out.longFocal;
      out.focalRange = lo === hi ? fmtNum(lo, 1) + ' mm' : fmtNum(lo, 1) + '-' + fmtNum(hi, 1) + ' mm';
    }
    if (cs.length > 27 && cs[26] && cs[26] !== 0x7fff && cs[26] !== 0xffff) {
      out.maxApertureValue = Math.pow(2, RL.canonEv(s16(cs[26])) / 2);
      out.maxAperture = 'f/' + fmtNum(out.maxApertureValue, 1);
    }
    return out;
  };

  /** ShotInfo (makernote 0x0004) highlights. */
  RL.canonShotInfo = function (si) {
    const out = {};
    if (!si || si.length < 8) return out;
    const s16 = (v) => (v << 16) >> 16; // CRW records come as unsigned words
    if (si[2] !== 0x7fff && (si[1] || si[2])) out.realISO = Math.floor(100 * Math.pow(2, (si[1] + si[2]) / 32 - 5));
    out.wbIndex = si[7];
    // ExifTool: MeasuredEV (index 3) is really a light value, $val/32 + 5 for EOS
    // bodies (PowerShots may read up to 1 EV lower); MeasuredEV2 (23) is $val/8 - 6
    if (si[3]) out.measuredEV = s16(si[3]) / 32 + 5;
    if (si.length > 23 && si[23]) out.measuredEV2 = (si[23] & 0xffff) / 8 - 6;
    // CameraTemperature (12): $val - 128, newer EOS bodies only, 0 when not recorded
    if (si.length > 12 && si[12]) out.temperature = (si[12] & 0xffff) - 128;
    return out;
  };

  /**
   * Shutter count, where Canon records it (locations from ExifTool Canon.pm):
   * FileInfo (0x0093) bytes 2-5 for the EOS-1D / 1Ds (big-endian files) and,
   * with the 16-bit halves swapped, the 1D / 1Ds Mark II (N); CameraInfo (0x000d)
   * for the 1D Mark III, R5 / R6, R6 Mark II / R8 / R50 and the G5 X Mark II CR3.
   * fileInfo / cameraInfo are raw IFD entries ({ r, valOff, bytes }).
   */
  RL.canonShutterCount = function (model, format, fileInfo, cameraInfo) {
    const m = String(model || '');
    const u32 = (e, o) => (e && o + 4 <= e.bytes ? e.r.u32(e.valOff + o) >>> 0 : undefined);
    let v, note = '';
    if (/\b1Ds? Mark II\b/i.test(m)) {
      v = u32(fileInfo, 2);
      if (v !== undefined) v = ((v >>> 16) | ((v & 0xffff) << 16)) >>> 0;
    } else if (/EOS-1DS?$/i.test(m)) {
      if (fileInfo && !fileInfo.r.le) v = u32(fileInfo, 2);
    } else if (/\b1Ds? Mark III$/i.test(m)) {
      v = u32(cameraInfo, 0x176);
      if (v !== undefined) v += 1;
      note = 'ExifTool: reliable only on some Mark III copies';
    } else if (/\bEOS R[56]$/i.test(m)) {
      v = u32(cameraInfo, 0x0af1); note = 'electronic and mechanical shutter';
    } else if (/\bEOS (R6m2|R6 Mark II|R8|R50)$/i.test(m)) {
      v = u32(cameraInfo, 0x0d29); note = 'electronic and mechanical shutter';
    } else if (/G5 X Mark II$/i.test(m) && format === 'CR3') {
      v = u32(cameraInfo, 0x0a95); note = 'electronic and mechanical shutter';
    } else return null;
    if (v === undefined) return null;
    if (!v || v > 5e7) return { value: null, note: 'field present but empty or implausible (' + v + ')' };
    return { value: v, note };
  };

  /** Scene brightness as a light value (LV at ISO 100) -> rough luminance and a description. */
  RL.describeLV = function (lv) {
    const cd = Math.pow(2, lv - 3); // L = 2^LV * K / 100 with the meter constant K = 12.5
    const lum = cd >= 100 ? Math.round(cd).toLocaleString('en-US') : cd >= 1 ? cd.toFixed(1) : cd.toFixed(2);
    const scenes = [[-2, 'night, moonlight'], [2, 'night street, dim interior'], [5, 'home interior'], [8, 'bright interior, dusk'],
      [11, 'overcast daylight, open shade'], [13, 'cloudy bright, hazy sun'], [15, 'full sun'], [99, 'sun on snow or sand']];
    let label = scenes[0][1];
    for (const [hi, t] of scenes) { label = t; if (lv < hi) break; }
    return `≈ ${lum} cd/m², typical of ${label}`;
  };

  /** SensorInfo (makernote 0x00e0 / CIFF 0x1031). */
  RL.canonSensorInfo = function (v) {
    if (!v || v.length < 9) return null;
    const si = { width: v[1], height: v[2], left: v[5], top: v[6], right: v[7], bottom: v[8] };
    if (v.length >= 13) si.mask = { left: v[9], top: v[10], right: v[11], bottom: v[12] };
    return si;
  };

  /**
   * ColorData (makernote 0x4001): as-shot WB plus black and white levels.
   * Offsets per version from LibRaw parseCanonMakernotes. Values are RGGB.
   */
  RL.canonColorData = function (cd, count) {
    const len = count || cd.length;
    const sub = cd[0];
    let asShot = 0, black = 0, white = 0, black2 = 0;
    switch (len) {
      case 582: asShot = 0x19; black = 0xa6; break;
      case 653: asShot = 0x22; black = 0x11e; break;
      case 796: asShot = 0x3f; black = 0xc4; break;
      case 674: case 692: case 702: case 1227: case 1250: case 1251: case 1337: case 1338: case 1346:
        asShot = 0x3f;
        if (sub === 4 || sub === 5) { black = 0x2b4; white = 0x2b8; }
        else if (sub === 6 || sub === 7) { black = 0x2cb; white = 0x2cf; }
        else if (sub === 9) { black = 0x2cf; white = 0x2d3; }
        else black = 0xe7;
        break;
      case 5120:
        asShot = 0x47;
        if (sub === 0xfffc) { black = 0x14d; white = 0x569; }
        else if (sub === 0xfffd) black = 0x108;
        break;
      case 1273: case 1275: asShot = 0x3f; black = 0x1df; white = 0x1e3; break;
      case 1312: case 1313: case 1316: case 1506:
        asShot = 0x3f;
        if (sub === 10) { black = 0x1f8; white = 0x1fc; }
        else if (sub === 11) { black = 0x2d8; white = 0x2dc; }
        break;
      case 1560: case 1592: case 1353: case 1602:
        asShot = 0x3f;
        if (sub === 14) { black = 0x22c; white = 0x230; } else { black = 0x30a; white = 0x30e; }
        break;
      case 1820: case 1824: case 1816:
        asShot = 0x47; black2 = 0x47 + 0x102; black = 0x47 + 0x2d1; white = 0x47 + 0x2d5; break;
      case 1770: case 2024: case 3656:
        asShot = 0x55; black2 = 0x55 + 0x102; black = 0x55 + 0x2d1; white = 0x55 + 0x2d5; break;
      case 3973: case 3778:
        asShot = 0x69; black2 = 0x69 + 0x102; black = 0x69 + 0x213; white = 0x69 + 0x217; break;
      case 4528:
        asShot = 0x69; black2 = 0x69 + 0x116; black = 0x69 + 0x227; white = 0x69 + 0x22b; break;
      default:
        return { version: sub, length: len };
    }
    const q = (o) => (o + 3 < cd.length ? [cd[o], cd[o + 1], cd[o + 2], cd[o + 3]] : null);
    const res = { version: sub, length: len };
    if (asShot) res.asShotRGGB = q(asShot);
    let bl = black ? q(black) : null;
    if ((!bl || !(bl[0] + bl[1] + bl[2] + bl[3])) && black2) bl = q(black2);
    if (bl && bl[0] + bl[1] + bl[2] + bl[3]) res.blackRGGB = bl;
    if (white && white + 1 < cd.length) { res.normalWhite = cd[white]; res.specularWhite = cd[white + 1]; }
    return res;
  };

  /** Color matrix and level table (prefix match, like LibRaw adobe_coeff). */
  RL.canonColorEntry = function (model, modelId) {
    const byId = modelId !== undefined && RL.CANON_MODEL_IDS && RL.CANON_MODEL_IDS[parseInt(modelId, 16)];
    const m = (byId || model || '').replace(/^Canon\s+/i, '').trim().toLowerCase();
    for (const e of RL.CANON_COLOR) {
      if (m.startsWith(e[0].toLowerCase())) return { prefix: e[0], black: e[1], white: e[2], matrix: e[3] };
    }
    return null;
  };
});
