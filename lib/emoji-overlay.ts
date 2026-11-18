/**
 * Emoji cues on top of the captions.
 *
 * Opus Clip lets you pin an emoji to a word so it pops in on the beat that word
 * is spoken. Doing the same here needs a detour, because libass cannot draw
 * colour emoji: it renders a font's monochrome layer, so a burned-in 🔥 comes
 * out as a white outline (and the display faces this app uses - Impact, Arial
 * Black, Consolas - carry no emoji glyphs at all).
 *
 * So the emoji is not text here. The browser rasterises each one to a PNG on a
 * canvas, which is the same renderer that draws the live preview, and FFmpeg
 * composites those PNGs over the frame. Preview and export therefore cannot
 * disagree about what an emoji looks like - they are the same pixels.
 *
 * Everything in this file is pure geometry and string building so it can be
 * unit tested, and so the client can size its canvas with the exact numbers the
 * server will overlay at.
 */

import { estimateCaptionLines } from './text-metrics.js';

// Re-exported so callers that lay out emoji get the measurement from one
// import rather than having to know it lives next door.
export { estimateCaptionLines };

export type EmojiPosition = 'bottom' | 'center' | 'top';

export interface EmojiCue {
  emoji: string;
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
}

export interface EmojiLine {
  startTime: number;
  endTime: number;
  words?: Array<{ text: string; start: number; end: number; emoji?: string }>;
}

/**
 * How long an emoji lingers after its word has been spoken.
 *
 * A cue that ends exactly on the word flashes past; short-form editors hold it
 * a beat so the eye can land on it.
 */
const HOLD_SECONDS = 0.6;

/** Shortest a cue may be, so a one-syllable word still registers. */
const MIN_SECONDS = 0.5;

/**
 * Pulls the emoji cues out of the caption lines.
 *
 * Cues are clamped to their own line: an emoji outliving the caption it belongs
 * to would hang over the next sentence with nothing to explain it.
 */
export function collectEmojiCues(lines: EmojiLine[]): EmojiCue[] {
  const cues: EmojiCue[] = [];

  for (const line of lines) {
    for (const word of line.words ?? []) {
      if (!word.emoji) continue;

      const start = Math.max(0, word.start);
      const wanted = Math.max(word.end, start + MIN_SECONDS) + HOLD_SECONDS;

      cues.push({
        emoji: word.emoji,
        start: Math.round(start * 100) / 100,
        // Never past the end of the line, but always visible for a moment.
        end: Math.round(Math.max(start + 0.2, Math.min(wanted, line.endTime)) * 100) / 100,
      });
    }
  }

  return cues.sort((a, b) => a.start - b.start);
}

export interface EmojiLayout {
  /** Side of the square PNG the client must rasterise, in output pixels. */
  size: number;
  /** Top-left corner of that square in the output frame. */
  x: number;
  y: number;
}

export interface LayoutInput {
  width: number;
  height: number;
  position: EmojiPosition;
  /** Caption font size in output pixels. */
  fontSize: number;
  /** Caption distance from the edge in output pixels. */
  marginV: number;
  /** How many rows the longest caption wraps onto. Defaults to one. */
  captionLines?: number;
  /**
   * Where the caption was dragged to, as a fraction of the frame height,
   * measuring the centre of the text block. When set it replaces `position`,
   * because that is what the caption itself does.
   */
  anchorY?: number;
}

export interface EmojiLayout {
  /** Side of the square PNG the client must rasterise, in output pixels. */
  size: number;
  /** Top-left corner of that square in the output frame. */
  x: number;
  y: number;
}

export interface LayoutInput {
  width: number;
  height: number;
  position: EmojiPosition;
  /** Caption font size in output pixels. */
  fontSize: number;
  /** Caption distance from the edge in output pixels. */
  marginV: number;
  /** How many rows the longest caption wraps onto. Defaults to one. */
  captionLines?: number;
  /**
   * Where the caption was dragged to, as a fraction of the frame height,
   * measuring the centre of the text block. When set it replaces `position`,
   * because that is what the caption itself does.
   */
  anchorY?: number;
}

