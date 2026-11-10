'use strict';

/**
 * 移动端图标栅格化渲染器（由 scripts/generate-icons.mjs 用仓库自带 Electron 拉起，
 * 与 apps/desktop/scripts/generate-icons-electron.cjs 同一套离屏机制：矢量按目标
 * 尺寸逐个栅格化，小尺寸笔画边缘锐利、零第三方依赖）。
 *
 * 输出（全部入库，直接落在原生工程里）：
 *   ios/…/AppIcon.appiconset/AppIcon-1024.png + Contents.json
 *     iOS 单尺寸图标（Xcode 14+ / App Store Connect 接受）：满幅方图、不烘焙
 *     圆角——圆角由系统遮罩统一裁，烘焙圆角会在遮罩下露出黑角。
 *   android res/mipmap 各密度目录的 ic_launcher 系列 PNG
 *     legacy 直出图（烘焙 22.5% 圆角）/ 圆形变体 / 自适应前景层（白 glyph 居中，
 *     占画布 60%，落在 66/108 安全区内）。
 *   android/.../values/ic_launcher_background.xml
 *     自适应背景色 = 品牌渐变（#000000→#37005C）中点。
 *
 * usage: electron generate-icons-electron.cjs <svgPath> <iosAppIconSetDir> <androidResDir>
 */

const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// 确定性栅格化：1x 设备缩放（capturePage 像素尺寸可精确断言）+ 软件渲染
//（透明画面不受 GPU 合成差异影响）。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const [svgPath, iosAppIconSetDir, androidResDir] = process.argv.slice(2);
if (!svgPath || !iosAppIconSetDir || !androidResDir) {
  console.error(
    'usage: electron generate-icons-electron.cjs <svgPath> <iosAppIconSetDir> <androidResDir>',
  );
  process.exit(2);
}

/** 品牌渐变底色（KepCup.svg 的 linearGradient stops），自适应背景取中点。 */
const BG_TOP = '#000000';
const BG_BOTTOM = '#37005C';

/** Android legacy 直出图的烘焙圆角（与桌面满幅变体一致：230/1024 ≈ 22.5%）。 */
const LEGACY_RADIUS_RATIO = 230 / 1024;
/** 自适应前景层：glyph 占画布比例（66/108 安全区 ≈ 61%，取 60% 留微量余量）。 */
const FOREGROUND_RATIO = 0.6;

function baseSvg() {
  return readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '');
}

/**
 * 白 glyph（背景剥离）：去掉渐变底 rect，并把 viewBox 裁到作品边界
 * (56,100)–(456,411)——SVG 内部自带留白，不裁的话前景层实际占比偏小。
 * glyph 本身是白色，保留原色（自适应背景是深紫，对比成立）。
 */
function glyphSvg() {
  const original = baseSvg();
  // replace 依赖 KepCup.svg 的属性写法逐字匹配:失效即前景层悄悄变回全彩图标,
  // 必须显式断言而不是静默 no-op(审查修复)。
  const stripped = original.replace('<rect width="512" height="512" fill="url(#bg)"/>', '');
  if (stripped === original) throw new Error('glyphSvg: 剥离底色 rect 未命中(SVG 结构变化?)');
  const cropped = stripped.replace(
    'width="1024" height="1024" viewBox="0 0 512 512"',
    'width="400" height="311" viewBox="56 100 400 311"',
  );
  if (cropped === stripped) throw new Error('glyphSvg: viewBox 裁剪未命中(SVG 结构变化?)');
  return cropped;
}

/** 画布 canvas×canvas，图形 imgSize×imgSize（imgSize < canvas 时居中留白）。 */
function pageHtml(svg, canvas, imgSize, radiusPx) {
  const data = Buffer.from(svg, 'utf8').toString('base64');
  const img = `<img src="data:image/svg+xml;base64,${data}">`;
  const centered =
    imgSize === canvas
      ? ''
      : `width:${canvas}px;height:${canvas}px;display:flex;align-items:center;justify-content:center;`;
  return [
    '<!doctype html><html><head><style>',
    'html,body{margin:0;padding:0;background:transparent;}',
    `img{display:block;width:${imgSize}px;height:${imgSize}px;`,
    radiusPx ? `border-radius:${radiusPx.toFixed(2)}px;` : '',
    `}</style></head><body style="${centered}">`,
    img,
    '</body></html>',
  ].join('');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 任一不透明像素（图标=渐变底、前景层=glyph 中心可能落在气泡内部透明区）。 */
function assertNotBlank(image, label) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  for (let py = 0; py < height; py += 1) {
    const row = py * width * 4;
    for (let px = 0; px < width; px += 1) {
      if (buf[row + px * 4 + 3] !== 0) return;
    }
  }
  throw new Error(`${label}: capture is blank`);
}

