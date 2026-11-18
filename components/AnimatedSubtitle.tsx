import React, { useMemo } from 'react';
import { SubtitleLine, SubtitleStyleType, SubtitleAnimationType } from '../types';
import { wordsForLine } from '../lib/ass';
import { getSubtitleStyle } from '../lib/subtitle-styles';

interface AnimatedSubtitleProps {
  line: SubtitleLine | null;
  style: SubtitleStyleType;
  animation: SubtitleAnimationType;
  /**
   * Changes whenever playback restarts the same line, so the CSS animations
   * replay instead of staying in their finished state.
   */
  replayKey?: number | string;
  /** Per-clip tweaks, so the preview matches what will be burned in. */
  overrides?: { scale?: number; base?: string; highlight?: string };
  /**
   * Width of the video as drawn on screen, in CSS pixels.
   *
   * When given, the type is sized as a fraction of it - the same way the
   * export sizes text as a fraction of the 1080-wide frame - so the preview
   * breaks lines where the exported clip will. Without it the fixed classes
   * below are used, which are legible but do not predict the wrapping.
   */
  frameWidth?: number;
}

/**
 * The palette and the container classes come from lib/subtitle-styles.ts, the
 * same definitions the FFmpeg burn-in and the canvas fallback read, so the
 * preview cannot drift away from what actually gets exported. Word timings come
 * from splitLineIntoWords() for the same reason.
 */

/**
 * Responsive type sizes for the preview only. These are the one thing that
 * cannot come from the shared definition: the export sizes text as a fraction
 * of a fixed 1080-wide frame, while the preview has to stay legible in a player
 * that can be any width.
 */
/**
 * Fallback sizes, for previews that cannot report how wide the video is.
 *
 * Kept because they are legible at any player size, but they do not match the
 * export's proportions: measured in the clip player, a five-word caption took
 * three rows here and one in the rendered clip. Pass `frameWidth` wherever the
 * preview is meant to predict the result.
 */
const SIZE_CLASS: Record<SubtitleStyleType, string> = {
  [SubtitleStyleType.PILL]: 'text-xl sm:text-2xl md:text-3xl',
  [SubtitleStyleType.HORMOZI]: 'text-xl sm:text-2xl md:text-3xl',
  [SubtitleStyleType.MRBEAST]: 'text-lg sm:text-xl md:text-2xl',
  [SubtitleStyleType.CYBERPUNK]: 'text-lg sm:text-xl md:text-2xl',
  [SubtitleStyleType.CLEAN_MINIMAL]: 'text-base sm:text-lg md:text-xl',
  [SubtitleStyleType.CLASSIC]: 'text-lg sm:text-xl md:text-2xl',
};

/** Animations that act on the line as a whole, driven by a CSS class. */
const LINE_ANIMATION_CLASS: Partial<Record<SubtitleAnimationType, string>> = {
  fade: 'vc-anim-fade',
  pop: 'vc-anim-pop',
  'word-pop': 'vc-anim-pop',
  slide: 'vc-anim-slide',
};

