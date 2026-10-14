"""Checks the files written by the export test (tests/out/) with independent
decoders: tifffile, imagecodecs, Pillow with LittleCMS, and rawpy (LibRaw) for the
colour pipeline. Called by server.py; returns a text report."""
import io, os
import numpy as np


def lin_srgb(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def undo_orientation(img, orient):
    return {3: lambda a: np.rot90(a, 2), 6: lambda a: np.rot90(a, 1), 8: lambda a: np.rot90(a, -1)}.get(orient, lambda a: a)(img)


def check(out_dir, meta):
    import tifffile, imagecodecs, rawpy
    from PIL import Image, ImageCms
    lines, fails = [], 0

    def result(ok, text):
        nonlocal fails
        fails += 0 if ok else 1
        lines.append(('PASS ' if ok else 'FAIL ') + text)

    f = lambda n: os.path.join(out_dir, n)
    # 16-bit TIFF
    tif = tifffile.imread(f('srgb.tif'))
    with tifffile.TiffFile(f('srgb.tif')) as t:
        pg = t.pages[0]
        icc = bytes(pg.tags['InterColorProfile'].value) if 'InterColorProfile' in pg.tags else b''
        exif = pg.tags['ExifTag'].value if 'ExifTag' in pg.tags else {}
        result(tif.dtype == np.uint16 and tif.ndim == 3 and pg.compression.name == 'ADOBE_DEFLATE' and pg.predictor.name == 'HORIZONTAL',
               f'TIFF {tif.shape[1]}x{tif.shape[0]} {tif.dtype}, {pg.compression.name}, predictor {pg.predictor.name}')
        desc = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else ''
        result(bool(desc), f'TIFF ICC profile parses in LittleCMS: "{desc}"')
        result('Make' in pg.tags and bool(exif), f"TIFF Make {pg.tags['Make'].value if 'Make' in pg.tags else '?'}, Exif {sorted(exif)[:4]}...")
    # 16-bit PNG must hold the same pixels
    png16 = imagecodecs.png_decode(open(f('srgb16.png'), 'rb').read())
    result(png16.shape == tif.shape and np.array_equal(png16, tif), 'PNG 16-bit identical to the TIFF')
    # 8-bit files: ICC and Exif
    for n in ('srgb.jpg', 'adobe.jpg', 'adobe8.png'):
        im = Image.open(f(n))
        icc = im.info.get('icc_profile')
        desc = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else ''
        ex = im.getexif()
        result(bool(desc) and bool(ex.get(271)), f'{n} {im.size[0]}x{im.size[1]}: ICC "{desc}", Exif {ex.get(271)} {ex.get(272)}')
    # Adobe RGB converted to sRGB by LittleCMS ~ the lossless sRGB export (8-bit rounding allowed)
    srgb = tif.astype(float) / 257
    ad = Image.open(f('adobe8.png'))
    conv = np.asarray(ImageCms.profileToProfile(ad, ImageCms.ImageCmsProfile(io.BytesIO(ad.info['icc_profile'])),
                                                ImageCms.createProfile('sRGB'), outputMode='RGB')).astype(float)
    m = (srgb.max(axis=2) < 245) & (srgb.min(axis=2) > 10)
    d = np.abs(conv - srgb)[m].mean()
    result(d < 1.5, f'Adobe RGB 8-bit export -> sRGB (LittleCMS) vs 16-bit sRGB export: mean |diff| {d:.2f} levels')
    # colour pipeline against LibRaw: linear sRGB, same white balance and white level
    if not meta.get('hasMatrix'):
        lines.append('SKIP LibRaw colour comparison: no colour matrix for this camera')
    elif meta.get('colors4'):
        lines.append('SKIP LibRaw colour comparison: LibRaw scales 4-colour (CMYG) output differently')
    elif meta.get('path'):
        with rawpy.imread(meta['path']) as r:
            # LibRaw's user_sat replaces the white level after black subtraction, so pass
            # it (minus LibRaw's common black) only when our white level differs
            kw = {}
            if meta['white'] != r.white_level:
                kw['user_sat'] = int(meta['white'] - min(r.black_level_per_channel))
                lines.append(f"note: white level {meta['white']} (LibRaw {r.white_level}) forced in LibRaw")
            ref = r.postprocess(demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD, output_color=rawpy.ColorSpace.sRGB,
                                gamma=(1, 1), no_auto_bright=True, output_bps=16, user_flip=0, user_wb=meta['wb'],
                                adjust_maximum_thr=0.0, highlight_mode=rawpy.HighlightMode.Clip, **kw).astype(float) / 65535
            s = r.sizes
        ours = lin_srgb(undo_orientation(tif, meta.get('orient', 1)).astype(float) / 65535)
        a = meta['active']
        ex, ey = a['left'] - s.left_margin, a['top'] - s.top_margin
        # the two image areas may differ by a few pixels: compare where they overlap
        def overlap(dx, dy):
            h = min(ours.shape[0], ref.shape[0] - dy) if dy >= 0 else min(ours.shape[0] + dy, ref.shape[0])
            w = min(ours.shape[1], ref.shape[1] - dx) if dx >= 0 else min(ours.shape[1] + dx, ref.shape[1])
            a = ours[max(0, -dy):max(0, -dy) + h, max(0, -dx):max(0, -dx) + w]
            b = ref[max(0, dy):max(0, dy) + h, max(0, dx):max(0, dx) + w]
            return a, b
        best = None
        for dy in range(ey - 2, ey + 3):
            for dx in range(ex - 2, ex + 3):
                a, b = overlap(dx, dy)
                if a.shape[0] < ours.shape[0] - 8 or a.shape[1] < ours.shape[1] - 8:
                    continue
                e = np.abs(a[::4, ::4] - b[::4, ::4]).mean()
                if best is None or e < best[0]:
                    best = (e, dx, dy)
        if best is None:
            result(False, 'LibRaw comparison: image areas do not overlap as expected')
        else:
            e, dx, dy = best
            mine, sub = overlap(dx, dy)
            m = (sub.max(axis=2) < 0.8) & (sub.min(axis=2) > 0.02)
            ratio = [float(np.median(mine[..., c][m] / sub[..., c][m])) for c in range(3)]
            result(e < 0.004 and all(0.97 < q < 1.03 for q in ratio),
                   f'linear sRGB vs LibRaw AHD: mean |diff| {e:.4f}, channel ratios {", ".join(f"{q:.3f}" for q in ratio)} (offset {dx},{dy})')
    # DNG: LibRaw must read back the same raw data, levels, white balance and matrix
    if os.path.exists(f('raw.dng')) and meta.get('path') and not meta.get('colors4'):
        with rawpy.imread(f('raw.dng')) as d, rawpy.imread(meta['path']) as o:
            rd, ro = d.raw_image.astype(np.int64), o.raw_image.astype(np.int64)
            a = meta['active']
            result(rd.shape == ro.shape and np.array_equal(rd, ro), f'DNG raw data identical to the original ({rd.shape[1]}x{rd.shape[0]})')
            g = lambda c: np.where(c == 3, 1, c)
            cd = g(d.raw_colors[a['top']:a['top'] + 2, a['left']:a['left'] + 2])
            co = g(o.raw_colors[a['top']:a['top'] + 2, a['left']:a['left'] + 2])
            result(np.array_equal(cd, co), f'DNG CFA pattern at the image area {cd.ravel().tolist()} (original {co.ravel().tolist()})')
            s = d.sizes
            # LibRaw moves an image area that starts on an odd row or column by one pixel
            want = (a['left'], a['top'], a['right'] - a['left'], a['bottom'] - a['top'])
            got = (s.left_margin, s.top_margin, s.width, s.height)
            result(all(abs(x - y) <= 1 for x, y in zip(got, want)),
                   f'DNG image area {s.width}x{s.height} at {s.left_margin},{s.top_margin} (app {want[2]}x{want[3]} at {want[0]},{want[1]})')
            bl = list(d.black_level_per_channel)
            result(all(abs(x - y) <= 1 for x, y in zip(sorted(bl), sorted(meta['black']))) and d.white_level == meta['white'],
                   f'DNG black {bl} (app {meta["black"]}), white {d.white_level} (app {meta["white"]})')
            wb = np.array(d.camera_whitebalance[:3], float); wb /= wb[1]
            want = np.array(meta['wb'][:3], float); want /= want[1]
            result(np.allclose(wb, want, rtol=1e-3), f'DNG as-shot white balance {np.round(wb, 4).tolist()} (app {np.round(want, 4).tolist()})')
            if meta['raw']['matrix']:
                # LibRaw keeps DNG matrices internally; the daylight balance it derives from them must match
                dd = np.array(d.daylight_whitebalance[:3]); do = np.array(o.daylight_whitebalance[:3])
                result(np.allclose(dd / dd[1], do / do[1], rtol=1e-3), f'DNG colour matrix: daylight balance {np.round(dd / dd[1], 4).tolist()} (original {np.round(do / do[1], 4).tolist()})')
            kw = dict(demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD, output_color=rawpy.ColorSpace.sRGB, gamma=(1, 1), no_auto_bright=True,
                      output_bps=16, user_flip=0, adjust_maximum_thr=0.0, highlight_mode=rawpy.HighlightMode.Clip)
            pd = d.postprocess(use_camera_wb=True, **kw).astype(float)
            cw = list(d.camera_whitebalance[:3]) + [d.camera_whitebalance[1]]
        with rawpy.imread(meta['path']) as o:
            extra = {} if meta['white'] == o.white_level else {'user_sat': int(meta['white'] - min(o.black_level_per_channel))}
            po = o.postprocess(user_wb=cw, **kw, **extra).astype(float)
            so = o.sizes
        dy, dx = s.top_margin - so.top_margin, s.left_margin - so.left_margin
        h, w = min(pd.shape[0], po.shape[0] - dy), min(pd.shape[1], po.shape[1] - dx)
        A, B = pd[8:h - 8, 8:w - 8], po[dy + 8:dy + h - 8, dx + 8:dx + w - 8]
        m = (B.max(axis=2) < 60000) & (B.min(axis=2) > 500)
        ratio = [float(np.median(A[..., c][m] / B[..., c][m])) for c in range(3)]
        result(all(0.97 < q < 1.03 for q in ratio), f'DNG develops like the original in LibRaw (sRGB, as-shot WB): channel ratios {", ".join(f"{q:.3f}" for q in ratio)}')
    lines.append(f'{fails} failed' if fails else 'all export checks passed')
    return '\n'.join(lines)
