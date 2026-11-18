import { EMOJI_SOURCE_PX } from './emoji-overlay.js';

/**
 * Draws emoji to PNGs in the browser, so FFmpeg can burn them in.
 *
 * This exists because libass renders a single font per style and reads only its
 * monochrome layer: a burned-in 🔥 comes out as a white outline. The browser, on
 * the other hand, draws colour emoji correctly, and it is already in the stack.
 *
 * Doing it here has a second benefit worth stating plainly: the preview overlay
 * and the exported video end up using the same rasteriser, so what the user
 * approves on screen is what lands in the file. A server-side emoji font would
 * be a second opinion about what 🔥 looks like.
 *
 * Browser only - there is no canvas in the Node process.
 */

/**
 * Fonts that carry colour emoji, in platform order.
 *
 * The generic fallback at the end matters: without it a browser with none of
 * these installed silently draws the glyph in the default face, which is where
 * tofu boxes come from.
 */
const EMOJI_FONT =
  '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

/** Cached per emoji; rasterising the same glyph for every clip is wasteful. */
const cache = new Map<string, string>();

/**
 * Rasterises one emoji to a base64 PNG, transparent outside the glyph.
 *
 * Returns null when the canvas is unavailable or the glyph drew nothing, so a
 * font that cannot render an emoji skips it rather than burning in a blank
 * square.
 */
export function rasteriseEmoji(emoji: string): string | null {
  const cached = cache.get(emoji);
  if (cached !== undefined) return cached;

  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = EMOJI_SOURCE_PX;
  canvas.height = EMOJI_SOURCE_PX;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // 0.78 rather than the full side: emoji glyphs routinely draw outside their
  // nominal em box, and a glyph clipped at the canvas edge is very visible once
  // it is composited over video.
  ctx.font = `${Math.round(EMOJI_SOURCE_PX * 0.78)}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, EMOJI_SOURCE_PX / 2, EMOJI_SOURCE_PX / 2);

  if (!hasInk(ctx)) {
    cache.set(emoji, '');
    return null;
  }

  const png = canvas.toDataURL('image/png');
  cache.set(emoji, png);
  return png;
}

/** Whether anything was actually drawn, rather than a transparent square. */
function hasInk(ctx: CanvasRenderingContext2D): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, EMOJI_SOURCE_PX, EMOJI_SOURCE_PX);
    // Step over the alpha channel only, and in strides - a glyph that covers
    // less than one pixel in sixteen is not a glyph.
    for (let i = 3; i < data.length; i += 4 * 16) {
      if (data[i] > 8) return true;
    }
    return false;
  } catch {
    // A tainted canvas cannot be read. Nothing here taints it, but assuming
    // "drew fine" is the safer failure: the export simply carries the PNG.
    return true;
  }
}

export interface LineWithEmoji {
  words?: Array<{ emoji?: string }>;
}

/**
 * Collects every emoji the captions use into the map the export expects.
 *
 * Keyed by the emoji itself, so the same glyph used on five words is drawn once
 * and uploaded once.
 */
export function rasteriseEmojiFor(lines: LineWithEmoji[]): Record<string, string> {
  const images: Record<string, string> = {};

  for (const line of lines) {
    for (const word of line.words ?? []) {
      if (!word.emoji || images[word.emoji]) continue;

      const png = rasteriseEmoji(word.emoji);
      if (png) images[word.emoji] = png;
    }
  }

  return images;
}
