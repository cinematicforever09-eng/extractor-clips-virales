export interface TimedLine {
  text: string;
  startTime: number;
  endTime: number;
  /**
   * Per-word timings in seconds from the start of the clip, when whisper
   * produced them. The caption animations and the emoji cues both read these;
   * without them the animations fall back to estimating word boundaries and
   * emoji cannot be placed at all.
   */
  words?: Array<{ text: string; start: number; end: number; emoji?: string }>;
}

export interface TranscriptChunk {
  text: string;
  start: number;
  duration: number;
}

export interface SubtitleFallbackContext {
  hook?: string;
  soundBiteQuote?: string;
  title?: string;
  description?: string;
  socialCaption?: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Cleans, orders and de-overlaps subtitle lines so they sit inside the clip.
 *
 * Previously named ensureContinuousSubtitlesCoveringFullClip, which promised
 * something it does not do: it deliberately leaves silence as silence rather
 * than stretching lines to cover the full duration. Padding gaps would put
 * words on screen that nobody said, which is exactly what the prompts forbid.
 */
export function normalizeSubtitleTimings(
  inputLines: TimedLine[],
  clipDuration: number,
  fallback: SubtitleFallbackContext = {}
): TimedLine[] {
  const targetDur = Math.max(1.5, round1(clipDuration));

  const lines = (inputLines || [])
    .filter((line) => line && line.text && String(line.text).trim().length > 0)
    .map((line) => ({
      text: String(line.text).trim(),
      startTime: Math.max(0, round1(Number(line.startTime) || 0)),
      endTime: Math.min(targetDur, Math.max(0.4, round1(Number(line.endTime) || 0))),
    }))
    .sort((a, b) => a.startTime - b.startTime);

  // Nothing usable came back. The only text we are allowed to show is a phrase
  // the model already attributed to the clip, never invented filler.
  if (lines.length === 0) {
    const quote = (fallback.soundBiteQuote || fallback.hook || '').trim();
    return quote ? [{ text: quote, startTime: 0, endTime: Math.min(targetDur, 3.5) }] : [];
  }

  // Snap a near-zero start to zero so the hook lands on the first frame.
  if (lines[0].startTime > 0 && lines[0].startTime <= 0.5) {
    lines[0].startTime = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i];

    if (current.endTime <= current.startTime) {
      current.endTime = Math.min(targetDur, round1(current.startTime + 1.8));
    }

    const next = lines[i + 1];
    if (next && current.endTime > next.startTime + 0.1) {
      const midPoint = round1((current.endTime + next.startTime) / 2);
      current.endTime = midPoint;
      next.startTime = midPoint;
    }
  }

  const last = lines[lines.length - 1];
  if (last.endTime > targetDur) last.endTime = targetDur;

  return lines.filter((line) => line.endTime > line.startTime);
}

/**
 * Pulls the real spoken lines for one clip window out of a timestamped
 * transcript, re-chunked into short bursts that read well on a phone.
 */
export function extractSubtitlesFromTranscript(
  transcript: TranscriptChunk[],
  clipStart: number,
  clipEnd: number
): TimedLine[] {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];

  const overlapping = transcript.filter((chunk) => {
    const chunkEnd = chunk.start + (chunk.duration || 2.5);
    return chunk.start <= clipEnd + 0.5 && chunkEnd >= clipStart - 0.5;
  });

  if (overlapping.length === 0) return [];

  const clipDuration = round1(clipEnd - clipStart);
  const result: TimedLine[] = [];

  for (const chunk of overlapping) {
    const relStart = Math.max(0, round1(chunk.start - clipStart));
    const relEnd = Math.min(clipDuration, round1(chunk.start + (chunk.duration || 2.5) - clipStart));

    const text = chunk.text.trim();
    if (!text || relEnd <= relStart) continue;

    const words = text.split(/\s+/);
    if (words.length <= 6) {
      result.push({ text, startTime: relStart, endTime: Math.max(relStart + 0.6, relEnd) });
      continue;
    }

    const chunkSize = 4;
    const totalChunks = Math.ceil(words.length / chunkSize);
    const chunkDur = Math.max(1, relEnd - relStart) / totalChunks;

    for (let i = 0; i < totalChunks; i++) {
      const subStart = round1(relStart + i * chunkDur);
      const subEnd = round1(relStart + (i + 1) * chunkDur);
      result.push({
        text: words.slice(i * chunkSize, (i + 1) * chunkSize).join(' '),
        startTime: subStart,
        endTime: Math.max(subStart + 0.6, subEnd),
      });
    }
  }

  return result;
}