/**
 * Where the emoji sits relative to the caption.
 *
 * Above the caption block and centred, rather than beside the word it belongs
 * to. Putting it next to the word would need the text metrics libass uses to
 * lay the line out, which are not available here - guessing at them puts the
 * emoji visibly off the word, which looks worse than a deliberate position.
 */
export function planEmojiLayout(input: LayoutInput): EmojiLayout {
  const size = Math.round(input.fontSize * 1.15);

  // The gap keeps the emoji clear of the caption's outline and shadow.
  const gap = Math.round(input.fontSize * 0.35);
  // A caption row occupies roughly its font size plus leading. A wrapped
  // caption grows upwards from a bottom margin, so the block height is what
  // decides where the emoji can sit.
  const rows = Math.max(1, Math.round(input.captionLines ?? 1));
  const lineHeight = Math.round(input.fontSize * 1.25 * rows);

  // A dragged caption is centred on its anchor, so the emoji clears half the
  // block rather than all of it. Checked before `position`, which the anchor
  // replaces.
  if (input.anchorY !== undefined) {
    const centre = input.anchorY * input.height;
    return {
      size,
      x: Math.round((input.width - size) / 2),
      y: Math.max(
        8,
        Math.min(input.height - size - 8, Math.round(centre - lineHeight / 2 - gap - size))
      ),
    };
  }

  let y: number;
  switch (input.position) {
    case 'top':
      // Captions grow downwards from the top margin, so the emoji goes above
      // them - unless that would push it off frame, in which case it goes under.
      y = input.marginV - gap - size;
      if (y < 8) y = input.marginV + lineHeight + gap;
      break;

    case 'center':
      // Centred captions grow in both directions, so only half the block sits
      // above the middle.
      y = Math.round(input.height / 2 - lineHeight / 2) - gap - size;
      break;

    default:
      y = input.height - input.marginV - lineHeight - gap - size;
      break;
  }

  return {
    size,
    x: Math.round((input.width - size) / 2),
    y: Math.max(8, Math.min(input.height - size - 8, Math.round(y))),
  };
}

/**
 * Side the client rasterises each emoji PNG at.
 *
 * Fixed rather than computed, so the browser does not have to reproduce the
 * caption's font-size arithmetic to know how big to draw. FFmpeg scales each
 * PNG down to the laid-out size, and 256 is comfortably above any size this
 * uses, so that is always a downscale and never a blur.
 */
export const EMOJI_SOURCE_PX = 256;

/**
 * Chains one overlay per cue onto the video.
 *
 * Each PNG is its own FFmpeg input, so `firstInputIndex` says where those
 * inputs start - index 0 is the source video.
 *
 * The same emoji used twice is still two inputs. Reusing one input for both
 * would be tempting, but a filter output can only be consumed once, so the
 * second overlay would find its input already drained and the graph would not
 * build at all.
 */
export function buildEmojiOverlayFilter(
  inputLabel: string,
  cues: EmojiCue[],
  layout: EmojiLayout,
  firstInputIndex: number
): { filter: string; outLabel: string } | null {
  if (cues.length === 0) return null;

  const parts: string[] = [];
  let current = inputLabel;

  cues.forEach((cue, index) => {
    const scaled = `[es${index}]`;
    const out = `[emo${index}]`;

    // flags=lanczos keeps the emoji's edges clean through the downscale.
    parts.push(
      `[${firstInputIndex + index}:v]scale=${layout.size}:${layout.size}:flags=lanczos${scaled}`
    );
    parts.push(
      `${current}${scaled}overlay=${layout.x}:${layout.y}:` +
        // A single-frame PNG would disappear after one frame without this; the
        // default repeats its last frame for as long as the video runs.
        `eof_action=repeat:enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'${out}`
    );
    current = out;
  });

  return { filter: parts.join(';'), outLabel: current };
}
