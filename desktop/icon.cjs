'use strict';
// Draw a tiny original whale icon without an external image dependency.
const zlib = require('node:zlib');
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
function whaleIcon() {
  const size = 32, scan = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = y * (size * 4 + 1) + 1 + x * 4;
    const body = ((x - 18) / 12) ** 2 + ((y - 19) / 9) ** 2 <= 1;
    const tail = x >= 1 && x <= 10 && y >= 13 && y <= 23 && (x <= 5 ? Math.abs(y - 18) <= 5 - x / 2 : Math.abs(y - 18) < (x - 3) / 2);
    const spray = (x === 19 && y >= 3 && y <= 9) || ((x === 15 || x === 23) && y >= 4 && y <= 6);
    if (body || tail || spray) scan.set([94, 168, 248, 255], at);
    if (body && y >= 22) scan.set([190, 226, 255, 255], at);
    if ((x - 23) ** 2 + (y - 17) ** 2 <= 2) scan.set([29, 46, 79, 255], at);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = whaleIcon;
