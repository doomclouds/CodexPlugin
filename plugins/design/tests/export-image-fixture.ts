import { deflateSync } from 'node:zlib';

/** A real self-contained RGB PNG with incompressible pixels, solely for transport-size tests. */
export function createExportPngFixture(): Buffer {
  const width = 1024, height = 850, rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = 0x51a37;
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    rows[y * (width * 3 + 1) + x + 1] = seed & 255;
  }
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([size, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
