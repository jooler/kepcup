'use strict';

/**
 * 图标栅格化渲染器（由 scripts/generate-icons.mjs 用仓库自带 Electron 拉起）：
 * 离屏 BrowserWindow 把 resources/KepCup.svg 按各目标尺寸矢量栅格化，落盘
 * icon.png / icon.icns / icons/ / tray/（尺寸契约见 generate-icons.mjs 头注释）。
 *
 * 用独立壳而不是第三方 SVG→PNG 依赖：矢量按目标尺寸逐个栅格化（而非从母图
 * 降采样），16px 之类小尺寸的笔画边缘仍然锐利。
 */

const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// 确定性栅格化：1x 设备缩放（capturePage 像素尺寸可精确断言）+ 软件渲染
//（透明画面不受 GPU 合成差异影响）。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const [resourcesDir, svgPath] = process.argv.slice(2);
if (!resourcesDir || !svgPath) {
  console.error('usage: electron generate-icons-electron.cjs <resourcesDir> <svgPath>');
  process.exit(2);
}

// 品牌图比例（Apple Big Sur 图标网格）：
// - macOS 变体：图形占画布 824/1024 ≈ 80.5%、四周透明留白、圆角 185.4/824 ——
//   与系统其它图标在 Dock 里视觉同大（满幅会比邻居大一圈）。
// - 满幅变体（win/linux）：任务栏惯例尽量占满（VS Code 等），圆角 22.5%。
const BIGSUR_SHAPE_RATIO = 824 / 1024;
const BIGSUR_RADIUS_RATIO = 185.4 / 824;
const FULLBLEED_RADIUS_RATIO = 230 / 1024;

function baseSvg() {
  return readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '');
}

/**
 * 托盘剪影：去掉实心底色、白色改纯黑（template 图 = 黑 + alpha，菜单栏自动
 * 适配亮暗），并把 viewBox 裁到作品边界 (56,100)–(456,411)，小尺寸画布上
 * 图形尽量占满。
 */
function traySvg() {
  return baseSvg()
    .replace('<rect width="512" height="512" fill="#C2410C"/>', '')
    .replaceAll('#FFFFFF', '#000000')
    .replace(
      'width="1024" height="1024" viewBox="0 0 512 512"',
      'width="400" height="311" viewBox="56 100 400 311"',
    );
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

/** 中心点不透明（品牌图=实心橙底，托盘剪影=中心圆点），否则视为空白帧。 */
function assertNotBlank(image, label) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap();
  const alpha = buf[((height >> 1) * width + (width >> 1)) * 4 + 3];
  if (alpha === 0) throw new Error(`${label}: capture is blank`);
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

/** icns 容器：magic + 总长，随后是 [4 字节类型][4 字节块长][PNG 载荷]。 */
function buildIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

app.whenReady().then(
  async () => {
    const brand = baseSvg();
    const tray = traySvg();

    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      resizable: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });

    // 满幅品牌图：win ico 转换源（icon.png）+ Linux 尺寸集 + 托盘彩色图。
    const pngs = new Map();
    for (const size of [16, 24, 32, 44, 48, 64, 88, 96, 128, 256, 512, 1024]) {
      const image = await captureInto(
        win,
        pageHtml(brand, size, size, size * FULLBLEED_RADIUS_RATIO),
        size,
        size,
      );
      pngs.set(size, image.toPNG());
    }

    // macOS 变体（Big Sur 网格留白）：icon-mac.png（dev Dock）+ icon.icns 全部尺寸。
    const macPngs = new Map();
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const imgSize = size * BIGSUR_SHAPE_RATIO;
      const image = await captureInto(
        win,
        pageHtml(brand, size, imgSize, imgSize * BIGSUR_RADIUS_RATIO),
        size,
        size,
      );
      macPngs.set(size, image.toPNG());
    }

    const trayTemplate = await captureInto(win, pageHtml(tray, 26, 20, 0), 26, 20);
    const trayTemplate2x = await captureInto(win, pageHtml(tray, 52, 40, 0), 52, 40);
    win.destroy();

    mkdirSync(path.join(resourcesDir, 'icons'), { recursive: true });
    mkdirSync(path.join(resourcesDir, 'tray'), { recursive: true });

    writeFileSync(path.join(resourcesDir, 'icon.png'), pngs.get(1024));
    writeFileSync(path.join(resourcesDir, 'icon-mac.png'), macPngs.get(1024));

    const icnsEntries = [
      ['icp4', 16],
      ['icp5', 32],
      ['icp6', 64],
      ['ic07', 128],
      ['ic08', 256],
      ['ic09', 512],
      ['ic10', 1024],
      // @2x 组（与单倍类型同像素；iconutil 生成的 iconset 也是并存形式）。
      ['ic11', 32],
      ['ic12', 64],
      ['ic13', 256],
      ['ic14', 512],
    ];
    writeFileSync(
      path.join(resourcesDir, 'icon.icns'),
      buildIcns(icnsEntries.map(([type, size]) => [type, macPngs.get(size)])),
    );

    for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512]) {
      writeFileSync(path.join(resourcesDir, 'icons', `${size}x${size}.png`), pngs.get(size));
    }
    writeFileSync(path.join(resourcesDir, 'tray', 'tray.png'), pngs.get(44));
    writeFileSync(path.join(resourcesDir, 'tray', 'tray@2x.png'), pngs.get(88));
    writeFileSync(path.join(resourcesDir, 'tray', 'trayTemplate.png'), trayTemplate.toPNG());
    writeFileSync(path.join(resourcesDir, 'tray', 'trayTemplate@2x.png'), trayTemplate2x.toPNG());

    console.log('[icons] renderer done:', resourcesDir);
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
