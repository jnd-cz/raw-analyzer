# To do

## Project setup
- [x] Put the project under git and publish it on GitHub (licence, `.gitignore`, first commit)
- [x] Move the regression tests into the repository (`tests/`): test page, LibRaw reference
      generator (rawpy), decode / demosaic / export checks, and a short how-to-run note.
      Reference data for the sample files stays out of git (large), the scripts regenerate it.

## Analysis features
- [x] Banding and pattern noise: row and column noise from the masked border, separated
      from random read noise, with a visibility verdict (Statistics tab)
- [ ] Banding from dark image areas too, for bodies without a usable masked strip in one
      direction (needs real dark frames to validate)
- [ ] Hot and stuck pixel map for dark frames and long exposures: list, count per channel,
      viewer overlay, CSV export
- [ ] Compare two files side by side: statistics, histograms, noise and PTC estimates
- [ ] Folder scan: table of date, lens, settings, shutter count, scene brightness and clipping
      for every raw file in a folder (check whether directory access works from file://)

## Improvements
- [ ] Faster AHD (now about 4x slower than PPG); keep the LibRaw-exact version for checks
- [ ] DNG export (raw CFA data, colour matrices, lens and exposure metadata)
- [ ] Remember viewer and histogram settings between sessions (demosaic, bins, shadow threshold)

## Known gaps
- [ ] Lossless (non C-RAW) CR3 not yet verified against a sample file
- Unsupported on purpose for now: headerless CHDK dumps, PowerShot Pro70, sRAW / mRAW
