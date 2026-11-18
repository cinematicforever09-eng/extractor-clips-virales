/**
 * Rough caption measurements, shared by the ASS writer and the emoji layout.
 *
 * These are estimates, and deliberately so. The real answer lives inside
 * libass with the actual font loaded, which this code has no access to - it
 * writes a subtitle file and hands it to FFmpeg. Two things nonetheless need a
 * number before the render happens: how far an emoji must sit above the text,
 * and how far a dragged caption can go before it runs off the edge.
 *
 * Both biases are chosen so a wrong guess is survivable. Overestimating the
 * width keeps a caption inside the frame; overestimating the row count floats
 * an emoji slightly high. Underestimating either one clips text or paints the
 * emoji on top of the words, which is what these replaced.
 */

/**
 * Average glyph advance as a fraction of the font size.
 *
 * The display faces this app uses - Impact, Arial Black - are condensed caps
 * that run narrower than this, so it reads as an upper bound.
 */
const ADVANCE_RATIO = 0.52;

/**
 * Slack for the word-pop animation, which grows the spoken word to 118% and
 * can push a line that only just fitted over the edge.
 */
const POP_SLACK = 1.18;

/** Estimated width of one row of caption text, in output pixels. */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.trim().length * fontSize * ADVANCE_RATIO * POP_SLACK;
}

/**
 * Estimated number of rows a caption wraps onto.
 *
 * Mattered as soon as emoji arrived: assuming every caption was one row put
 * the emoji on top of the text whenever one wrapped.
 */
export function estimateCaptionLines(
  text: string,
  width: number,
  fontSize: number,
  marginH: number
): number {
  const usable = Math.max(1, width - marginH * 2);
  return Math.max(1, Math.ceil(estimateTextWidth(text, fontSize) / usable));
}
