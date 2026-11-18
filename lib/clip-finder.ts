import type { TranscriptWord } from './whisper.js';

/**
 * Finds clip-worthy moments from a timed transcript, without a language model.
 *
 * This is what keeps the app useful when Ollama is not installed, and it is
 * also what Ollama gets handed as candidates rather than the raw transcript -
 * a local 7B model does much better picking from twenty scored windows than
 * reading thirty minutes of text and inventing timestamps, which it tends to
 * hallucinate.
 *
 * Every signal here is observable in the transcript itself. Nothing is inferred
 * about meaning, so the scores are presented as "signals", not as a judgement.
 */

export interface Sentence {
  text: string;
  start: number;
  end: number;
  words: TranscriptWord[];
  score: number;
  reasons: string[];
}

export interface ClipCandidate {
  startSeconds: number;
  endSeconds: number;
  text: string;
  /** 0-100, derived from the signals below. */
  score: number;
  reasons: string[];
  hookSentence: string;
  bestQuote: string;
}

/**
 * Whisper writes these when it hears the crowd rather than the speaker.
 *
 * Music used to be in this list, scoring +30 as "audience reaction" - the
 * highest single signal here. It is the opposite: `[Música]` is whisper saying
 * nobody is talking. On a long stream with a background track that one entry
 * actively promoted the stretches with no speech in them.
 */
const REACTION_PATTERN = /[[(](risas|reír|aplausos|applause|laughter|gritos|cheers)[\])]/i;

/** Markers that mean the opposite: whisper heard something other than speech. */
const NON_SPEECH_PATTERN =
  /[[(](música|music|musica|silencio|silence|ruido|noise|sonido|applause-free|inaudible|blank_audio)[\])]/i;

/**
 * Whisper's stock inventions over silence, which it emits verbatim.
 *
 * It writes these with real timestamps in the middle of dead air, and three
 * invented words are enough to seed a candidate window. Proved on this
 * machine: asked to transcribe 30 seconds of digital silence between two bits
 * of speech, the turbo model produced "Tiene cosas chismas."
 *
 * The VAD model prevents most of this at the source, so this list is the
 * second line of defence - it still matters for the YouTube-captions path and
 * for any install without the VAD model.
 */
const HALLUCINATION_PATTERNS = [
  /subt[íi]tulos?\s+(realizados?|creados?|por)/i,
  /amara\.org/i,
  /gracias\s+por\s+ver/i,
  /no\s+olvides\s+suscribirte/i,
  /suscr[íi]be(te|nse)\s+al\s+canal/i,
  /dale\s+like\s+y\s+suscr[íi]bete/i,
  /www\.|https?:\/\//i,
  /^[\s.·¡!¿?-]*$/,
];

/**
 * Openings that mean the clip starts halfway through a thought.
 *
 * This is Opus Clip's "flow" dimension, and it is the cheapest real signal
 * there is: a clip that opens on "y entonces..." or "pero bueno..." drops the
 * viewer into the middle of something they did not hear the start of. The
 * reporting on short-form retention is consistent that the opening one to
 * three seconds decides whether anyone stays, so an opening that cannot stand
 * alone wastes the only moment that counts.
 */
const CONTINUATION_PATTERN =
  /^\s*(y|e|pero|porque|entonces|as[íi]|o sea|osea|tambi[ée]n|adem[áa]s|igual|total|bueno|pues|luego|despu[ée]s|aunque|sino|ni|es que|lo que|si no|ah|eh)\b/i;

/**
 * Openings that stop the scroll on their own.
 *
 * Drawn from what the 2026 write-ups on short-form hooks agree on: a question
 * the viewer wants answered, a contrarian claim, a confession, or a number.
 * Unlike HOOK_PHRASES below these are only ever checked on the *first*
 * sentence of a window, because that is the only place they do this job.
 */
const OPENING_HOOK_PATTERN =
  /^\s*(¿|nadie|nunca|jamás|jamas|la verdad|te voy|déjame|dejame|imag[íi]nate|escucha|mira|resulta|lo peor|lo mejor|el error|el secreto|la clave|yo cre[íi]a|me di cuenta|aprend[íi]|perd[íi]|gan[ée]|\d)/i;

