# Raw Analyzer

A RawDigger-style raw file inspector for Canon cameras that runs entirely in the
browser. Open `index.html` (double-click it, or serve the folder with any static
web server) and drop a raw file onto the window. Nothing is uploaded anywhere.

## Supported files

| Format | Cameras | Notes |
|---|---|---|
| CRW (CIFF) | EOS D30, D60, 10D, 300D, PowerShots with CRW | 10 and 12 bit, Canon Huffman compression |
| TIF / renamed CRW | EOS-1D, EOS-1Ds | lossless JPEG raw referenced from the maker note |
| CR2 | CR2 bodies (lossless JPEG with slices) | sRAW / mRAW are rejected (they hold YCbCr, not sensor data) |
| CR3 | CR3 bodies | CRX lossless and C-RAW (wavelet) code paths are both ported |

Files are detected by content, not by extension. The CFA layout of CR2 files
comes from LibRaw's Canon geometry table and is cross-checked against the pixel
data. Bodies with an odd image-area margin (EOS 5D Mark II, 50D, 7D, 550D/600D/60D,
1D Mark IV, ...) start their raw frame with a G-B row instead of R-G.

Headerless CHDK `.CRW` dumps are not supported, and neither is the PowerShot Pro70
(no SensorInfo, 4-row CMYG pattern). CMYG PowerShots with a 2×2 pattern (G1,
Pro90 IS) are decoded with their G/M/C/Y channels and rendered through LibRaw's
4-colour matrix.

Tested pixel-for-pixel against LibRaw on 75 files from 60+ bodies, including the
rawsamples.ch Canon collection: EOS 300D to 1200D, 20D to 80D, 5D to 5DS, 6D, 7D,
1D Mark II to 1D X, 1Ds to 1Ds Mark III, EOS M/M3, R5, and PowerShots from the G1
to the G16, S30 to S120, SX1/SX50/SX60 and Pro1.

## Features

- **Histograms** per CFA channel (R, G, B, G2) plus the combined histogram, at full
  16 bit resolution. Overlay or per channel layout, linear or log Y, linear raw
  values or EV below saturation, adjustable bin width, optional black subtraction,
  hover read-out, CSV and PNG export.
- **Areas**: image (active) area, full sensor, the masked optical-black border, or
  any rectangle selected on the image (Select tool or Shift+drag).
- **Statistics**: min, max, mean, median, σ, percentiles, clipped and below-black
  pixel counts, positions in EV relative to saturation, exposure headroom, read
  noise from the masked border and an engineering dynamic range estimate.
- **Shadows and noise floor**: read noise per channel from the masked border (or
  estimated from flat dark image areas when there is no border), noise floor in EV,
  engineering dynamic range, share of pixels below 1, 2, 4 and 10 sigma, shadow SNR,
  a noise-floor marker in the histogram, and a viewer overlay for near-floor areas.
