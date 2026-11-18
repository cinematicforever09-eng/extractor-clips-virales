import type { TimedLine } from './subtitles';
import { estimateTextWidth } from './text-metrics.js';
import {
  getSubtitleStyle,
  toAssColour,
  rgbaToAssColour,
  type SubtitleStyleDef,
  type SubtitleStyleId,
} from './subtitle-styles.js';

// Re-exported so existing imports of SubtitleStyleId from this module keep working.
export type { SubtitleStyleId } from './subtitle-styles.js';

export type SubtitlePosition = 'bottom' | 'center' | 'top';

/**
 * How the caption behaves over its own lifetime.
 *
 *   none      - appears and disappears, no movement
 *   fade      - short cross-fade in and out
 *   pop       - the whole line overshoots past 100% then settles
 *   slide     - rises into place from below while fading in
 *   karaoke   - words change colour on the beat they are spoken
 *   word-pop  - the spoken word grows and changes colour, then settles back
 *
 * word-pop is the look most short-form editors reach for; karaoke is the
 * calmer version of the same idea.
 */
export type SubtitleAnimation = 'none' | 'fade' | 'pop' | 'slide' | 'karaoke' | 'word-pop';

/** ASS alignment codes on the numpad layout: 2 = bottom centre, 5 = middle, 8 = top. */
const ALIGNMENT: Record<SubtitlePosition, number> = { bottom: 2, center: 5, top: 8 };

function formatAssTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hh = Math.floor(safe / 3600);
  const mm = Math.floor((safe % 3600) / 60);
  const ss = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Removes emoji before burning.
 *
 * libass renders each style with a single font, and none of the display faces
 * used here (Impact, Arial Black, Consolas) carry emoji glyphs, so a reaction
 * cue like "[Risas 😂]" burns in as "[RISAS ??]". Since the prompts deliberately
 * produce those cues, stripping is the reliable fix - the bracketed word still
 * reads correctly on screen.
 *
 * Emoji survive everywhere they actually render: the live preview overlay and
 * the exported .srt/.vtt files, both of which use the browser's font stack.
 */
function stripEmoji(text: string): string {
  return text
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{200D}]/gu,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([\]）)])/g, '$1')
    .trim();
}

/**
 * Escapes text for an ASS dialogue line.
 *
 * A literal `{` opens an override block in ASS, so unescaped braces in subtitle
 * text silently swallow the rest of the line.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// ---------------------------------------------------------------------------
// Word timing
// ---------------------------------------------------------------------------

export interface TimedWord {
  text: string;
  /** Milliseconds from the start of the line. */
  startMs: number;
  endMs: number;
}

export interface LineWithWords {
  text: string;
  startTime: number;
  endTime: number;
  /** Per-word timings in seconds, relative to the start of the clip. */
  words?: Array<{ text: string; start: number; end: number }>;
}

/**
 * Per-word timings for one caption line, in milliseconds from the line's start.
 *
 * Prefers the real timings whisper.cpp produced. The length-weighted estimate
 * below is only a fallback for captions that came from YouTube, which are timed
 * per phrase and carry no word boundaries at all.
 */
export function wordsForLine(line: LineWithWords): TimedWord[] {
  const durationMs = Math.max(1, (line.endTime - line.startTime) * 1000);

  if (line.words && line.words.length > 0) {
    return line.words.map((word) => ({
      text: word.text,
      startMs: Math.max(0, Math.round((word.start - line.startTime) * 1000)),
      endMs: Math.min(durationMs, Math.round((word.end - line.startTime) * 1000)),
    }));
  }

  return splitLineIntoWords(line.text, durationMs);
}

/**
 * Estimates per-word timings by sharing a line's duration out among its words.
 *
 * Only reached when the transcript has no word boundaries of its own, which
 * means captions pulled from YouTube. The split is weighted by word length
 * rather than even, because an even split makes short words linger and long
 * words flash past - obvious as soon as the highlight is meant to follow speech.
 */
