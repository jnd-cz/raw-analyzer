# Tests

The decoders, demosaicing and export are checked against LibRaw (through
[rawpy](https://github.com/letmaik/rawpy)) and independent image readers. The tests
run in the browser, served by a small Python server.

## Setup (once)

```
python -m venv .venv
.venv\Scripts\pip install -r tests\requirements.txt        (Windows)
.venv/bin/pip install -r tests/requirements.txt            (Linux, macOS)
```

## Sample files

`examples/` is always used. Add more raw files to `tests/samples/`, or list files
and folders in `tests/samples.txt` (one per line, `#` starts a comment, relative
paths are relative to the repository root). Neither is committed. The Canon set
from [rawsamples.ch](https://rawsamples.ch/index.php/en/canon) covers 60+ bodies.

## Running

1. Build the LibRaw references (only new or changed samples are processed):

   ```
   .venv\Scripts\python tests\make_refs.py
   ```

2. Start the server and open the test page:

   ```
   .venv\Scripts\python tests\server.py
   ```

   then http://127.0.0.1:8765/tests/run.html

3. **Run tests** checks every sample:
   - *Decode*: raw frame size, every row's pixel sum and the CFA pattern equal
     LibRaw's; black levels within 2 DN of LibRaw (otherwise a warning).
   - *Demosaic*: bilinear, PPG and AHD output equal LibRaw's bit for bit on three
     crops (centre and two corners of the image area).
   - *Snapshot*: metadata summary, levels, image area, noise and channel statistics
     equal the stored snapshot. After an intended change, review the differences and
     press **Update snapshots**.

   Files the app rejects on purpose (CHDK dumps, sRAW, PowerShot Pro70) are skipped.

4. **Run export check** exports the chosen sample as 16-bit TIFF, 16-bit PNG, JPEG
   and 8-bit PNG through the app, then checks them with tifffile, imagecodecs and
   LittleCMS (profiles, Exif, Adobe RGB to sRGB conversion) and compares the linear
   colour against LibRaw's AHD output.

References, snapshots and exported files are written to `tests/ref/` and
`tests/out/`, which are not committed.