export const AnimatedSubtitle: React.FC<AnimatedSubtitleProps> = ({
  line,
  style,
  animation,
  replayKey,
  overrides,
  frameWidth,
}) => {
  const def = getSubtitleStyle(style);
  const base = overrides?.base ?? def.base;
  const highlight = overrides?.highlight ?? def.highlight;
  const scale = overrides?.scale ?? 1;
  // The word-box style is always per word, whatever animation is selected: the
  // moving box is the whole point of it.
  const isWordBox = Boolean(def.wordBox);
  const isPerWord = isWordBox || animation === 'karaoke' || animation === 'word-pop';

  // The export's own formula: sizeRatio is a fraction of the frame width, so
  // applying it to the on-screen width reproduces the same line breaks.
  const fontSize = frameWidth ? Math.max(9, def.sizeRatio * frameWidth * scale) : null;

  /**
   * The black outline the export draws around every letter.
   *
   * The preview had only a soft drop shadow, so on busy footage the words
   * mushed into whatever was behind them - most visibly over a source that
   * already has its own subtitles burned in. The exported clip never looked
   * like that, because libass strokes each glyph.
   *
   * paint-order puts the stroke behind the fill; without it the stroke is
   * painted centred on the outline and eats into the letterform, which on a
   * heavy face like Impact closes up the counters and reads as a smudge.
   *
   * The width is the ASS outline scaled from the 1080-wide export frame to
   * however wide the preview is, so it is the same thickness relative to the
   * type in both.
   */
  const outline =
    frameWidth && def.stroke ? (def.ass.outline * frameWidth) / 1080 : 0;

  const words = useMemo(() => {
    if (!line || !isPerWord) return [];
    return wordsForLine(line);
  }, [line, isPerWord]);

  /**
   * The emoji cues for this line, shown above the text.
   *
   * Deliberately independent of `isPerWord`: an emoji is pinned to a word, so
   * it has to appear whatever caption animation is selected. The CSS delay
   * reproduces the `enable=between(t,...)` window FFmpeg burns in, and the
   * centred position matches planEmojiLayout() - both of them put the emoji
   * above the line rather than beside its word, for the reason given there.
   */
  const emojiCues = useMemo(() => {
    if (!line?.words) return [];
    return line.words
      .filter((word) => word.emoji)
      .map((word) => ({
        emoji: word.emoji as string,
        delayMs: Math.max(0, Math.round((word.start - line.startTime) * 1000)),
      }));
  }, [line]);

  if (!line || !line.text.trim()) return null;

  const uppercase = def.uppercase;
  // Line animations are off for the word-box style, as in the export.
  const lineClass = isWordBox ? '' : LINE_ANIMATION_CLASS[animation] || '';

  return (
    <div
      // Remounting on line change is what restarts the CSS animations.
      key={`${line.startTime}-${replayKey ?? ''}`}
      className="max-w-[92%] text-center px-4 py-2 pointer-events-none"
      style={
        {
          '--vc-base': base,
          '--vc-highlight': highlight,
          // With a known frame width the scale is already baked into the font
          // size, so transforming as well would apply it twice. The transform
          // is only for the fallback path, where the Tailwind class sets an
          // absolute size that an em on this container could not override.
          transform: fontSize !== null || scale === 1 ? undefined : `scale(${scale})`,
        } as React.CSSProperties
      }
    >
      {emojiCues.length > 0 && (
        <div className="flex justify-center items-end space-x-1 mb-1 leading-none">
          {emojiCues.map((cue, index) => (
            <span
              key={`${index}-${cue.emoji}`}
              className="vc-word-pop inline-block text-3xl sm:text-4xl md:text-5xl"
              style={{ animationDelay: `${cue.delayMs}ms` }}
            >
              {cue.emoji}
            </span>
          ))}
        </div>
      )}

      <span
        className={`inline-block ${def.previewClass} ${lineClass} ${
          fontSize === null ? SIZE_CLASS[style] : ''
        }`}
        style={
          fontSize === null
            ? isWordBox
              ? { fontFamily: def.cssFont }
              : undefined
            : {
                // Only the word-box style names its font here: it ships its
                // own (Montserrat), and without it the preview would show the
                // page font and wrap differently from the export.
                ...(isWordBox ? { fontFamily: def.cssFont } : {}),
                fontSize: `${fontSize}px`,
                lineHeight: 1.18,
                ...(outline > 0.3
                  ? {
                      WebkitTextStrokeWidth: `${outline.toFixed(2)}px`,
                      WebkitTextStrokeColor: def.stroke?.color ?? '#000000',
                      paintOrder: 'stroke fill',
                    }
                  : {}),
              }
        }
      >
        {isPerWord ? (
          words.map((word, index) => (
            // The separator sits outside the animated span on purpose. A scaled
            // word grows from its centre, and a space kept inside gets swallowed
            // by that growth - "LO CUENTA" renders as "LOCUENTA".
            <React.Fragment key={`${index}-${word.text}`}>
              <span
                className={
                  isWordBox
                    ? 'vc-word-box inline-block'
                    : animation === 'karaoke'
                      ? 'vc-word-karaoke inline-block'
                      : 'vc-word-pop inline-block'
                }
                style={{
                  animationDelay: `${word.startMs}ms`,
                  animationDuration: isWordBox
                    ? // Until the next word starts, like the exported box.
                      `${Math.max(60, (words[index + 1]?.startMs ?? word.endMs) - word.startMs)}ms`
                    : animation === 'karaoke'
                      ? `${Math.max(60, word.endMs - word.startMs)}ms`
                      : undefined,
                }}
              >
                {uppercase ? word.text.toUpperCase() : word.text}
              </span>
              {index < words.length - 1 ? <span className="inline-block w-[0.28em]" /> : null}
            </React.Fragment>
          ))
        ) : (
          <span style={{ color: base }}>
            {uppercase ? line.text.toUpperCase() : line.text}
          </span>
        )}
      </span>
    </div>
  );
};