/**
 * Words no thought ends on.
 *
 * Neither of the obvious end-of-idea signals works on this transcript.
 * Whisper writes a full stop at every pause, and with voice activity
 * detection the word timings come back contiguous - on a real hour of
 * television 98 % of the gaps between words were exactly zero - so there is
 * rarely a pause to find. But a clip whose last word is "y", "de", "mi" or
 * "que" is unfinished by definition, whatever the punctuation claims: a real
 * run ended one on "...menores de edad. Y" with "nadie hacía nada" right
 * after the cut. This is the one completeness test that needs no judgement.
 */
const DANGLING_END =
  /(^|\s)(y|e|o|u|ni|pero|que|porque|pues|de|del|a|al|en|con|por|para|sin|sobre|entre|hasta|desde|el|la|los|las|un|una|unos|unas|lo|mi|mis|tu|tus|su|sus|nuestro|nuestra|se|me|te|le|les|nos|como|cuando|donde|si|muy|m[áa]s|tan|es|era|fue|est[áa]|hay)[\s.,;:…-]*$/i;

/** Whether a sentence stops on a word that needs something after it. */
export function endsOnDanglingWord(text: string): boolean {
  const trimmed = text.trim();
  // A trailing comma, colon or semicolon is the speaker mid-sentence: a real
  // run ended a clip on "...así cacharrados. No," with "pero estás muy
  // grande" right after.
  if (/[,;:]$/.test(trimmed)) return true;
  return DANGLING_END.test(trimmed);
}

/**
 * Whether a clip ending here leaves the viewer waiting for something.
 *
 * A dangling word, or a question. The question case is the bigger one in
 * practice: on an hour of street-interview television, 8 of 20 clips ended
 * on the presenter's question with the answer - which is the payoff - right
 * after the cut: "...¿cómo es su nombre?" | "Cristian, dígamelo en oscuro".
 */
export function needsContinuation(text: string): boolean {
  return endsOnDanglingWord(text) || /\?\s*$/.test(text.trim());
}

/** Whether a line is whisper talking to itself rather than the speaker talking. */
export function isHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Spanish cue phrases that tend to open a retained clip.
 *
 * These are openers and framing devices, not topic words: the point is to find
 * where someone starts making a claim, not what the claim is about.
 */
const HOOK_PHRASES = [
  'nadie te',
  'nadie sabe',
  'la verdad es',
  'el secreto',
  'el error',
  'el problema es',
  'lo que pasa es',
  'te voy a',
  'déjame decirte',
  'escucha esto',
  'imagínate',
  'resulta que',
  'en realidad',
  'lo más importante',
  'nunca ',
  'siempre ',
  'jamás',
  'por eso',
  'la clave',
  'aprendí',
  'me di cuenta',
  'no vas a creer',
  'lo peor',
  'lo mejor',
  'deja de',
  'tienes que',
  'hay que',
];

const NUMBER_PATTERN = /\b(uno|dos|tres|cuatro|cinco|primero|segundo|tercero|\d+)\b/i;

/** Splits words into sentences on terminal punctuation or a clear pause. */
export function buildSentences(words: TranscriptWord[], pauseSeconds = 0.75): Sentence[] {
  const sentences: Sentence[] = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((w) => w.text).join(' ').trim();
    if (text) {
      sentences.push({
        text,
        start: current[0].start,
        end: current[current.length - 1].end,
        words: current,
        score: 0,
        reasons: [],
      });
    }
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    const next = words[i + 1];
    const endsSentence = /[.!?…]$/.test(words[i].text);
    const longPause = next ? next.start - words[i].end >= pauseSeconds : true;
    if (endsSentence || longPause) flush();
  }

  flush();
  return sentences.map(scoreSentence);
}