export function splitLineIntoWords(text: string, durationMs: number): TimedWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // The +2 floor keeps one-letter words ("y", "a") from collapsing to nothing.
  const weights = words.map((word) => word.length + 2);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let elapsed = 0;
  return words.map((word, index) => {
    const share = (weights[index] / totalWeight) * durationMs;
    const startMs = Math.round(elapsed);
    elapsed += share;
    const endMs = index === words.length - 1 ? Math.round(durationMs) : Math.round(elapsed);
    return { text: word, startMs, endMs };
  });
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Override tags applied to the line as a whole. */
function lineAnimationTags(
  animation: SubtitleAnimation,
  width: number,
  height: number,
  position: SubtitlePosition,
  marginV: number,
  anchor?: { x: number; y: number }
): string {
  // A dragged caption is placed by absolute coordinates, so the resting point
  // the slide animation returns to is the anchor rather than the margin.
  const restX = anchor ? Math.round(anchor.x * width) : Math.round(width / 2);
  const restY = anchor
    ? Math.round(anchor.y * height)
    : position === 'top'
      ? marginV
      : position === 'center'
        ? Math.round(height / 2)
        : height - marginV;

  switch (animation) {
    case 'fade':
      return '\\fad(120,100)';

    // Overshoot to 108% then settle, which reads as a snap rather than a zoom.
    case 'pop':
    case 'word-pop':
      return '\\fad(60,80)\\fscx72\\fscy72\\t(0,110,\\fscx108\\fscy108)\\t(110,190,\\fscx100\\fscy100)';

    case 'slide':
      // \move needs absolute coordinates, which also overrides the style
      // margin, so the resting position has to be recomputed from the
      // alignment. It supersedes \pos, so a dragged caption is positioned by
      // this tag alone - emitting both would leave the caption where \move put
      // it and make the \pos look broken.
      return `\\fad(120,100)\\move(${restX},${restY + 70},${restX},${restY},0,190)`;

    case 'karaoke':
      return '\\fad(80,80)';

    default:
      return '';
  }
}

/**
 * Builds the dialogue body for animations that act on individual words.
 *
 * Tags in ASS apply to everything after them until overridden, so each word
 * carries a complete set rather than relying on the previous word's state.
 */
