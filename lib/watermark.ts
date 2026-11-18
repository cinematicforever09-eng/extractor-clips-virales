/**
 * The user's own logo, burned onto every exported clip.
 *
 * A PNG keeps its transparency through FFmpeg's overlay, so a logo with a
 * clear background sits on the picture the same way it does in the preview.
 * It goes on last, over the captions and emoji, because a watermark that a
 * caption can cover stops identifying the clip.
 *
 * Position and size are stored relative to the frame (0-1) so the same
 * settings work for 9:16, 1:1 and 16:9 exports alike, and so the small
 * preview in the picker and the 1080-wide render agree.
 */

export interface WatermarkSettings {
  /** The PNG itself, as a data URL or bare base64. */
  image: string;
  /** Logo width as a fraction of the video width. */
  widthRatio: number;
  /** Centre of the logo, as fractions of the frame. */
  x: number;
  y: number;
  /** 0 (invisible) to 1 (solid). */
  opacity: number;
}

/** Just under the bottom captions, which end about 15 % above the edge. */
export const DEFAULT_WATERMARK_POSITION = { x: 0.5, y: 0.93 };
export const DEFAULT_WATERMARK_WIDTH = 0.25;
export const DEFAULT_WATERMARK_OPACITY = 0.85;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** PNG files start with these eight bytes; anything else is refused. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decodes the image and checks it really is a PNG. Null when it is not. */
export function decodeWatermarkPng(image: string): Buffer | null {
  if (typeof image !== 'string' || image.length === 0) return null;
  const base64 = image.replace(/^data:image\/png;base64,/, '');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (bytes.length < PNG_SIGNATURE.length) return null;
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) ? bytes : null;
}

/**
 * Cleans settings coming from the client. Null when there is no usable logo,
 * so a broken upload exports the clip without a watermark rather than failing.
 */
export function normaliseWatermark(value: unknown): WatermarkSettings | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WatermarkSettings>;
  if (!raw.image || !decodeWatermarkPng(raw.image)) return null;

  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    image: raw.image,
    // Below 3 % a logo is a speck; above 90 % it is the video.
    widthRatio: clamp(num(raw.widthRatio, DEFAULT_WATERMARK_WIDTH), 0.03, 0.9),
    x: clamp(num(raw.x, DEFAULT_WATERMARK_POSITION.x), 0, 1),
    y: clamp(num(raw.y, DEFAULT_WATERMARK_POSITION.y), 0, 1),
    opacity: clamp(num(raw.opacity, DEFAULT_WATERMARK_OPACITY), 0.05, 1),
  };
}

/**
 * The filter that lays the logo over a finished picture.
 *
 * `videoLabel` is the stream to draw on, `inputIndex` the FFmpeg input that
 * holds the PNG. The logo's centre goes where the user put it, but the logo
 * as a whole is kept inside the frame - dragged to a corner, it stops at the
 * edge instead of being cut off.
 */
export function buildWatermarkFilter(
  videoLabel: string,
  inputIndex: number,
  frameWidth: number,
  settings: WatermarkSettings,
  outLabel = '[vwm]'
): string {
  // Even width so the scaled PNG never trips a chroma-subsampling edge case.
  const width = Math.max(2, Math.round((frameWidth * settings.widthRatio) / 2) * 2);
  const opacity = settings.opacity.toFixed(3);
  const x = settings.x.toFixed(4);
  const y = settings.y.toFixed(4);

  return (
    `[${inputIndex}:v]format=rgba,scale=${width}:-1,` +
    `colorchannelmixer=aa=${opacity}[wm];` +
    `${videoLabel}[wm]overlay=` +
    `x='max(0,min(main_w-overlay_w,main_w*${x}-overlay_w/2))':` +
    `y='max(0,min(main_h-overlay_h,main_h*${y}-overlay_h/2))'` +
    `:format=auto${outLabel}`
  );
}
