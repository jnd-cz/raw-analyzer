/*
 * Canon raw frame geometry: raw width, raw height, left and top margin of the
 * image area, and the CFA code (dcraw "filters" byte, 0 = RGGB) at that corner.
 * Extracted from LibRaw src/metadata/identify.cpp (canon[] table).
 * LibRaw (c) LibRaw LLC, LGPL 2.1 / CDDL 1.0.
 */
(self.RAW_MODULES = self.RAW_MODULES || []).push(function (RL) {
  'use strict';
  RL.CANON_GEOMETRY = [
    [1944, 1416, 0, 0, 0x00], // "PowerShot Pro90 IS"
    [2144, 1560, 4, 8, 0x00], // "PowerShot S30", "PowerShot G1"
    [2224, 1456, 48, 6, 0x00], // "EOS D30"
    [2376, 1728, 12, 6, 0x00], // "PowerShot G2", "PowerShot S40", "PowerShot G3", "PowerShot S45"
    [2672, 1968, 12, 6, 0x00], // "PowerShot G5", "PowerShot S50", "PowerShot S60"
    [3152, 2068, 64, 12, 0x00], // "EOS D60", "EOS 10D", "EOS 300D"
    [3160, 2344, 44, 12, 0x00], // "PowerShot G6", "PowerShot S70"
    [3344, 2484, 4, 6, 0x00], // "PowerShot Pro1"
    [3516, 2328, 42, 14, 0x00], // "EOS 350D"
    [3596, 2360, 74, 12, 0x00], // "EOS-1D Mark II", "EOS 20D", "EOS-1D Mark II N", "EOS 30D"
    [3744, 2784, 52, 12, 0x00], // "PowerShot G11", "PowerShot S90", "PowerShot G12", "PowerShot S95"
    [3944, 2622, 30, 18, 0x00], // "EOS 40D"
    [3948, 2622, 42, 18, 0x00], // "EOS 400D", "EOS 1000D"
    [3984, 2622, 76, 20, 0x00], // "EOS-1D Mark III"
    [4032, 2656, 112, 44, 0x00], // APS-C crop mode: "EOS 6D Mark II"??, "EOS RP"
    [4104, 3048, 48, 12, 0x00], // "PowerShot G9"
    [4116, 2178, 4, 2, 0x00], // ??
    [4152, 2772, 192, 12, 0x00], // "PowerShot SX1 IS"
    [4160, 3124, 104, 11, 0x00], // "PowerShot S100 (new)", "PowerShot S100V", "PowerShot G15", "PowerShot S110 (new)"
    [4176, 3062, 96, 17, 0x49], // "PowerShot SX50 HS"
    [4192, 3062, 96, 17, 0x49], // "PowerShot G16", "PowerShot S120"
    [4312, 2876, 22, 18, 0x00], // "EOS 450D"
    [4352, 2850, 144, 46, 0x00], // APS-C crop mode: "EOS R", "EOS Ra"
    [4352, 2874, 62, 18, 0x00], // "EOS 1100D"
    [4476, 2954, 90, 34, 0x00], // "EOS 5D"
    [4480, 3348, 12, 10, 0x49], // "PowerShot G10"
    [4480, 3366, 80, 50, 0x00], // "PowerShot G1 X Mark II"
    [4496, 3366, 80, 50, 0x00], // "PowerShot G1 X"
    [4768, 3516, 96, 16, 0x00], // "PowerShot SX60 HS"
    [4832, 3204, 62, 26, 0x00], // "EOS 500D"
    [4832, 3228, 62, 51, 0x00], // "EOS 50D"
    [5108, 3349, 98, 13, 0x00], // "EOS-1Ds Mark II"
    [5120, 3318, 142, 45, 0x00], // "EOS-1D Mark IV"
    [5280, 3528, 72, 52, 0x00], // "EOS M10", "EOS 650D", "EOS 700D", "EOS M", "EOS 100D", "EOS M2"
    [5344, 3516, 142, 51, 0x00], // "EOS 550D", "EOS 600D", "EOS 60D", "EOS 1200D", "EOS 1300D", "EOS 3000D"
    [5344, 3584, 126, 100, 0x00], // "EOS-1D X", "EOS-1D C"
    [5344, 3950, 98, 18, 0x00], // "PowerShot SX70 HS"
    [5360, 3516, 158, 51, 0x00], // "EOS 7D"
    [5568, 3708, 72, 38, 0x00], // "EOS 7D Mark II", "EOS 6D", "EOS 70D", "EOS-1D X MARK II"
    [5632, 3710, 96, 17, 0x49], // "PowerShot G7 X", "PowerShot G3 X", "PowerShot G9 X", "PowerShot G5 X", "PowerShot G7 X Mark II", "PowerShot G9 X Mark II"
    [5712, 3774, 62, 20, 0x00], // "EOS-1Ds Mark III"
    [5792, 3804, 158, 51, 0x00], // "EOS 5D Mark II"
    [5920, 3950, 122, 80, 0x00], // "EOS 5D Mark III"
    [6096, 4051, 76, 35, 0x00], // "EOS 1500D"
    [6096, 4056, 72, 34, 0x00], // "EOS M3", "EOS 760D", "EOS 750D"
    [6288, 4056, 264, 36, 0x00], // "EOS M5", "EOS M100", "EOS M6", "PowerShot G1 X Mark III", "EOS 80D", "EOS 800D", "EOS 77D", "EOS 200D", "EOS 250D", "EOS M50", "EOS R100"
    [6384, 4224, 120, 44, 0x00], // "EOS 6D Mark II", "EOS RP"
    [6880, 4544, 136, 42, 0x00], // "EOS 5D Mark IV"
    [6888, 4546, 146, 48, 0x00], // "EOS R", "EOS Ra"
    [7128, 4732, 144, 72, 0x00], // "EOS M6 II", "EOS 90D"
    [8896, 5920, 160, 64, 0x00], // "EOS 5DS", "EOS 5DS R"
    [6192, 4152, 160, 120, 0x00], // EOS R3
    [6192, 4060, 168, 52, 0x00], // EOS R10
    [6188, 4120, 154, 96, 0x00], // EOS R6mk2
    [8480, 5650, 258, 162, 0x00], // EOS R5mk2, FF
    [5376, 3574, 258, 162, 0x00], // EOS R5mk2, APS
    [6160, 4144, 128, 120, 0x00], // EOS R1, FF
  ];
});