function wordAnimatedBody(
  words: TimedWord[],
  colours: { base: string; highlight: string },
  animation: SubtitleAnimation,
  uppercase: boolean
): string {
  return words
    .map((word) => {
      const text = escapeAssText(uppercase ? word.text.toUpperCase() : word.text);

      if (animation === 'karaoke') {
        // \k takes centiseconds and switches the syllable from secondary to
        // primary colour; the style sets secondary to the base colour so the
        // switch reads as "this word is being said now".
        const centiseconds = Math.max(1, Math.round((word.endMs - word.startMs) / 10));
        return `{\\k${centiseconds}}${text}`;
      }

      // word-pop: grow and recolour on the word's beat, then return to rest.
      const inStart = word.startMs;
      const inEnd = word.startMs + 70;
      const outStart = word.endMs;
      const outEnd = word.endMs + 90;

      return (
        `{\\c${colours.base}\\fscx100\\fscy100` +
        `\\t(${inStart},${inEnd},\\c${colours.highlight}\\fscx118\\fscy118)` +
        `\\t(${outStart},${outEnd},\\c${colours.base}\\fscx100\\fscy100)}` +
        text
      );
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

/**
 * Per-clip tweaks on top of a preset.
 *
 * The presets stay as they are - they encode a whole look - but a single clip
 * often needs the text a little bigger or a different accent colour without
 * inventing a new style for it.
 */
export interface StyleOverrides {
  /** Multiplies the preset's font size. */
  scale?: number;
  /** Resting colour, as #RRGGBB. */
  base?: string;
  /** Colour of the word being spoken. */
  highlight?: string;
  /** Distance from the edge, as a fraction of the output height. */
  marginRatio?: number;
  /**
   * A caption dragged somewhere specific, as fractions of the frame, measuring
   * the centre of the text block.
   *
   * When set it replaces the top/centre/bottom preset entirely: ASS positions
   * text either by alignment and margin or by absolute coordinates, never by
   * both, so the two cannot be combined.
   */
  anchor?: { x: number; y: number };
}

/**
 * Keeps a dragged caption inside the frame.
 *
 * The vertical clamp is a simple band, but the horizontal one has to account
 * for the width of the text. \pos centres the line on its point and, unlike
 * the margin-based placement, does not wrap to stay inside the frame - so a
 * wide caption dragged towards an edge simply runs off it, which is exactly
 * what the first render of this feature did.
 *
 * A caption too wide to fit however it is placed is centred: that at least
 * loses the same amount from both ends rather than all of it from one.
 */
export function clampAnchor(
  anchor: { x: number; y: number },
  widestText: string,
  width: number,
  fontSize: number,
  marginH: number
): { x: number; y: number } {
  const halfText = estimateTextWidth(widestText, fontSize) / 2;
  const limit = (width - marginH * 2) / 2;

  const x =
    halfText >= limit
      ? 0.5
      : Math.min(
          (width - marginH - halfText) / width,
          Math.max((marginH + halfText) / width, anchor.x)
        );

  return { x, y: Math.min(0.95, Math.max(0.05, anchor.y)) };
}

/**
 * Where the caption text ends up, in output pixels.
 *
 * Exported because the emoji overlay has to sit just above the caption, and
 * working that out from a second copy of this arithmetic is how the two drift
 * apart - an emoji landing on top of the text the moment someone changes the
 * size slider.
 */
export function captionMetrics(
  styleId: SubtitleStyleId,
  width: number,
  height: number,
  overrides: StyleOverrides = {}
): { fontSize: number; marginV: number } {
  const style = getSubtitleStyle(styleId);
  const scale2 = Math.max(0.5, Math.min(2, overrides.scale ?? 1));

  return {
    fontSize: Math.round(style.sizeRatio * width * scale2),
    marginV: Math.round((overrides.marginRatio ?? style.marginRatio) * height),
  };
}

export function buildAssFile(
  lines: TimedLine[],
  styleId: SubtitleStyleId,
  width: number,
  height: number,
  position: SubtitlePosition = 'bottom',
  animation: SubtitleAnimation = 'none',
  overrides: StyleOverrides = {}
): string {
  const style: SubtitleStyleDef = getSubtitleStyle(styleId);

  // Sizes and margins are fractions of the output, so a 1:1 or 16:9 export gets
  // proportionate text; the ASS outline and shadow are pixel values authored
  // against a 1080-wide frame and scale with it.
  const scale = width / 1080;
  const { fontSize, marginV } = captionMetrics(styleId, width, height, overrides);
  const outline = Math.max(1, Math.round(style.ass.outline * scale));
  const shadow = Math.round(style.ass.shadow * scale);
  const marginH = Math.round(60 * scale);

  // A dragged caption is placed by \pos, which needs alignment 5 so the
  // coordinates mean the centre of the text block rather than one of its corners.
  const anchor = overrides.anchor
    ? clampAnchor(
        overrides.anchor,
        // The widest caption decides the limit: one position serves the whole
        // clip, so clamping to the current line would let a later, longer one
        // run off the edge.
        lines.reduce((widest, line) => (line.text.length > widest.length ? line.text : widest), ''),
        width,
        fontSize,
        marginH
      )
    : undefined;

  const baseColour = toAssColour(overrides.base ?? style.base);
  const highlightColour = toAssColour(overrides.highlight ?? style.highlight);

  // ASS reuses the same two colour slots for two different jobs depending on
  // BorderStyle, which is easy to get backwards:
  //
  //   BorderStyle 1 (outline)  OutlineColour = the outline, BackColour = shadow
  //   BorderStyle 3 (box)      OutlineColour = the BOX FILL, BackColour = shadow
  //
  // Putting the box colour in BackColour, as this did before, left the box
  // painted in whatever the outline happened to be - MrBeast came out as a
  // solid yellow slab that swallowed the highlighted word.
  //
  // BorderStyle 3 has no separate border colour, so the accent edge a style
  // declares (MrBeast's yellow, Cyberpunk's cyan) only appears in the canvas
  // renderer, which can draw box and border independently.
  const outlineColour = style.box
    ? rgbaToAssColour(style.box.fill)
    : toAssColour(style.stroke?.color ?? '#000000');

  // BackColour is the drop shadow in both border styles. Opaque black: the box
  // styles set shadow to 0 so it never shows for them, and the outline styles
  // want a hard shadow under the stroke.
  const backColour = '&H00000000';

  // In karaoke mode the secondary colour is what a word shows before its beat,
  // so it has to be the resting colour and the primary becomes the highlight.
  const isKaraoke = animation === 'karaoke';
  const primary = isKaraoke ? highlightColour : baseColour;
  const secondary = isKaraoke ? baseColour : '&H000000FF';

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Viral,${style.assFont},${fontSize},${primary},${secondary},${outlineColour},${backColour},${style.ass.bold},0,0,0,100,100,0,0,${style.ass.borderStyle},${outline},${shadow},${anchor ? 5 : ALIGNMENT[position]},${marginH},${marginH},${marginV},1
${
  style.wordBox
    ? // The word box: BorderStyle 3 draws an opaque box from OutlineColour,
      // padded by Outline. Same font, size and margins as the text style, so
      // its glyphs land exactly on top of the text layer's.
      `Style: WordBox,${style.assFont},${fontSize},${toAssColour('#FFFFFF')},${toAssColour('#FFFFFF')},${highlightColour},&H00000000,${style.ass.bold},0,0,0,100,100,0,0,3,${Math.max(2, Math.round(fontSize * style.wordBox.padRatio))},0,${anchor ? 5 : ALIGNMENT[position]},${marginH},${marginH},${marginV},1
`
    : ''
}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const perWord = animation === 'karaoke' || animation === 'word-pop';

  if (style.wordBox) {
    return header + wordBoxEvents(lines, style.uppercase, anchor, width, height) + '\n';
  }

  const events = lines
    .filter((line) => line.text && line.text.trim() && line.endTime > line.startTime)
    .map((line) => {
      const clean = stripEmoji(line.text);
      if (!clean) return null;

      const movement = lineAnimationTags(animation, width, height, position, marginV, anchor);

      // \move already carries absolute coordinates, so adding \pos next to it
      // would be a second, conflicting instruction about where the line sits.
      const placement =
        anchor && !movement.includes('\\move')
          ? `\\pos(${Math.round(anchor.x * width)},${Math.round(anchor.y * height)})`
          : '';

      const prefix = `${placement}${movement}`;

      let body: string;
      if (perWord) {
        body = wordAnimatedBody(
          wordsForLine({ ...line, text: clean }),
          { base: baseColour, highlight: highlightColour },
          animation,
          style.uppercase
        );
      } else {
        body = escapeAssText(style.uppercase ? clean.toUpperCase() : clean);
      }

      const tags = prefix ? `{${prefix}}` : '';
      return `Dialogue: 0,${formatAssTime(line.startTime)},${formatAssTime(line.endTime)},Viral,,0,0,0,,${tags}${body}`;
    })
    .filter((line): line is string => line !== null)
    .join('\n');

  return header + events + '\n';
}

/**
 * Events for the word-box style.
 *
 * Two layers per line. Layer 0 is the whole line in white. Layer 1 repeats the
 * same line once per word, for that word's time only, with every other word
 * fully transparent (lpha&HFF& hides text and box alike) - so the box,
 * drawn per glyph by BorderStyle 3, appears behind the spoken word alone and
 * jumps as the speech moves on. Because both layers carry identical text in
 * identical metrics, the words line up without measuring any of them.
 *
 * Verified by rendering with this FFmpeg's libass (18-11-2026). The box
 * corners are square: libass has no rounded opaque box.
 *
 * Line animations (slide, pop) are left out on purpose: they start at the
 * event's own start, and the per-word events start later, so a moving line
 * would leave its boxes behind.
 */
export function wordBoxEvents(
  lines: TimedLine[],
  uppercase: boolean,
  anchor: { x: number; y: number } | undefined,
  width: number,
  height: number
): string {
  const placement = anchor
    ? `\\pos(${Math.round(anchor.x * width)},${Math.round(anchor.y * height)})`
    : '';

  const out: string[] = [];
  for (const line of lines) {
    if (!line.text || !line.text.trim() || line.endTime <= line.startTime) continue;
    const clean = stripEmoji(line.text);
    if (!clean) continue;

    const words = wordsForLine({ ...line, text: clean });
    const tokens = words.map((w) => escapeAssText(uppercase ? w.text.toUpperCase() : w.text));

    out.push(
      `Dialogue: 0,${formatAssTime(line.startTime)},${formatAssTime(line.endTime)},Viral,,0,0,0,,` +
        `{${placement}\\fad(60,60)}${tokens.join(' ')}`
    );

    words.forEach((word, i) => {
      const start = line.startTime + word.startMs / 1000;
      // Hold the box until the next word starts, so it never blinks off in
      // the gap between two words; the last word keeps it to the line's end.
      const nextStart = i < words.length - 1 ? line.startTime + words[i + 1].startMs / 1000 : line.endTime;
      const end = Math.min(line.endTime, Math.max(nextStart, start + 0.05));
      if (end <= start) return;

      const body = tokens
        .map((token, j) => (j === i ? `{\\alpha&H00&}${token}{\\alpha&HFF&}` : token))
        .join(' ');
      out.push(
        `Dialogue: 1,${formatAssTime(start)},${formatAssTime(end)},WordBox,,0,0,0,,` +
          `{${placement}\\alpha&HFF&}${body}`
      );
    });
  }
  return out.join('\n');
}
