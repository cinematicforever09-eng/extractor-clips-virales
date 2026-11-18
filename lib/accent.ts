import { spawn } from 'node:child_process';

/**
 * Picks the word-box colour for a clip from the clip's own colours.
 *
 * The user asked for the box to contrast with whatever dominates the video:
 * a purple box vanishes on a purple stream set, a green one on a forest. So
 * the clip is sampled, its dominant hue found, and the palette colour whose
 * hue sits furthest from it is chosen.
 *
 * Every palette colour is dark and saturated enough that white text on it
 * stays readable (contrast with white of at least 4.5:1, the WCAG bar for
 * normal text) - the letters are always white, only the box changes.
 */

export interface Accent {
  hex: string;
  /** Hue in degrees, 0-360. */
  hue: number;
  name: string;
}

export const ACCENT_PALETTE: Accent[] = [
  { hex: '#7C3AED', hue: 262, name: 'morado' },
  { hex: '#2563EB', hue: 221, name: 'azul' },
  { hex: '#0F766E', hue: 175, name: 'verde azulado' },
  { hex: '#047857', hue: 161, name: 'esmeralda' },
  { hex: '#C2410C', hue: 17, name: 'naranja' },
  { hex: '#DC2626', hue: 0, name: 'rojo' },
  { hex: '#BE185D', hue: 330, name: 'fucsia' },
];

/** The default when a clip has no colour to speak of (greys, black and white). */
export const NEUTRAL_ACCENT = ACCENT_PALETTE[0];

/** Below this average saturation a clip counts as colourless. */
const COLOURLESS = 0.12;

/** Smallest angle between two hues. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Dominant hue of packed RGB pixels, weighted by saturation so grey pixels
 * (most of any frame) do not pull it around. Null for colourless input.
 */
export function dominantHue(rgb: ArrayLike<number>): number | null {
  let sumX = 0;
  let sumY = 0;
  let satTotal = 0;
  let count = 0;

  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i] / 255;
    const g = rgb[i + 1] / 255;
    const b = rgb[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    count++;
    if (max === 0 || delta === 0) continue;

    const saturation = delta / max;
    let hue: number;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;

    // Dark pixels' hue is mostly noise; weight by how much colour they show.
    const weight = saturation * max;
    sumX += Math.cos((hue * Math.PI) / 180) * weight;
    sumY += Math.sin((hue * Math.PI) / 180) * weight;
    satTotal += saturation;
  }

  if (count === 0 || satTotal / count < COLOURLESS) return null;
  let hue = (Math.atan2(sumY, sumX) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hue;
}

/** The palette colour that stands out most against the given pixels. */
export function chooseAccent(rgb: ArrayLike<number>): Accent {
  const hue = dominantHue(rgb);
  if (hue === null) return NEUTRAL_ACCENT;
  return ACCENT_PALETTE.reduce((best, candidate) =>
    hueDistance(candidate.hue, hue) > hueDistance(best.hue, hue) ? candidate : best
  );
}

/** A few small frames of the clip as packed RGB. */
async function sampleClip(
  ffmpegPath: string,
  inputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for (const fraction of [0.15, 0.35, 0.55, 0.75, 0.9]) {
    const at = startSeconds + durationSeconds * fraction;
    const frame = await new Promise<Buffer>((resolve) => {
      const child = spawn(
        ffmpegPath,
        [
          '-v', 'error',
          '-nostdin',
          '-ss', at.toFixed(2),
          '-i', inputPath,
          '-frames:v', '1',
          '-vf', 'scale=48:27:flags=area,format=rgb24',
          '-f', 'rawvideo',
          '-',
        ],
        { windowsHide: true }
      );
      const parts: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => parts.push(c));
      child.stderr.on('data', () => {});
      child.on('error', () => resolve(Buffer.alloc(0)));
      child.on('close', () => resolve(Buffer.concat(parts)));
    });
    chunks.push(frame);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Samples the clip and picks its accent. Never throws: falls back to the neutral colour. */
export async function accentForClip(
  ffmpegPath: string,
  inputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<Accent> {
  try {
    const rgb = await sampleClip(ffmpegPath, inputPath, startSeconds, durationSeconds);
    return rgb.length > 0 ? chooseAccent(rgb) : NEUTRAL_ACCENT;
  } catch {
    return NEUTRAL_ACCENT;
  }
}
