import { encode } from 'uqr';

/**
 * 终端二维码（D102 §3.3）：首配与 `kepcup-server pair` 在服务端控制台出码——
 * 控制台就是带外信道（能看到它的 = 管理员），手机扫码即入配对。
 */

export function qrTerminal(text: string): string {
  const qr = encode(text);
  const quiet = 2; // 静区（模块数），扫码器要求
  const size = qr.size + quiet * 2;
  const rows: string[] = [];
  for (let y = 0; y < size; y += 1) {
    let line = '';
    for (let x = 0; x < size; x += 1) {
      const inQr = x >= quiet && y >= quiet && x < quiet + qr.size && y < quiet + qr.size;
      const dark = inQr && Boolean(qr.data[(y - quiet) * qr.size + (x - quiet)]);
      line += dark ? '██' : '  ';
    }
    rows.push(line);
  }
  return rows.join('\n');
}
