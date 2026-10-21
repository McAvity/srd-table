/**
 * kenli F-007 T02: the app icons for the Home Screen / web manifest (public/icons/), drawn here so
 * they are reproducible without an image tool: the felt-green card table with a cream d20 outline
 * (a hexagon with its inner triangle). Opaque (iOS shows transparency as black); the motif stays in
 * the inner 60 %, so the same drawing is a valid maskable icon.
 *
 *   bun scripts/release/icons.ts            # (re)write public/icons/*.png
 *   bun scripts/release/icons.ts --check    # exit 1 when the committed files differ
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const BG = [0x1d, 0x3b, 0x2a];
const FG = [0xf2, 0xea, 0xd3];

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Inside the d20 outline at (x, y) in unit coordinates (-1..1): hexagon ring + inner triangle edges. */
function ink(x: number, y: number, scale: number): boolean {
  const r = 0.6 * scale;
  const w = 0.07 * scale;
  // regular hexagon, pointy top: distance to the boundary along the 6 edge normals
  const hex = (px: number, py: number) => {
    let d = 0;
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      d = Math.max(d, px * Math.cos(a) + py * Math.sin(a));
    }
    return d / (r * Math.cos(Math.PI / 6));
  };
  const h = hex(x, y);
  if (h <= 1 && h >= 1 - w / r) return true;
  // inner triangle (pointing up) with vertices on alternate hexagon corners
  const tri: [number, number][] = [0, 2, 4].map((k) => {
    const a = -Math.PI / 2 + (Math.PI / 3) * k;
    return [Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6];
  });
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = tri[i] as [number, number];
    const [bx, by] = tri[(i + 1) % 3] as [number, number];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
      ),
    );
    const dx = x - (ax + t * (bx - ax));
    const dy = y - (ay + t * (by - ay));
    if (Math.hypot(dx, dy) <= w / 2) return true;
  }
  // lines from the triangle corners to the nearest hexagon corners
  for (let k = 0; k < 6; k++) {
    const a = -Math.PI / 2 + (Math.PI / 3) * k;
    const [cx, cy] = [Math.cos(a) * r, Math.sin(a) * r];
    // a corner facing a triangle vertex joins it; a corner between two joins both (the d20 faces)
    const targets = k % 2 === 0 ? [k / 2] : [(k - 1) / 2, ((k + 1) / 2) % 3];
    for (const j of targets) {
      const [tx, ty] = tri[j] as [number, number];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((x - cx) * (tx - cx) + (y - cy) * (ty - cy)) / ((tx - cx) ** 2 + (ty - cy) ** 2),
        ),
      );
      if (Math.hypot(x - (cx + t * (tx - cx)), y - (cy + t * (ty - cy))) <= w / 2.6) return true;
    }
  }
  return false;
}

export function iconPng(size: number, scale = 1): Buffer {
  const ss = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          if (ink(x, y, scale)) hit++;
        }
      const a = hit / (ss * ss);
      const o = py * (size * 3 + 1) + 1 + px * 3;
      for (let c = 0; c < 3; c++)
        raw[o + c] = Math.round((BG[c] as number) * (1 - a) + (FG[c] as number) * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

export const ICONS: Record<string, () => Buffer> = {
  "apple-touch-icon.png": () => iconPng(180),
  "icon-192.png": () => iconPng(192),
  "icon-512.png": () => iconPng(512),
  "icon-maskable-512.png": () => iconPng(512, 0.8),
};

if (import.meta.main) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../public/icons");
  const check = process.argv.includes("--check");
  let differ = 0;
  for (const [name, make] of Object.entries(ICONS)) {
    const bytes = make();
    const path = join(dir, name);
    if (check) {
      let cur: Buffer | null = null;
      try {
        cur = readFileSync(path);
      } catch {}
      if (!cur?.equals(bytes)) {
        differ++;
        console.log(`differs: ${name}`);
      }
    } else writeFileSync(path, bytes);
  }
  if (check) process.exit(differ ? 1 : 0);
  console.log(`wrote ${Object.keys(ICONS).length} icons to public/icons/`);
}