- **Pattern noise (banding)**: row and column noise from the masked border,
  separated from random noise (differences of neighbouring lines, so gradients
  such as amp glow do not count), per channel and relative to the random noise,
  with a verdict on visible banding. Weak banding is reported as an upper limit
  when the strip is too small to detect it, and border strips read at a different
  level than the black level (the 50D's top border) are left out.
- **Hot, stuck and dead pixels** in the image area: a pixel is flagged when its 8
  nearest same-colour neighbours agree with each other and it differs from all of
  them by more than the local noise allows. Counts per channel, the strongest
  defects (click to zoom in), an overlay on the image and CSV export. On a dark frame
  the counts describe the sensor; in a normal photo they are a lower bound.
- **Sensor estimate (photon transfer)** from a single image: noise versus signal
  measured on flat 8×8 same-colour patches, fitted to noise² = read² + signal/gain.
  Shows gain (e⁻/DN, also scaled to ISO 100), read noise in electrons, full-well
  capacity, the range down to SNR 1 / 4 / 10 / 20, and a shadow-push table (SNR of
  mid-tones and shadows after pushing 1–5 EV). One frame typically lands within
  ±25% of a multi-frame average; busy scenes read low.
- **Compare two files**: *Compare with…* opens a second raw file next to the
  current one. The Compare tab lists both side by side (exposure, scene brightness,
  read noise, gain, full well, dynamic range, banding, defects, with differences in
  EV) and overlays their histograms on an EV scale, so bodies with different bit
  depths compare directly. *Swap A and B* shows the other file in the viewer.
- **Folder scan**: *Scan folder…* lists every raw file in a folder and its
  subfolders: date, camera, lens, focal length, exposure, meter reading, shutter
  count, camera temperature, median and brightest levels and clipping. Files are
  decoded on several worker threads (about 40 mixed files in 7 s). Sort by any
  column, filter, export CSV, or click a row to open the file.
- **Levels**: black level per channel and saturation level. Defaults come from
  Canon ColorData, the masked border, LibRaw's camera table, or clipping detected
  in the data (including the D30/D60 sensors, whose clipped pixels spread over a few
  codes). They can be edited.
- **Lens identification**: Canon LensType IDs resolved with ExifTool's table and
  checked against the focal range and maximum aperture the camera recorded. Early
  bodies (EOS D30, EOS-1D, EOS-1Ds) record only the **low byte** of the
  16 bit lens ID: the EF 16-35mm f/2.8L III USM (ID 751 = 0x2EF) appears as 239 = 0xEF.
  The lookup tries every ID with that low byte and keeps the lenses that match the
  recorded optics. Verified on 1,140 files from a D30, 1D and 1Ds against known
  lenses: EF 16-35 f/2.8L III, 35 f/2 IS, 40 f/2.8 STM, 50 f/1.8 STM, 100 f/2.8L Macro
  IS, 135 f/2L, EF-S 24 f/2.8 STM, Sigma 18-35 and 50-100 Art, and Sigma 150-600.
  The EOS D60 and 10D record no lens ID at all (65535), only the focal range and
  maximum aperture, so for them the lens is always guessed from the optics and
  labelled as such. The same applies when nothing matches.
- **Viewer**: RGB render (camera colour matrix, as-shot / gray-world / picked WB),
  raw CFA mosaic, single channel views, clipped and below-black overlays,
  masked border view, zoom to 3200 %, pixel read-out of the 2×2 CFA block under
  the cursor.
- **Demosaicing**: below 100 % zoom the preview draws each 2×2 CFA block as one
  pixel. From 100 % the visible area plus a margin is demosaiced with AHD (default),
  PPG or bilinear, chosen under *Detail ≥100%* (ports of LibRaw, bit-exact against
  it), in strips on a pool of Web Workers (one per CPU core, up to 12). CMYG sensors
  always use bilinear.
- **Export image** (Ctrl+E): full-size or selection, demosaiced with AHD, PPG or
  bilinear, with the current white balance and exposure, as JPEG, PNG 8/16 bit or
  16-bit TIFF (deflate + predictor), in sRGB or Adobe RGB (1998). Files carry an
  ICC profile and Exif (camera, exposure, lens, date) and are rotated as shot.
  A 45 MP EOS R5 frame takes about 4 s with AHD on an 8-thread CPU.
- **DNG export**: the untouched raw frame as a DNG 1.4 file with the CFA pattern,
  per-channel black levels, white level, image area, masked areas, the camera colour
  matrix (D65), the current white balance as shot, Exif and a small preview. Opens in
  Lightroom, Camera Raw, darktable, RawTherapee and anything built on LibRaw, which
  makes old CRW and EOS-1D TIF files usable in software that never supported them.
  LibRaw reads back identical raw data, levels, white balance and colour (checked in
  the tests). Not offered for 4-colour CMYG sensors.
- **Metadata**: summary (camera, lens, exposure, mode, metering, focus, WB, serial,
  owner, firmware, GPS), and every IFD0 / EXIF / GPS / Canon maker note / CIFF /
  CR3 CTMD tag, searchable.
- **Shutter count** where Canon records it in raw files (locations from ExifTool):
  EOS-1D, 1Ds, 1D / 1Ds Mark II (N) and Mark III, R5, R6, R6 Mark II, R8, R50 and
  the G5 X Mark II. Most other bodies keep it only inside the camera.
- **Scene brightness**: the camera's meter reading (Canon ShotInfo MeasuredEV, a
  light value at ISO 100, or EXIF BrightnessValue) with an approximate luminance,
  next to the light value the exposure settings imply, plus the camera temperature
  on EOS bodies that record it.