function scoreSentence(sentence: Sentence): Sentence {
  const lower = sentence.text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (REACTION_PATTERN.test(sentence.text)) {
    score += 30;
    reasons.push('reacción del público');
  }

  // A non-speech marker cannot carry a clip, and a window seeded on one is a
  // window where nobody talks. Pushed below zero so it can never seed.
  if (NON_SPEECH_PATTERN.test(sentence.text)) {
    return { ...sentence, score: -100, reasons: ['sin voz'] };
  }

  if (isHallucination(sentence.text)) {
    return { ...sentence, score: -100, reasons: ['texto inventado sobre silencio'] };
  }

  if (/[?¿]/.test(sentence.text)) {
    score += 14;
    reasons.push('pregunta');
  }

  if (/[!¡]/.test(sentence.text)) {
    score += 8;
    reasons.push('énfasis');
  }

  const matchedHook = HOOK_PHRASES.find((phrase) => lower.includes(phrase));
  if (matchedHook) {
    score += 18;
    reasons.push(`frase de gancho ("${matchedHook.trim()}")`);
  }

  if (NUMBER_PATTERN.test(lower)) {
    score += 6;
    reasons.push('enumeración');
  }

  // Delivery speed. A burst of words per second usually means the speaker is
  // animated; a crawl usually means dead air.
  const duration = Math.max(0.3, sentence.end - sentence.start);
  const rate = sentence.words.length / duration;
  if (rate > 3.4) {
    score += 10;
    reasons.push('ritmo alto');
  } else if (rate < 1.2) {
    score -= 8;
  }

  // Very short fragments rarely stand on their own.
  if (sentence.words.length < 4) score -= 10;

  return { ...sentence, score, reasons };
}

export interface FindClipsOptions {
  minDuration?: number;
  maxDuration?: number;
  maxClips?: number;
  /** Total media duration, used to spread clips across the timeline. */
  totalDuration: number;
  /**
   * The longest silence a clip may contain, in seconds.
   *
   * Measured on real whisper output, the gap between consecutive words in
   * continuous Spanish speech never exceeded 0.74 s (p98 0.67 s), so 2.5 s is
   * far above anything a speaker does mid-thought while still being obviously
   * a hole to a viewer.
   */
  maxGap?: number;
  /**
   * What the window grows towards, in seconds.
   *
   * Distinct from minDuration, and the distinction matters: the loop used to
   * stop the moment it passed the minimum, so practically every clip came out
   * at fifteen seconds - long enough to open an idea and never long enough to
   * finish one. Reported as "the clip ends unresolved", which is exactly what
   * a fifteen-second cut out of a conversation does.
   */
  targetDuration?: number;
  /**
   * The least fraction of a clip that must have someone speaking in it.
   *
   * Real continuous speech measures about 90 % by this metric, so 0.6 leaves
   * generous room for breaths and sentence boundaries. It exists because
   * window length used to be measured as the span from the first word to the
   * last, counting a 24-second silence between two short remarks as a
   * perfectly good 26-second clip.
   */
  minSpeechRatio?: number;
  /**
   * Drop candidates scoring below this fraction of the best one found.
   *
   * Without it, filling a quota meant shipping whatever the weakest stretch of
   * the video had to offer. A six-hour stream has long passages with nothing
   * in them, and returning six clips worth watching beats twenty where
   * fourteen get deleted.
   */
  minScoreRatio?: number;
  /**
   * Reports what was thrown away, so the UI can explain a small result.
   *
   * Six hours of a just-chatting stream yielding five clips looks like the app
   * failing unless it says it rejected ninety windows for being mostly
   * silence.
   */
  onStats?: (stats: FindClipsStats) => void;
}

export interface FindClipsStats {
  /** Windows rejected for containing a silence longer than maxGap. */
  tooSparse: number;
  /** Windows rejected for being shorter than the minimum. */
  tooShort: number;
  /** Candidates dropped as near-duplicates of a stronger one. */
  duplicates: number;
  /** Candidates dropped for scoring too far below the best. */
  belowBar: number;
  kept: number;
}

/**
 * Seconds of actual speech in a run of sentences, overlaps merged.
 *
 * Reads the per-word timings rather than sentence bounds, so a sentence whose
 * words straddle a pause is counted honestly.
 */
function voicedSeconds(sentences: Sentence[]): number {
  let total = 0;
  let cursor = -Infinity;

  for (const sentence of sentences) {
    for (const word of sentence.words) {
      const from = Math.max(word.start, cursor);
      if (word.end > from) {
        total += word.end - from;
        cursor = word.end;
      }
    }
  }

  return total;
}

