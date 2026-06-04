import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const outDir = new URL("../public/icons/png/", import.meta.url);
mkdirSync(outDir, { recursive: true });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function png(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = row + 1 + x * 4;
      scanlines[target] = pixels[source];
      scanlines[target + 1] = pixels[source + 1];
      scanlines[target + 2] = pixels[source + 2];
      scanlines[target + 3] = pixels[source + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function inRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  return x >= left && x <= right && y >= top && y <= bottom && (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = color[3];
  };

  const fill = (predicate, color) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (predicate(x, y)) set(x, y, color);
      }
    }
  };

  const scale = size / 128;
  const rr = (left, top, width, height, radius) => (x, y) => inRoundedRect(x, y, left * scale, top * scale, width * scale, height * scale, radius * scale);
  const rect = (left, top, width, height) => (x, y) => x >= left * scale && x <= (left + width) * scale && y >= top * scale && y <= (top + height) * scale;

  fill(() => true, [244, 249, 252, 255]);
  fill(rr(30, 14, 68, 45, 12), [165, 221, 244, 255]);
  fill(rect(39, 29, 50, 7), [14, 79, 120, 255]);
  fill(rr(22, 44, 84, 54, 14), [27, 126, 166, 255]);
  fill(rr(15, 83, 98, 27, 12), [11, 54, 87, 255]);
  fill(rr(33, 94, 62, 8, 4), [183, 231, 248, 255]);
  fill((x, y) => (x - 91 * scale) ** 2 + (y - 64 * scale) ** 2 <= (6 * scale) ** 2, [183, 231, 248, 255]);
  fill(rect(31, 68, 52, 5), [232, 247, 255, 230]);
  fill(rr(36, 113, 56, 7, 4), [27, 126, 166, 255]);

  return png(size, size, pixels);
}

[16, 32, 48, 128].forEach((size) => {
  writeFileSync(new URL(`scanner-${size}.png`, outDir), draw(size));
});
