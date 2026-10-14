"""Builds LibRaw reference data for the browser tests (tests/ref/).

For every sample: raw frame size, per-row pixel sums, CFA pattern, LibRaw's image
area, black and white levels, and for RGB Bayer files 16-bit camera-RGB crops of
LibRaw's bilinear, PPG and AHD output (centre and two corners of the image area).

    python tests/make_refs.py            # all samples (skips up-to-date ones)
    python tests/make_refs.py NAME ...   # selected samples, always rebuilt
"""
import json, os, sys
import numpy as np
import rawpy
from samples import samples, HERE

REF = os.path.join(HERE, 'ref')
XYZ_RGB = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
ALGOS = {'bilinear': rawpy.DemosaicAlgorithm.LINEAR, 'ppg': rawpy.DemosaicAlgorithm.PPG, 'ahd': rawpy.DemosaicAlgorithm.AHD}
WB = [2.1, 1.0, 1.45, 1.0]  # fixed, so every body gets a real colour scale


def rgb_cam(r):
    """LibRaw cam_xyz_coeff: camera -> sRGB with normalised rows, stored as float32."""
    cam_xyz = np.asarray(r.rgb_xyz_matrix, float)[:3]
    cam_rgb = cam_xyz @ XYZ_RGB
    cam_rgb /= cam_rgb.sum(axis=1, keepdims=True)
    return np.linalg.inv(cam_rgb).astype(np.float32).astype(float).tolist()


def build(name, path):
    with rawpy.imread(path) as r:
        raw = r.raw_image.astype(np.int64)
        s = r.sizes
        ref = dict(name=name, w=raw.shape[1], h=raw.shape[0], rows=raw.sum(axis=1).tolist(),
                   cfa=r.raw_colors[0:2, 0:2].ravel().tolist(), colors=int(r.num_colors),
                   left=s.left_margin, top=s.top_margin, width=s.width, height=s.height,
                   black=list(map(int, r.black_level_per_channel)), white=int(r.white_level))
        bayer3 = ref['colors'] == 3 and r.raw_pattern is not None and r.raw_pattern.shape == (2, 2)
        if bayer3:
            ref['rgb_cam'] = rgb_cam(r)
    if bayer3:
        W, H = ref['width'], ref['height']
        crops = [(W // 2 - 128, H // 2 - 128, 256, 256), (0, 0, 64, 64), (W - 64, H - 64, 64, 64)]
        ref.update(wb=WB, crops=crops, algos=list(ALGOS))
        for an, a in ALGOS.items():
            with rawpy.imread(path) as r:
                out = r.postprocess(demosaic_algorithm=a, output_color=rawpy.ColorSpace.raw, gamma=(1, 1),
                                    no_auto_bright=True, output_bps=16, user_flip=0, user_wb=WB,
                                    adjust_maximum_thr=0.0, highlight_mode=rawpy.HighlightMode.Clip,
                                    half_size=False, four_color_rgb=False)
            parts = [np.ascontiguousarray(out[y:y + h, x:x + w, :3]).astype('<u2').tobytes() for x, y, w, h in crops]
            open(os.path.join(REF, f'{name}.{an}.bin'), 'wb').write(b''.join(parts))
    json.dump(ref, open(os.path.join(REF, name + '.json'), 'w'))
    return ref


def main(args):
    os.makedirs(REF, exist_ok=True)
    all_samples = samples()
    names = args or sorted(all_samples)
    for name in names:
        path = all_samples.get(name)
        if not path:
            print('unknown sample', name)
            continue
        target = os.path.join(REF, name + '.json')
        if not args and os.path.exists(target) and os.path.getmtime(target) >= os.path.getmtime(path):
            continue
        try:
            ref = build(name, path)
            print(f"{name}: {ref['w']}x{ref['h']}, cfa {ref['cfa']}, black {ref['black']}, white {ref['white']}"
                  + (', demosaic crops' if 'crops' in ref else ''))
        except Exception as e:  # LibRaw cannot open it (CHDK dumps, sRAW, ...)
            json.dump(dict(name=name, error=str(e)), open(target, 'w'))
            print(f'{name}: LibRaw error: {e}')


if __name__ == '__main__':
    main(sys.argv[1:])