/**
 * Builds candidate windows around the strongest sentences.
 *
 * Windows always begin and end on a sentence boundary: a clip that starts
 * mid-phrase reads as broken no matter how good the moment inside it is.
 */
export function findClipCandidates(
  words: TranscriptWord[],
  options: FindClipsOptions
): ClipCandidate[] {
  const {
    minDuration = 15,
    maxDuration = 60,
    maxClips = 12,
    totalDuration,
    // Raised from 2.5: real conversation pauses to think, and cutting the
    // window at the first two-and-a-half-second gap left ideas unfinished.
    // The density floor below is what actually keeps silence out - one four
    // second gap in a fifteen second clip is still 73 % speech - and speech
    // cleanup shortens the pause on export anyway.
    maxGap = 4,
    minSpeechRatio = 0.6,
    minScoreRatio = 0.35,
    targetDuration = 32,
  } = options;

  // Grow towards the target, but never past the hard ceiling.
  const growTo = Math.min(Math.max(minDuration, targetDuration), maxDuration);

  const sentences = buildSentences(words);
  if (sentences.length === 0) return [];

  const candidates: ClipCandidate[] = [];
  let tooShort = 0;
  let tooSparse = 0;

  /**
   * The silence either side of a sentence, which is what actually marks where
   * a thought starts and stops.
   *
   * Whisper's punctuation does not: it writes a full stop at any pause, so a
   * clip ending "la gente dice que aún, que aún es." passes a check for
   * terminal punctuation while being obviously cut in half. The timings are
   * the honest signal, and they are the one thing whisper measures rather
   * than guesses.
   */
  const gapBefore = (index: number) =>
    index === 0 ? Infinity : sentences[index].start - sentences[index - 1].end;
  const gapAfter = (index: number) =>
    index >= sentences.length - 1 ? Infinity : sentences[index + 1].start - sentences[index].end;

  /** A pause long enough to be someone finishing, not just breathing. */
  const BREAK = 0.45;

  for (let i = 0; i < sentences.length; i++) {
    const startSentence = sentences[i];

    // Only seed a window where something actually happens.
    if (startSentence.score <= 0) continue;

    /**
     * A one or two word fragment can never carry an opening: one run on a
     * real hour of television opened a clip on the single word "maricas."
     *
     * That stays a hard filter. Opening mid-flow does not - rejecting those
     * outright emptied the pool before the model could choose, taking the
     * same hour from four clips down to two, so it is scored down below and
     * the ranking decides.
     */
    if (startSentence.words.length < 3) continue;

    let end = i;
    let duration = startSentence.end - startSentence.start;

    // Grow towards the target length, not merely past the minimum.
    while (end + 1 < sentences.length && duration < growTo) {
      // Never grow across a silence. This is the whole defect that produced
      // clips where nobody speaks: the loop used to measure only how far apart
      // the first and last sentence were, so two short remarks either side of
      // a 24-second hole counted as a 26-second clip. A clip with a hole in it
      // reads as broken however good the words on both sides are.
      if (sentences[end + 1].start - sentences[end].end > maxGap) break;

      // A non-speech marker or an invented line must not be swallowed into an
      // otherwise good window either.
      if (sentences[end + 1].score <= -100) break;

      end += 1;
      duration = sentences[end].end - startSentence.start;
      if (duration > maxDuration) break;
    }

    // Trim back if the last sentence pushed it over the limit.
    while (end > i && sentences[end].end - startSentence.start > maxDuration) {
      end -= 1;
    }

    /**
     * Pull the ending back to the last place the speaker actually stopped.
     *
     * Walks back at most a few sentences, and never below the minimum length,
     * so a clip gives up a little duration in exchange for not ending on
     * "Bueno, 10 de estos. Epa."
     */
    // First a dangling ending is pushed forward, since the rest of the
    // sentence is usually the next one: "...menores de edad. Y" | "nadie
    // hacía nada." Only then is the end pulled back to a real stop.
    while (
      end + 1 < sentences.length &&
      needsContinuation(sentences[end].text) &&
      sentences[end + 1].end - startSentence.start <= maxDuration &&
      sentences[end + 1].start - sentences[end].end <= maxGap
    ) {
      end += 1;
    }

    const cleanStop = (index: number, needPause: boolean) =>
      !needsContinuation(sentences[index].text) &&
      (!needPause || gapAfter(index) >= BREAK) &&
      sentences[index].end - startSentence.start >= minDuration;

    // Prefer an ending where the speaker both finished the phrase and paused,
    // then settle for one that at least finished the phrase.
    let settled = false;
    for (const needPause of [true, false]) {
      for (let back = end; back > i && end - back < 4; back -= 1) {
        if (cleanStop(back, needPause)) {
          end = back;
          settled = true;
          break;
        }
      }
      if (settled) break;
    }

    const window = sentences.slice(i, end + 1);
    const windowDuration = window[window.length - 1].end - startSentence.start;

    // Below this a clip is a fragment, not a moment.
    if (windowDuration < Math.min(minDuration, 12)) {
      tooShort += 1;
      continue;
    }

    // How much of the window anyone actually spends talking. The gap limit
    // above bounds any single hole; this bounds their sum, which is what
    // catches a window stitched out of many short pauses.
    if (voicedSeconds(window) / windowDuration < minSpeechRatio) {
      tooSparse += 1;
      continue;
    }

    /**
     * The opening counts for more than the rest.
     *
     * Every sentence used to weigh the same, so a window whose one good
     * moment sat at the end scored like one that opened with it. Short-form
     * does not work that way: nobody reaches the end of a clip whose first
     * seconds gave them no reason to stay.
     */
    const body = window.slice(1).reduce((sum, s) => sum + Math.max(0, s.score), 0);
    let totalScore = Math.max(0, startSentence.score) * 2.5 + body;

    const reasons = Array.from(new Set(window.flatMap((s) => s.reasons)));

    if (OPENING_HOOK_PATTERN.test(startSentence.text)) {
      totalScore += 25;
      reasons.unshift('abre con gancho');
    }

    // Starting mid-thought, by either signal: the words used, or the speaker
    // not having stopped first.
    if (CONTINUATION_PATTERN.test(startSentence.text)) {
      totalScore *= 0.45;
      reasons.unshift('empieza a media frase');
    } else if (gapBefore(i) < BREAK) {
      totalScore *= 0.7;
      reasons.unshift('arranca sin pausa previa');
    }

    // Ending without the speaker pausing means the idea is still in motion.
    // This replaces a check for terminal punctuation, which measured nothing:
    // whisper writes a full stop at every pause, so "que aún es." passed it.
    if (endsOnDanglingWord(window[window.length - 1].text)) {
      totalScore *= 0.5;
      reasons.push('acaba a media frase');
    } else if (/\?\s*$/.test(window[window.length - 1].text.trim())) {
      totalScore *= 0.6;
      reasons.push('acaba en una pregunta sin respuesta');
    } else if (gapAfter(end) < BREAK) {
      totalScore *= 0.85;
      reasons.push('corta sin pausa');
    }

    // Favour clips near the sweet spot for short-form retention.
    const idealness = 1 - Math.min(1, Math.abs(windowDuration - 32) / 45);

    const best = [...window].sort((a, b) => b.score - a.score)[0];

    candidates.push({
      startSeconds: Math.max(0, Math.round(startSentence.start * 10) / 10),
      endSeconds: Math.round(window[window.length - 1].end * 10) / 10,
      text: window.map((s) => s.text).join(' '),
      score: totalScore * (0.7 + 0.3 * idealness),
      reasons,
      hookSentence: startSentence.text,
      bestQuote: best.text,
    });
  }

  // The quality floor is applied before the spread, not after: with fewer
  // candidates than slots spreadAcrossTimeline returns everything untouched,
  // so a check placed after it would never run on the videos that need it.
  const deduped = dedupeOverlaps(candidates);
  const aboveBar = applyScoreFloor(deduped, minScoreRatio);
  const final = spreadAcrossTimeline(aboveBar, totalDuration, maxClips);

  options.onStats?.({
    tooSparse,
    tooShort,
    duplicates: candidates.length - deduped.length,
    belowBar: deduped.length - aboveBar.length,
    kept: final.length,
  });

  return final;
}