async function captureInto(win, html, width, height) {
  for (let attempt = 0; ; attempt++) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await Promise.race([
      new Promise((resolve) => {
        if (win.webContents.isPainting()) resolve();
        else win.webContents.once('paint', resolve);
      }),
      sleep(1500),
    ]);
    await sleep(40);
    const frame = await win.webContents.capturePage();
    const frameSize = frame.getSize();
    const image =
      frameSize.width === width && frameSize.height === height
        ? frame
        : frame.crop({ x: 0, y: 0, width, height });
    const size = image.getSize();
    if (size.width !== width || size.height !== height) {
      throw new Error(`capture ${width}x${height} → ${size.width}x${size.height}`);
    }
    try {
      assertNotBlank(image, `${width}x${height}`);
      return image;
    } catch (error) {
      if (attempt >= 2) throw error;
      win.webContents.invalidate(); // 空白帧：强制重绘后重试
    }
  }
}

function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

app.whenReady().then(
  async () => {
    const brand = baseSvg();
    const glyph = glyphSvg();

    const win = new BrowserWindow({
      width: 2732,
      height: 2732,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      resizable: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });

    // iOS 单尺寸图标：满幅方图、不烘焙圆角（系统遮罩统一裁）。
    mkdirSync(iosAppIconSetDir, { recursive: true });
    const iosIcon = path.join(iosAppIconSetDir, 'AppIcon-1024.png');
    writeFileSync(
      iosIcon,
      (await captureInto(win, pageHtml(brand, 1024, 1024, 0), 1024, 1024)).toPNG(),
    );
    writeFileSync(
      path.join(iosAppIconSetDir, 'Contents.json'),
      JSON.stringify(
        {
          images: [
            {
              filename: 'AppIcon-1024.png',
              idiom: 'universal',
              platform: 'ios',
              size: '1024x1024',
            },
          ],
          info: { author: 'xcode', version: 1 },
        },
        null,
        2,
      ) + '\n',
    );

    // Android legacy 直出图（烘焙圆角）+ 圆形变体。
    const DENSITIES = [
      ['mdpi', 48],
      ['hdpi', 72],
      ['xhdpi', 96],
      ['xxhdpi', 144],
      ['xxxhdpi', 192],
    ];
    for (const [dpi, size] of DENSITIES) {
      const dir = path.join(androidResDir, `mipmap-${dpi}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'ic_launcher.png'),
        (
          await captureInto(
            win,
            pageHtml(brand, size, size, size * LEGACY_RADIUS_RATIO),
            size,
            size,
          )
        ).toPNG(),
      );
      writeFileSync(
        path.join(dir, 'ic_launcher_round.png'),
        (await captureInto(win, pageHtml(brand, size, size, size / 2), size, size)).toPNG(),
      );
    }

    // 自适应前景层：白 glyph 居中，占画布 60%（108dp 画布、66dp 安全区）。
    // glyph 内容盒 400×311，img 显式方形尺寸 + SVG viewBox contain 缩放，不变形。
    const FG_DENSITIES = [
      ['mdpi', 108],
      ['hdpi', 162],
      ['xhdpi', 216],
      ['xxhdpi', 324],
      ['xxxhdpi', 432],
    ];
    for (const [dpi, size] of FG_DENSITIES) {
      const dir = path.join(androidResDir, `mipmap-${dpi}`);
      mkdirSync(dir, { recursive: true });
      const imgSize = Math.round(size * FOREGROUND_RATIO);
      writeFileSync(
        path.join(dir, 'ic_launcher_foreground.png'),
        (await captureInto(win, pageHtml(glyph, size, imgSize, 0), size, size)).toPNG(),
      );
    }
    win.destroy();

    // 自适应背景色：品牌渐变中点（#000000 与 #37005C 的线性中值）。
    const channel = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
    const lerpMid = (a, b) =>
      Math.round((a + b) / 2)
        .toString(16)
        .padStart(2, '0');
    const mid = `#${[1, 3, 5].map((i) => lerpMid(channel(BG_TOP, i), channel(BG_BOTTOM, i))).join('')}`;
    writeFileSync(
      path.join(androidResDir, 'values', 'ic_launcher_background.xml'),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${mid}</color>\n</resources>\n`,
    );

    // 尺寸断言（与桌面 generate-icons.mjs 同款验收）。
    for (const [dpi, size] of DENSITIES) {
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        const { width, height } = pngSize(path.join(androidResDir, `mipmap-${dpi}`, name));
        if (width !== size || height !== size) {
          throw new Error(`${dpi}/${name}: expected ${size}x${size}, got ${width}x${height}`);
        }
      }
    }

    console.log('[icons] mobile renderer done:', iosAppIconSetDir, androidResDir);
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