- **Embedded images**: full-size preview JPEGs and thumbnails, viewable and saveable.

Viewer and histogram options, the open side-panel tab and the export settings are
remembered in the browser between sessions.

## Keyboard and mouse

Wheel zooms at the cursor; `+` / `-` zoom; `0` toggles fit / 100 %; double-click fits;
drag pans (or hold Space); Shift+drag selects an area; Esc clears the selection;
Ctrl+O opens a file; Ctrl+E exports the image.

## Layout

```
index.html            page
css/app.css           styles
js/raw/*.js           decoders (run in a Web Worker)
  core.js             binary reader, TIFF IFD parser
  ljpeg.js            lossless JPEG (CR2, EOS-1D TIF)
  crw.js              CIFF parser + Canon CRW decoder
  crx.js              CR3 CRX decoder (lossless and wavelet C-RAW)
  cr3.js              CR3 ISO-BMFF container, CTMD metadata
  meta.js             tag names, Canon maker note interpretation
  canon-color.js      colour matrices and level table
  canon-lenses.js     lens ID table (ExifTool)
  canon-geometry.js   raw frame margins and CFA phase per Canon raw size (LibRaw)
  decode.js           format detection, metadata, levels, summary
  demosaic.js         bilinear, PPG, AHD (LibRaw ports) and the develop step
js/app/*.js           user interface
  scan.js             folder scan (worker pool, table, CSV)
  demosaic-host.js    worker pool: strips with overlap, parallel demosaic/develop
  export.js           export dialog, PNG/TIFF/JPEG writers, ICC profiles, Exif
  tiffwriter.js       TIFF structure writer (IFD trees, data blocks)
  dng.js              DNG writer
```

The decoders were verified pixel-for-pixel against LibRaw (via `rawpy` 0.27) on
CRW (D30, 10D), EOS-1D and 1Ds TIF, CR2 (80D, G1 X Mark II, G7 X) and a C-RAW
CR3 (R5, 3 wavelet levels). The lossless CR3 variant shares the same line
decoders but has not been checked against a sample file yet. The demosaic ports
give the same 16-bit values as LibRaw's (raw colour output) on D30, 10D, 1D, 1Ds,
1000D, 50D, 7D, 80D and R5 files, including the image edges.

The checks can be re-run with the scripts and test page in [tests/](tests/README.md).

Colour matrices are looked up by Canon's model ID, so regional names such as
"EOS DIGITAL REBEL XS" or "EOS Kiss X3" get the matrix of the EOS 1000D / 500D.

## Licence

Copyright (C) 2026 Jan Tichavský.

Raw Analyzer is free software under the GNU Lesser General Public License,
version 2.1 or (at your option) any later version. See [LICENSE](LICENSE).

## Credits

The decoding and demosaicing algorithms are ports of [dcraw](https://www.dechifro.org/dcraw/)
by Dave Coffin and [LibRaw](https://www.libraw.org/) (CRX decoder by Alexey Danilchenko
and Alex Tutubalin; AHD after Hirakawa and Parks), and the colour matrices, Canon model
IDs and raw geometry come from LibRaw's tables. LibRaw is available under LGPL 2.1 or
CDDL 1.0; the ported files in `js/raw/` are used under the LGPL 2.1.

The lens ID table in `js/raw/canon-lenses.js` is extracted from
[ExifTool](https://exiftool.org/) by Phil Harvey, distributed under the same terms as
Perl itself. The locations of the shutter count and the meter reading in Canon maker
notes also follow ExifTool's documentation.

`examples/CRW_2211.CRW` is a sample from an EOS D30 for trying the app. More Canon raw
samples are available at [rawsamples.ch](https://rawsamples.ch/).