/**
 * Significant words of a candidate, for the near-duplicate check.
 *
 * Accents are folded and short words dropped so that "porque" and "porqué"
 * count as the same word and "de"/"la"/"que" count as none.
 */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
  );
}

/**
 * How much of the smaller of two word sets the two share, 0-1.
 *
 * Containment rather than Jaccard, so a short window whose every word also
 * appears in a longer one is recognised as the same material.
 */
function sharedWordRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Keeps only candidates within reach of the best one found.
 *
 * The user asked for few and good over many and padded: from six hours of a
 * just-chatting stream, five clips worth posting beats twenty where fourteen
 * get deleted on sight.
 */
function applyScoreFloor(candidates: ClipCandidate[], minScoreRatio: number): ClipCandidate[] {
  if (candidates.length === 0) return candidates;

  const best = Math.max(...candidates.map((c) => c.score));
  if (best <= 0) return [];

  return candidates.filter((candidate) => candidate.score >= best * minScoreRatio);
}

/** Keeps the strongest of any group of windows that overlap substantially. */
function dedupeOverlaps(candidates: ClipCandidate[]): ClipCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: Array<{ candidate: ClipCandidate; words: Set<string> }> = [];

  for (const candidate of sorted) {
    const words = wordSet(candidate.text);

    const clashes = kept.some(({ candidate: existing, words: existingWords }) => {
      const overlap =
        Math.min(existing.endSeconds, candidate.endSeconds) -
        Math.max(existing.startSeconds, candidate.startSeconds);
      const shorter = Math.min(
        existing.endSeconds - existing.startSeconds,
        candidate.endSeconds - candidate.startSeconds
      );

      // Was 0.4, which let four windows of the same monologue through on a
      // 35 % overlap. A fifth of the shorter clip shared is already a repeat.
      if (overlap > shorter * 0.2) return true;

      // People repeat themselves, streamers most of all, so two windows can
      // barely overlap in time and still be the same clip to a viewer.
      return sharedWordRatio(words, existingWords) > 0.8;
    });

    if (!clashes) kept.push({ candidate, words });
  }

  return kept.map((entry) => entry.candidate);
}

