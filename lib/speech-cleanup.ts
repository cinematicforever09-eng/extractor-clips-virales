import type { TranscriptWord } from './whisper.js';

/**
 * Tightens a clip by cutting dead air and filler words.
 *
 * Opus Clip calls this Speech Cleanup, and it is what makes an exported clip
 * feel edited rather than merely trimmed. It only works because whisper gives
 * real per-word timestamps: without them there is no way to know where a pause
 * starts or which span of audio a filler occupies.
 *
 * The two halves have very different risk:
 *
 *   Pauses are safe. Removing silence cannot change what was said.
 *   Fillers are not. "Bueno" and "pues" can open a sentence meaningfully, so
 *   only unambiguous hesitations are listed, and only when they stand alone.
 */

export interface KeepSegment {
  /** Seconds in the source clip. */
  start: number;
  end: number;
}

export interface CleanupOptions {
  /** Silence longer than this is shortened. Seconds. */
  maxPause?: number;
  /** What a shortened pause is left at, so speech does not run together. */
  keepPause?: number;
  removeFillers?: boolean;
}

export interface CleanupResult {
  segments: KeepSegment[];
  /** Words that survived, with times rebased onto the shortened timeline. */
  words: TranscriptWord[];
  removedSeconds: number;
  removedFillers: number;
}

/**
 * Spanish hesitations with no meaning of their own.
 *
 * Deliberately short. Words like "bueno", "pues" or "claro" are left out: they
 * are often real sentence openers, and cutting them mid-phrase reads worse than
 * leaving a hesitation in.
 */
const FILLERS = new Set([
  'eh',
  'ehh',
  'em',
  'emm',
  'mmm',
  'mm',
  'ah',
  'ahh',
  'este',
  'esto',
  'o-sea',
  'osea',
]);

/** Two-word hesitations, matched on consecutive words. */
const FILLER_PAIRS = [['o', 'sea']];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\-]/g, '');
}

/** Whether a word is a filler worth cutting in this position. */
function isFiller(words: TranscriptWord[], index: number): boolean {
  const current = normalise(words[index].text);
  if (!current) return false;

  if (FILLERS.has(current)) {
    // "este" is also a demonstrative ("este coche"). Only treat it as a
    // hesitation when it stands alone between pauses.
    if (current === 'este' || current === 'esto') {
      const before = words[index - 1];
      const after = words[index + 1];
      // No neighbour means no evidence of hesitation. Assuming a pause there
      // made "este coche" lose its demonstrative whenever it opened a clip.
      const gapBefore = before ? words[index].start - before.end : 0;
      const gapAfter = after ? after.start - words[index].end : 0;
      return gapBefore > 0.25 || gapAfter > 0.25;
    }
    return true;
  }

  for (const [first, second] of FILLER_PAIRS) {
    if (current === first && words[index + 1] && normalise(words[index + 1].text) === second) {
      return true;
    }
    if (current === second && words[index - 1] && normalise(words[index - 1].text) === first) {
      return true;
    }
  }

  return false;
}

/**
 * Works out which spans of the clip to keep.
 *
 * Returns segments in source time. An empty result means nothing was worth
 * cutting, and the caller should use the clip unchanged rather than rebuilding
 * it from one segment.
 */
export function planCleanup(
  words: TranscriptWord[],
  clipStart: number,
  clipEnd: number,
  options: CleanupOptions = {}
): CleanupResult {
  const maxPause = options.maxPause ?? 0.65;
  const keepPause = Math.min(options.keepPause ?? 0.25, maxPause);
  const removeFillers = options.removeFillers ?? true;

  const inClip = words
    .filter((w) => w.end > clipStart && w.start < clipEnd)
    .map((w) => ({
      text: w.text,
      start: Math.max(clipStart, w.start),
      end: Math.min(clipEnd, w.end),
    }))
    .filter((w) => w.end > w.start);

  if (inClip.length === 0) {
    return { segments: [], words: [], removedSeconds: 0, removedFillers: 0 };
  }

  const kept: TranscriptWord[] = [];
  let removedFillers = 0;

  for (let i = 0; i < inClip.length; i++) {
    if (removeFillers && isFiller(inClip, i)) {
      removedFillers += 1;
      continue;
    }
    kept.push(inClip[i]);
  }

  if (kept.length === 0) {
    return { segments: [], words: [], removedSeconds: 0, removedFillers };
  }

  // Build keep-spans around the surviving words, allowing a short pause between
  // them. Adjacent spans are merged so the output is as few cuts as possible.
  const segments: KeepSegment[] = [];
  let spanStart = Math.max(clipStart, kept[0].start - keepPause / 2);
  let spanEnd = kept[0].end;

  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i].start - spanEnd;

    if (gap > maxPause) {
      segments.push({ start: spanStart, end: Math.min(clipEnd, spanEnd + keepPause / 2) });
      spanStart = Math.max(clipStart, kept[i].start - keepPause / 2);
    }
    spanEnd = kept[i].end;
  }
  segments.push({ start: spanStart, end: Math.min(clipEnd, spanEnd + keepPause / 2) });

  const keptDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const removedSeconds = Math.max(0, clipEnd - clipStart - keptDuration);

  // Rebase the surviving words onto the shortened timeline, so captions still
  // land on the right syllable after the cuts.
  const rebased: TranscriptWord[] = [];
  let elapsed = 0;

  for (const segment of segments) {
    for (const word of kept) {
      if (word.start >= segment.start && word.start < segment.end) {
        rebased.push({
          text: word.text,
          start: Math.round((elapsed + (word.start - segment.start)) * 100) / 100,
          end: Math.round((elapsed + (Math.min(word.end, segment.end) - segment.start)) * 100) / 100,
        });
      }
    }
    elapsed += segment.end - segment.start;
  }

  return { segments, words: rebased, removedSeconds, removedFillers };
}

/**
 * FFmpeg filter that stitches the kept spans back into one continuous clip.
 *
 * Video and audio are trimmed in parallel and concatenated together, so they
 * stay in sync across every cut.
 */
export function buildCleanupFilter(
  segments: KeepSegment[],
  hasAudio: boolean
): { filter: string; videoLabel: string; audioLabel: string | null } | null {
  // One span covering everything means there was nothing to cut.
  if (segments.length <= 1) return null;

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  segments.forEach((segment, index) => {
    const v = `cv${index}`;
    parts.push(
      `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},` +
        `setpts=PTS-STARTPTS[${v}]`
    );
    videoLabels.push(`[${v}]`);

    if (hasAudio) {
      const a = `ca${index}`;
      parts.push(
        `[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},` +
          `asetpts=PTS-STARTPTS[${a}]`
      );
      audioLabels.push(`[${a}]`);
    }
  });

  const interleaved = hasAudio
    ? segments.map((_, i) => `${videoLabels[i]}${audioLabels[i]}`).join('')
    : videoLabels.join('');

  parts.push(
    `${interleaved}concat=n=${segments.length}:v=1:a=${hasAudio ? 1 : 0}` +
      `[cleanv]${hasAudio ? '[cleana]' : ''}`
  );

  return {
    filter: parts.join(';'),
    videoLabel: '[cleanv]',
    audioLabel: hasAudio ? '[cleana]' : null,
  };
}
