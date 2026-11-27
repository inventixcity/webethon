import { deflateSync, inflateSync, crc32 } from "node:zlib";

/** Builds an RGB PNG of the given size. `pixel(x, y)` returns [r, g, b] for each position. */
export function encodePng(width, height, pixel) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    rows[rowStart] = 0; // filter type 0: no filtering
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const offset = rowStart + 1 + x * 3;
      rows[offset] = r;
      rows[offset + 1] = g;
      rows[offset + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Decodes an 8-bit, non-interlaced PNG (RGB or RGBA, which is what browser screenshots produce).
 * Returns { width, height, channels, pixels } where pixels holds the unfiltered scanlines.
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("Not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("Only 8-bit non-interlaced PNGs are supported");
      colourType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[dst + i - channels] : 0;
      const up = y > 0 ? pixels[dst - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[dst - stride + i - channels] : 0;
      const value = raw[src + i];
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[dst + i] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * How many pixels differ from the most common colour, sampled on a grid. A blank or single-colour canvas
 * scores 0; a rendered map scores high. Returns the fraction of sampled pixels that are not the background.
 */
export function visibleFraction(png, step = 3) {
  const { width, height, channels, pixels } = png;
  const colours = new Map();
  let samples = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * channels;
      const key = `${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`;
      colours.set(key, (colours.get(key) || 0) + 1);
      samples++;
    }
  }
  const background = Math.max(...colours.values());
  return samples === 0 ? 0 : (samples - background) / samples;
}