/**
 * Picks the final set so it covers the whole video.
 *
 * Taking the top N by score alone tends to return a cluster from whichever
 * stretch happened to be liveliest, leaving the rest of the video unmined.
 */
function spreadAcrossTimeline(
  candidates: ClipCandidate[],
  totalDuration: number,
  maxClips: number
): ClipCandidate[] {
  if (candidates.length <= maxClips) {
    return [...candidates].sort((a, b) => a.startSeconds - b.startSeconds);
  }

  const buckets = Math.min(maxClips, Math.max(3, Math.ceil(maxClips / 1.5)));
  const bucketSize = Math.max(1, totalDuration / buckets);
  const chosen: ClipCandidate[] = [];
  const used = new Set<ClipCandidate>();

  // One pass taking the best from each slice of the timeline...
  for (let b = 0; b < buckets; b++) {
    const from = b * bucketSize;
    const to = (b + 1) * bucketSize;
    const inBucket = candidates
      .filter((c) => !used.has(c) && c.startSeconds >= from && c.startSeconds < to)
      .sort((a, b2) => b2.score - a.score);

    if (inBucket[0]) {
      chosen.push(inBucket[0]);
      used.add(inBucket[0]);
    }
  }

  // ...then fill the remaining slots with the best of what is left.
  const rest = candidates
    .filter((c) => !used.has(c))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxClips - chosen.length));

  return [...chosen, ...rest].sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Maps a raw signal total onto the 1-100 scale the UI shows.
 *
 * Deliberately capped below the high 90s: these are transcript signals, not a
 * judgement about whether something will actually travel, and a heuristic that
 * claims 99 would be lying.
 */
export function normalizeScore(raw: number, maxRaw: number): number {
  if (maxRaw <= 0) return 70;
  const ratio = Math.max(0, Math.min(1, raw / maxRaw));
  return Math.round(62 + ratio * 30);
}
