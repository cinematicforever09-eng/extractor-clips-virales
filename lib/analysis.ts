import { transcribe, findWhisper, groupWordsIntoLines, type TranscriptWord } from './whisper.js';
import {
  buildSentences,
  needsContinuation,
  findClipCandidates,
  normalizeScore,
  type ClipCandidate,
  type FindClipsStats,
} from './clip-finder.js';
import { getOllamaStatus, generateJson } from './ollama.js';
import { getDelivered, overlapsDelivered, recordDelivered } from './clip-history.js';
import { loadTranscript, saveTranscript } from './transcript-cache.js';
import type { TranscriptChunk } from './subtitles.js';

/**
 * Turns a video into clip suggestions, entirely on this machine.
 *
 * Two stages, deliberately separate:
 *
 *   1. Transcribe with whisper.cpp, which gives per-word timestamps and marks
 *      audience reactions like "(risas)".
 *   2. Score windows of that transcript with the heuristic clip finder, then -
 *      only if Ollama is running - hand the top candidates to a local model to
 *      write the title, hook and social copy.
 *
 * The split matters. A local 7B model asked to read half an hour of transcript
 * and return timestamps invents them; asked to write copy for a window it is
 * handed, it does well. It also means the app still produces clips with no
 * language model installed at all.
 */

export type AnalysisEngine = 'heuristic' | 'ollama';
export type TranscriptionMode = 'auto' | 'whisper' | 'captions';

export interface SubtitleWord {
  text: string;
  /** Seconds relative to the start of the clip. */
  start: number;
  end: number;
}

export interface SubtitleLineOut {
  text: string;
  startTime: number;
  endTime: number;
  /** Real per-word timings, when the transcript came from whisper. */
  words?: SubtitleWord[];
}

export interface ClipOut {
  clipId: string;
  title: string;
  hook: string;
  description: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  targetPlatforms: string[];
  viralityScore: number;
  viralityMetrics: {
    hookImpact: number;
    retentionPotential: number;
    shareability: number;
    emotionalTrigger: string;
  };
  viralityJustification: string;
  soundBiteQuote?: string;
  suggestedSubtitles: SubtitleLineOut[];
  socialPost: { caption: string; hashtags: string[]; callToAction: string };
}

export interface AnalysisResult {
  summary: string;
  engine: AnalysisEngine;
  transcriptionSource: 'whisper' | 'captions' | 'none';
  language?: string;
  suggestedClips: ClipOut[];
}

export interface AnalyzeVideoInput {
  /** Path to the prepared media file on this machine. */
  videoPath?: string;
  duration: number;
  fileName?: string;
  contextNotes?: string;
  /** Captions fetched from YouTube, used when whisper is unavailable. */
  transcript?: TranscriptChunk[];
  transcriptionMode?: TranscriptionMode;
  /**
   * ISO code to force, or 'auto'.
   *
   * Auto samples across the file rather than trusting the first 30 seconds,
   * but an explicit choice still wins: a bilingual video, or one that opens in
   * another language, is something only the user can settle.
   */
  language?: string;
  /**
   * Identifies the video across uploads, so clips already delivered for it
   * are skipped and each upload brings new ones. See lib/clip-history.ts.
   */
  historyKey?: string;
  /** Ignore the history and allow clips that were delivered before. */
  allowRepeats?: boolean;
  onProgress?: (stage: string, fraction: number) => void;
  signal?: AbortSignal;
  /**
   * Words already transcribed elsewhere (live mode transcribes a stream piece
   * by piece). When present, no transcription runs here.
   */
  words?: TranscriptWord[];
  /**
   * Live mode. Only windows ending by `maxEnd` are considered - past that the
   * stream has not shown whether the idea closes yet - and nothing is forced:
   * a stretch with nothing striking returns no clips instead of the best of a
   * weak lot, and running out of material is not an error.
   */
  live?: {
    maxEnd: number;
    /** Lowest overall score (0-100) a clip may have. */
    minScore: number;
    /** Lowest hook score: the first seconds are what stop the scroll. */
    minHook: number;
    /** At most this many clips per round. */
    maxClips: number;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How many clips one analysis delivers.
 *
 * Ten, whatever the length: the user asked for ten good clips per upload
 * rather than twenty of mixed quality, and gets more by uploading again -
 * the delivery history makes the next upload bring the next ten. A short
 * video simply yields fewer, because nothing below the quality bar is used to
 * make up the number.
 */
function clipTargets(_duration: number): { minClips: number; maxClips: number } {
  return { minClips: 1, maxClips: 10 };
}

/**
 * Turns caption chunks into pseudo-words.
 *
 * Only used when whisper is unavailable. Caption timings are per phrase, so the
 * words inside are spread out by length - the same approximation the caption
 * animation used to make everywhere, kept here as the degraded path.
 */
function wordsFromCaptions(chunks: TranscriptChunk[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];

  for (const chunk of chunks) {
    const parts = chunk.text.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;

    const duration = Math.max(0.4, chunk.duration || 2.5);
    const weights = parts.map((p) => p.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);

    let cursor = chunk.start;
    parts.forEach((part, index) => {
      const share = (weights[index] / total) * duration;
      words.push({
        text: part,
        start: Math.round(cursor * 100) / 100,
        end: Math.round((cursor + share) * 100) / 100,
      });
      cursor += share;
    });
  }

  return words;
}

/** Builds caption lines for one clip window, with times relative to its start. */
function subtitlesForWindow(
  words: TranscriptWord[],
  startSeconds: number,
  endSeconds: number
): SubtitleLineOut[] {
  const inWindow = words.filter((w) => w.end > startSeconds && w.start < endSeconds);
  if (inWindow.length === 0) return [];

  return groupWordsIntoLines(inWindow).map((line) => ({
    text: line.text,
    startTime: Math.max(0, round1(line.start - startSeconds)),
    endTime: round1(Math.min(endSeconds, line.end) - startSeconds),
    words: line.words.map((w) => ({
      text: w.text,
      start: Math.max(0, Math.round((w.start - startSeconds) * 100) / 100),
      end: Math.round((Math.min(endSeconds, w.end) - startSeconds) * 100) / 100,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Copy generation
// ---------------------------------------------------------------------------

const PLATFORMS = ['TikTok', 'Instagram Reels', 'YouTube Shorts'];

/** Trims a sentence into something usable as a title. */
function toTitle(text: string, maxLength = 58): string {
  const clean = text.replace(/^[\s\-–—]+/, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/**
 * Copy written without a language model.
 *
 * Quotes the speaker instead of inventing a pitch: an honest excerpt reads
 * better than a template trying to sound like a marketer, and it keeps the
 * promise that nothing is put in the speaker's mouth.
 */
function templateCopy(candidate: ClipCandidate): Pick<
  ClipOut,
  'title' | 'hook' | 'description' | 'socialPost' | 'viralityJustification'
> {
  const reasons = candidate.reasons.length > 0 ? candidate.reasons.join(', ') : 'ritmo sostenido';

  return {
    title: toTitle(candidate.bestQuote || candidate.hookSentence),
    hook: candidate.hookSentence,
    description: `Fragmento de ${Math.round(candidate.endSeconds - candidate.startSeconds)} s. Señales detectadas: ${reasons}.`,
    viralityJustification: `Seleccionado por señales del transcript: ${reasons}. Sin modelo de lenguaje instalado, así que esto es una estimación por señales, no un juicio editorial.`,
    socialPost: {
      caption: `"${toTitle(candidate.bestQuote, 120)}"`,
      hashtags: ['#reels', '#viral', '#shorts'],
      callToAction: '¿Qué opinas? Cuéntamelo en los comentarios 👇',
    },
  };
}

interface OllamaClipCopy {
  index: number;
  title: string;
  hook: string;
  description: string;
  emotionalTrigger: string;
  justification: string;
  caption: string;
  hashtags: string[];
  callToAction: string;
  score: number;
}

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          title: { type: 'string' },
          hook: { type: 'string' },
          description: { type: 'string' },
          emotionalTrigger: { type: 'string' },
          justification: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          callToAction: { type: 'string' },
          score: { type: 'integer' },
        },
        // justification, emotionalTrigger y callToAction van en required
        // porque la interfaz los presenta como juicio del modelo. Cuando
        // faltaban, el texto de respaldo decía "sin modelo de lenguaje
        // instalado" justo encima de un copy que sí había escrito el modelo.
        required: [
          'index',
          'title',
          'hook',
          'description',
          'emotionalTrigger',
          'justification',
          'caption',
          'hashtags',
          'callToAction',
          'score',
        ],
      },
    },
  },
  required: ['clips'],
} as const;

/**
 * The model's verdict on one candidate window.
 *
 * Separate from the copy pass on purpose. Writing a title for a window and
 * deciding whether the window is worth posting are different jobs, and merging
 * them is what produced twenty clips from a six-hour stream where nobody had
 * asked whether any of them were any good.
 */
export interface OllamaJudgement {
  index: number;
  /** Does the opening on its own stop someone scrolling? 0-100. */
  hook: number;
  /** Complete idea, starts and ends cleanly? 0-100. */
  flow: number;
  /** Is there a payoff worth the watch? 0-100. */
  value: number;
  score: number;
  worthPosting: boolean;
  reason: string;
}

const RANK_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          hook: { type: 'integer' },
          flow: { type: 'integer' },
          value: { type: 'integer' },
          score: { type: 'integer' },
          worthPosting: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'hook', 'flow', 'value', 'score', 'worthPosting', 'reason'],
      },
    },
  },
  required: ['clips'],
} as const;

/**
 * Has the local model judge which shortlisted windows are actually worth
 * posting, before anyone writes copy for them.
 *
 * The transcript heuristics are good at finding where someone is talking
 * energetically and useless at telling whether what they said is interesting:
 * the hook list matches "siempre", "nunca" and "hay que", which in six hours
 * of casual streaming fire thousands of times. A 7B model cannot be trusted to
 * invent timestamps, but it can read a window it is handed and say whether
 * there is a moment in it. That split is the same one the rest of this file
 * already makes.
 *
 * The output is deliberately cheap - a number, a flag and a short reason - so
 * ranking a shortlist two and a half times longer than the final set still
 * generates far fewer tokens than writing full copy for all of it.
 */
/**
 * How many windows go into one judging call.
 *
 * Not a tuning knob so much as a correctness one. Everything in one request
 * meant a prompt past ten thousand tokens against a 4096-token context, so
 * most of the list was cut off before the model saw it, and the request took
 * so long it hit the timeout and fell back to no judging at all. Small
 * batches keep every window inside the window, and a slow batch costs one
 * batch rather than the whole pass.
 */
const RANK_BATCH = 8;

/** Runs the judging in batches, keeping each prompt inside the context. */
export async function ollamaRank(
  candidates: ClipCandidate[],
  contextNotes: string | undefined
): Promise<Map<number, OllamaJudgement>> {
  const merged = new Map<number, OllamaJudgement>();

  for (let offset = 0; offset < candidates.length; offset += RANK_BATCH) {
    const batch = candidates.slice(offset, offset + RANK_BATCH);

    try {
      let verdicts = await rankBatch(batch, contextNotes);

      /**
       * An incomplete answer is retried rather than read as rejection.
       *
       * A missing verdict counts as "not worth posting", which is right when
       * the model leaves filler out on purpose - and badly wrong when the
       * answer was cut short because the GPU was busy. Run alongside a second
       * analysis, the same hour of video went from fifteen approved clips to
       * four, with no error anywhere. One retry tells the two apart cheaply.
       */
      if (verdicts.size < batch.length) {
        const retry = await rankBatch(batch, contextNotes).catch(() => null);
        if (retry && retry.size > verdicts.size) verdicts = retry;
      }
      // Indices are per batch, so shift them back to the caller's numbering.
      for (const [index, verdict] of verdicts) {
        if (index >= 0 && index < batch.length) {
          merged.set(offset + index, { ...verdict, index: offset + index });
        }
      }
    } catch (error) {
      // One slow or malformed batch should not throw away the others.
      console.warn(
        `[analysis] falló el lote ${offset}-${offset + batch.length - 1} al puntuar:`,
        error instanceof Error ? error.message.slice(0, 160) : error
      );
    }
  }

  return merged;
}

async function rankBatch(
  candidates: ClipCandidate[],
  contextNotes: string | undefined
): Promise<Map<number, OllamaJudgement>> {
  // The opening is quoted on its own line. Asked to judge a wall of text, the
  // model grades the whole paragraph; the viewer only ever sees the start.
  const listing = candidates
    .map(
      (c, index) =>
        `[${index}] ${Math.round(c.startSeconds)}s-${Math.round(c.endSeconds)}s
ARRANQUE: "${c.hookSentence.slice(0, 160)}"
COMPLETO: "${c.text.slice(0, 600)}"`
    )
    .join('\n\n');

  const parsed = await generateJson<{ clips?: OllamaJudgement[] }>({
    system: `Eres un editor de clips virales con criterio exigente. Juzgas fragmentos de un video largo y dices cuáles valen la pena publicar.
La mayor parte de un directo largo es relleno: saludos, pausas, comentarios sueltos que no llevan a ninguna parte. Decirlo es tu trabajo, no un fallo.
Sé duro. Es mejor aprobar tres fragmentos buenos que quince mediocres.
Lo más importante: el espectador decide en los primeros dos segundos. Si el ARRANQUE no le da una razón para quedarse, da igual lo bueno que sea el resto, porque no llega a verlo.`,
    prompt: `${contextNotes ? `Objetivo del usuario: "${contextNotes}"\n\n` : ''}Devuelve un objeto por CADA fragmento de la lista, también por los que rechaces. Son ${candidates.length} fragmentos, así que tienen que salir ${candidates.length} objetos, con los índices del 0 al ${candidates.length - 1}.

Para cada uno:
- index: el número del fragmento, tal cual
- hook: 0-100. Juzga SOLO la línea ARRANQUE, como si fuera lo único que se ve.
    90+ = pregunta que pica, cifra concreta, confesión, o algo que contradice
          lo que la gente da por hecho
    50  = se entiende, pero no da ninguna razón para quedarse
    20- = empieza a media frase, responde a algo que no se oyó, o es un saludo
- flow: 0-100. ¿Es una idea completa? Empieza por el principio y llega a un
    final. Si hay que haber visto lo anterior para entenderlo, baja de 40.
- value: 0-100. ¿Qué se lleva quien lo ve? Una historia con remate, un dato que
    pueda usar, una opinión que le haga reaccionar, o una risa de verdad.
    Si la respuesta es "nada", es menos de 30.
- score: 0-100, tu nota global. El hook pesa más que los otros dos juntos: un
    fragmento con hook 30 no pasa de 45 por bueno que sea el resto.
- worthPosting: true solo si lo publicarías tal cual en la cuenta de un cliente
- reason: una frase corta diciendo por qué

Aprueba un fragmento si arranca bien Y además tiene al menos una de estas cosas:
· una historia o anécdota con algo que pasa y un remate
· una opinión fuerte, una queja o algo polémico
· algo gracioso, absurdo o inesperado
· un dato concreto, una cifra o un consejo que se pueda aplicar
· una confesión o un error propio contado sin excusas

Recházalo si es: saludos o despedidas, hablar del propio directo o del chat,
divagar sin llegar a nada, responder a algo que no se oye, una frase suelta sin
contexto, o cualquier cosa que empiece a mitad de una idea.

FRAGMENTOS:
${listing}`,
    schema: RANK_SCHEMA as unknown as Record<string, unknown>,
    // A judgement, not writing: no sampling noise, so the same video is
    // judged the same way every time it is sent.
    temperature: 0,
    timeoutMs: 180_000,
  });

  const map = new Map<number, OllamaJudgement>();
  for (const clip of parsed.clips ?? []) {
    if (typeof clip.index === 'number') map.set(clip.index, clip);
  }
  return map;
}

/** Asks the local model to write copy for candidates it did not have to find. */
/**
 * Windows per copy-writing call.
 *
 * Smaller than the judging batch because each item's output is far longer: a
 * title, a hook, a description, a caption and hashtags, against five numbers.
 */
const COPY_BATCH = 5;

/** Writes the copy in batches, for the same reason the judging is batched. */
async function ollamaCopy(
  candidates: ClipCandidate[],
  contextNotes: string | undefined
): Promise<Map<number, OllamaClipCopy>> {
  const merged = new Map<number, OllamaClipCopy>();

  for (let offset = 0; offset < candidates.length; offset += COPY_BATCH) {
    const batch = candidates.slice(offset, offset + COPY_BATCH);

    try {
      const written = await copyBatch(batch, contextNotes);
      for (const [index, copy] of written) {
        if (index >= 0 && index < batch.length) {
          merged.set(offset + index, { ...copy, index: offset + index });
        }
      }
    } catch (error) {
      // The clips are already chosen; the ones this batch covers fall back to
      // template copy rather than costing the whole run.
      console.warn(
        `[analysis] falló el lote ${offset}-${offset + batch.length - 1} al escribir copy:`,
        error instanceof Error ? error.message.slice(0, 160) : error
      );
    }
  }

  return merged;
}

async function copyBatch(
  candidates: ClipCandidate[],
  contextNotes: string | undefined
): Promise<Map<number, OllamaClipCopy>> {
  const listing = candidates
    .map(
      (c, index) =>
        `[${index}] ${Math.round(c.startSeconds)}s-${Math.round(c.endSeconds)}s\n"${c.text.slice(0, 700)}"`
    )
    .join('\n\n');

  const parsed = await generateJson<{ clips?: OllamaClipCopy[] }>({
    system: `Eres un editor de video viral para TikTok, Reels y Shorts. Escribes en español natural y directo.
Se te dan fragmentos YA SELECCIONADOS de un video, con su transcripción literal.
NO cambies los tiempos ni propongas otros fragmentos: solo escribe el texto de cada uno.
No inventes frases que el orador no haya dicho: el gancho debe ser una cita o un resumen fiel.`,
    prompt: `${contextNotes ? `Objetivo del usuario: "${contextNotes}"\n\n` : ''}Para cada fragmento devuelve un objeto con:
- index: el número del fragmento, tal cual
- title: título corto y con gancho (máx. 60 caracteres)
- hook: la frase de apertura, citada del fragmento
- description: una línea sobre qué ocurre
- emotionalTrigger: una palabra (Curiosidad, Humor, Asombro, Inspiración, Polémica...)
- justification: por qué funciona, en una frase
- caption: el texto del post, listo para pegar. Escríbelo así:
    · La PRIMERA línea es lo único que se ve antes del "ver más": tiene que
      frenar el scroll por sí sola. Que sea una afirmación concreta, una cifra
      o una pregunta incómoda sacada del fragmento, no un resumen.
    · Después, una o dos líneas que den contexto sin destripar el final.
    · Máximo 220 caracteres en total, 2 o 3 emojis bien puestos, nunca al
      principio de la primera línea.
    · Prohibido abrir con "En este clip", "Mira cómo", "Te cuento" o
      "Descubre": arrancan lento y es lo que escribe todo el mundo.
- hashtags: 4 o 5 hashtags relevantes
- callToAction: llamada a la acción
- score: del 60 al 95, tu estimación de potencial

FRAGMENTOS:
${listing}`,
    schema: COPY_SCHEMA as unknown as Record<string, unknown>,
    timeoutMs: 180_000,
  });

  const map = new Map<number, OllamaClipCopy>();
  for (const clip of parsed.clips ?? []) {
    if (typeof clip.index === 'number') map.set(clip.index, clip);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Where each clip starts and ends
// ---------------------------------------------------------------------------

/**
 * Lets the model move each clip's start and end to where the idea actually
 * begins and finishes.
 *
 * Neither mechanical signal can do this. Whisper writes a full stop at any
 * pause, so punctuation marks breaths rather than thoughts. And with voice
 * activity detection the word timings come back contiguous: measured on an
 * hour of real television, 98 % of the gaps between words were exactly zero
 * and only 128 in 9,562 words reached 0.45 s, so "end where the speaker
 * paused" almost never found a pause to end on. The clip simply stopped
 * wherever the length target ran out - which is the "the idea is left
 * unfinished" the user kept reporting.
 *
 * Whether a thought is complete is something you only know by reading it, so
 * the model reads it. It is shown the clip numbered sentence by sentence,
 * with a few sentences of lead-in before and of continuation after, and
 * picks the numbers. It never sees or invents a timestamp: the answer is two
 * indices into sentences whose timings come from whisper.
 */
/** Below this the model is saying "filler"; everything above is ranked, not gated. */
const FILLER_FLOOR = 30;

/** Extra approved clips refined beyond the target, to replace any that cannot close. */
const RESERVE_CLIPS = 5;

/** Sentences of continuation the model may extend a clip into. */
const FOLLOW_ON = 12;
const REFINED_MIN = 15;
// Opus Clip's own ceiling. At 70, street-interview clips whose answer ran
// long could not close: 5 per upload were dropped for that alone.
const REFINED_MAX = 90;

/** A candidate after boundary refinement; `unresolved` when no ending closes it. */
export type RefinedClip = ClipCandidate & { unresolved?: boolean };

export async function refineBoundaries(
  candidates: ClipCandidate[],
  words: TranscriptWord[],
  onClip?: (done: number, total: number) => void
): Promise<RefinedClip[]> {
  const sentences = buildSentences(words);
  if (sentences.length === 0) return candidates;

  const refined: RefinedClip[] = [];

  for (let n = 0; n < candidates.length; n += 1) {
    const clip = candidates[n];
    onClip?.(n, candidates.length);

    // Sentences that make up the clip as the finder cut it.
    const first = sentences.findIndex((s) => s.end > clip.startSeconds + 0.05);
    let last = first;
    while (last + 1 < sentences.length && sentences[last + 1].start < clip.endSeconds - 0.05) {
      last += 1;
    }
    if (first < 0) {
      refined.push(clip);
      continue;
    }

    const to = Math.min(sentences.length - 1, last + FOLLOW_ON);

    const hookAt = sentences.findIndex((s) => s.text === clip.hookSentence);
    const keyIndex = hookAt >= first && hookAt <= last ? hookAt : first;

    /**
     * The endings the model may choose from, already valid by construction.
     *
     * Asked for free start and end indices, a 7B model could not add up
     * durations - half its answers spanned 9 to 11 seconds - and one stretched
     * a clip to 72 seconds to finish on "¿cómo es su nombre?", a question with
     * no answer. Choosing from a closed list is something a small model does
     * well, so the list carries only endings of a usable length that close
     * the thought - no dangling word, no question left without its answer -
     * each with the running total next to it, and the schema's enum makes any
     * other number impossible to emit.
     */
    const closingEnds = (start: number) => {
      const at = sentences[start].start;
      const ends: number[] = [];
      for (let e = Math.max(start, keyIndex); e <= to; e += 1) {
        const total = sentences[e].end - at;
        if (total < REFINED_MIN || total > REFINED_MAX) continue;
        if (needsContinuation(sentences[e].text)) continue;
        ends.push(e);
      }
      return ends;
    };

    /**
     * When the answer does not fit, make room for it at the front.
     *
     * Clips that opened early ran 50-64 seconds before the question, so
     * including the answer would pass the maximum and the only "valid" ending
     * left was the question itself - which is how one clip ended on "¿quién
     * va a matar a un meteorólogo?" with the punchline, "alguien que le dijo
     * que iba a hacer sol", one line after the cut. Dropping lead-in
     * sentences, never past the key moment, frees that time.
     */
    let first2 = first;
    let options = closingEnds(first);
    for (let s = first + 1; options.length === 0 && s <= keyIndex; s += 1) {
      const later = closingEnds(s);
      if (later.length > 0) {
        first2 = s;
        options = later;
      }
    }

    // No way to close this idea inside the limits: say so, so the caller can
    // give the slot to a clip that does have an ending.
    if (options.length === 0) {
      refined.push({ ...clip, unresolved: true });
      continue;
    }

    const startAt = sentences[first2].start;

    if (options.length === 1) {
      refined.push(spanClip(clip, sentences, first2, options[0]));
      continue;
    }

    const listing = sentences
      .slice(first2, to + 1)
      .map((s, k) => {
        const index = first2 + k;
        const total = Math.round(s.end - startAt);
        const tag = options.includes(index) ? `   (si acaba aquí: ${total}s)` : '';
        return `[${index}] ${s.text}${tag}`;
      })
      .join('\n');

    try {
      const answer = await generateJson<{ razon?: string; end?: number }>({
        system:
          'Eres editor de clips para redes. Decides dónde acaba un clip para que la idea quede completa: con su respuesta, su remate o su conclusión, sin cortarla antes de tiempo.',
        prompt: `Un clip empieza en la frase [${first2}]. Estas son sus frases y las que vienen después:

${listing}

¿En qué frase termina la idea? Elige solo entre las que llevan duración entre paréntesis.

- razon: en una frase, de qué va la idea y cuál es su remate o conclusión.
- end: el número de la frase donde la idea queda cerrada. Si una pregunta tiene su respuesta más abajo, incluye la respuesta. Si un chiste tiene remate o reacción, incluye el remate. No elijas una frase tras la cual la conversación sigue con lo mismo; tampoco alargues hasta otro tema distinto.`,
        schema: {
          type: 'object',
          properties: {
            razon: { type: 'string' },
            end: { type: 'integer', enum: options },
          },
          required: ['razon', 'end'],
        },
        temperature: 0,
        timeoutMs: 60_000,
      });

      const end = Number(answer.end);

      if (process.env.CLIP_DEBUG) {
        console.log(
          `[limites] clip ${n}: ${first}-${last} -> ${first2}-${end} (opciones ${options.join(',')}) ${
            answer.razon ?? ''
          }`
        );
      }

      // The enum should make this impossible; it is checked anyway because a
      // model that ignored the schema must not be able to move the cut.
      if (!options.includes(end)) {
        refined.push(clip);
        continue;
      }

      refined.push(spanClip(clip, sentences, first2, end));
      continue;
    } catch (error) {
      console.warn(
        '[analysis] no se pudo ajustar el final de un clip:',
        error instanceof Error ? error.message.slice(0, 120) : error
      );
      refined.push(clip);
      continue;
    }
  }

  return refined;
}

/** Re-cuts a candidate to run from sentence `start` to sentence `end`. */
function spanClip(
  clip: ClipCandidate,
  sentences: ReturnType<typeof buildSentences>,
  start: number,
  end: number
): ClipCandidate {
  const span = sentences.slice(start, end + 1);
  return {
    ...clip,
    startSeconds: Math.max(0, Math.round(span[0].start * 10) / 10),
    endSeconds: Math.round(span[span.length - 1].end * 10) / 10,
    text: span.map((s) => s.text).join(' '),
    hookSentence: span[0].text,
  };
}


export async function analyzeVideo(input: AnalyzeVideoInput): Promise<AnalysisResult> {
  const { duration, contextNotes, onProgress, live } = input;
  const maxClips = live ? live.maxClips : clipTargets(duration).maxClips;

  /** Live rounds with nothing worth posting are normal, not failures. */
  const nothingThisRound = (): AnalysisResult => ({
    summary: 'Nada llamativo en este tramo.',
    engine: 'ollama',
    transcriptionSource: 'whisper',
    language: input.language,
    suggestedClips: [],
  });

  // 1. Transcript
  let words: TranscriptWord[] = [];
  let transcriptionSource: AnalysisResult['transcriptionSource'] = 'none';
  let language: string | undefined;

  const mode = input.transcriptionMode ?? 'auto';
  const whisperInstall = await findWhisper();
  const canUseWhisper = Boolean(input.videoPath) && Boolean(whisperInstall) && mode !== 'captions';

  /**
   * Whisper, but only once per video.
   *
   * A second upload of the same video (to get the next ten clips) reads the
   * words back from disk instead of spending minutes on the same audio.
   */
  const transcribeOnce = async (stage: string) => {
    const cacheKey = input.historyKey
      ? {
          source: input.historyKey,
          language: input.language || 'auto',
          model: whisperInstall?.modelName ?? 'unknown',
        }
      : null;

    if (cacheKey) {
      const cached = await loadTranscript(cacheKey);
      if (cached) {
        console.log(
          `[transcript-cache] reutilizada: ${cached.words.length} palabras (${cached.language}) para ${cacheKey.source}`
        );
        onProgress?.('Usando la transcripción guardada de este video...', 1);
        return cached;
      }
    }

    onProgress?.(stage, 0);
    const result = await transcribe(input.videoPath as string, {
      language: input.language || 'auto',
      signal: input.signal,
      onProgress: (fraction) => onProgress?.('Transcribiendo el audio con Whisper...', fraction),
    });

    if (cacheKey) {
      // Losing the cache only costs time on the next run; never fail the
      // analysis over it.
      await saveTranscript(cacheKey, result).catch((error) =>
        console.warn('[transcript-cache] no se pudo guardar:', error)
      );
    }
    return result;
  };

  if (input.words) {
    words = input.words;
    language = input.language;
    transcriptionSource = 'whisper';
  } else if (canUseWhisper) {
    const result = await transcribeOnce('Transcribiendo el audio con Whisper...');
    words = result.words;
    language = result.language;
    transcriptionSource = 'whisper';
  } else if (input.transcript && input.transcript.length > 0) {
    words = wordsFromCaptions(input.transcript);
    transcriptionSource = 'captions';
  } else if (mode === 'captions' && whisperInstall && input.videoPath) {
    // Captions were requested but the video has none; transcribing is better
    // than refusing.
    const result = await transcribeOnce('Sin subtítulos: transcribiendo con Whisper...');
    words = result.words;
    language = result.language;
    transcriptionSource = 'whisper';
  }

  if (words.length === 0) {
    if (live) return nothingThisRound();
    throw new Error(
      whisperInstall
        ? 'No se detectó voz en este video, así que no hay nada que analizar.'
        : 'No hay transcripción disponible y whisper.cpp no está instalado. Coloca main.exe y un modelo en bin/whisper.'
    );
  }

  // 2. Candidate windows
  onProgress?.('Buscando los momentos con más gancho...', 0.9);
  // A holder rather than a plain `let`: TypeScript does not track assignments
  // made inside a callback, so a narrowed local would be typed `never` below.
  const statsRef: { found: FindClipsStats | null } = { found: null };

  /**
   * A shortlist, not the final set.
   *
   * The heuristics find where someone is talking; they cannot tell whether it
   * was worth saying. So they now hand over more windows than will ship and
   * the model picks from those, instead of the model writing copy for whatever
   * twenty windows the hook-phrase list happened to match.
   */
  // Deep enough to serve several uploads of the same video: each one skips
  // what was already delivered and still needs ten good windows left.
  const shortlistSize = 60;

  const fullShortlist = findClipCandidates(words, {
    totalDuration: duration,
    maxClips: shortlistSize,
    // Looser than the finder's default: the model ranks what comes out, so
    // the heuristic floor only has to remove the obviously weak. At the
    // default an hour of television yielded 20 windows, not enough to give
    // ten new clips on a second upload.
    minScoreRatio: 0.2,
    onStats: (found) => {
      statsRef.found = found;
    },
  });

  const stats = statsRef.found;

  // Live: a window still open at the edge of the stream waits for the next
  // round, when what comes after it shows whether the idea really closed.
  if (live) {
    const ready = fullShortlist.filter((c) => c.endSeconds <= live.maxEnd);
    fullShortlist.length = 0;
    fullShortlist.push(...ready);
  }

  if (fullShortlist.length === 0) {
    if (live) return nothingThisRound();
    throw new Error(
      stats && stats.tooSparse + stats.tooShort > 0
        ? `Se encontraron ${
            stats.tooSparse + stats.tooShort
          } tramos, pero ninguno con suficiente habla continua: todos tenían huecos largos de silencio. Prueba con un video con más diálogo seguido.`
        : 'No se encontraron momentos destacables. Prueba con un video con más diálogo o reacciones.'
    );
  }

  // Skip what this video already gave the user. Done before judging, so the
  // model's time goes on windows that could actually be delivered.
  const delivered =
    input.historyKey && !input.allowRepeats ? await getDelivered(input.historyKey) : [];
  const shortlist = fullShortlist.filter(
    (c) => !overlapsDelivered({ start: c.startSeconds, end: c.endSeconds }, delivered)
  );
  const skippedDelivered = fullShortlist.length - shortlist.length;

  if (shortlist.length === 0) {
    if (live) return nothingThisRound();
    throw new Error(
      `Ya te entregué todos los momentos buenos de este video (${delivered.length} clips en análisis anteriores). Marca "Repetir clips ya entregados" si quieres volver a sacarlos, o prueba con otro video.`
    );
  }

  // 3. Let the model throw out the shortlist entries that are just filler
  const ollama = await getOllamaStatus();
  let copyByIndex = new Map<number, OllamaClipCopy>();
  let engine: AnalysisEngine = 'heuristic';
  let rejectedByModel = 0;
  let unresolvedDropped = 0;

  let candidates = shortlist.slice(0, maxClips);

  if (ollama.available) {
    try {
      onProgress?.(`Eligiendo los mejores momentos con ${ollama.chosenModel}...`, 0.93);
      const verdicts = await ollamaRank(shortlist, contextNotes);

      /**
       * Keep what the model approved, best first, then put the survivors back
       * into chronological order for the UI.
       *
       * A window the model never mentioned is kept rather than dropped: a
       * missing entry means the model lost track of an index, which is not
       * evidence about the clip.
       */
      const judged = shortlist.map((candidate, index) => ({
        candidate,
        verdict: verdicts.get(index),
      }));

      /**
       * A window the model did not mention counts as rejected, not as kept.
       *
       * Measured against qwen2.5:7b on a list of three real moments and three
       * stretches of stream filler: it approved the three good ones and
       * simply left the other three out of its answer rather than returning
       * them as false. Treating an omission as "keep" - which is what this
       * did first - let every piece of filler straight through.
       *
       * It is not treated as a hard drop either. Missing entries fall to the
       * bottom of the ranking below, and the fallback after that guarantees
       * the function never returns nothing because the model misbehaved.
       */
      /**
       * The model's scores are used to rank, not as a pass mark.
       *
       * Requiring worthPosting plus a score of 40 made the outcome a coin
       * toss: on an hour of television the scores bunched at 20-50, right on
       * that line, so the same video gave fifteen clips one run and four the
       * next - and zero when judged again offline. A 7B model's absolute
       * numbers are not stable; its ordering is. So only clear filler (under
       * FILLER_FLOOR) is thrown out, and the best of the rest are taken, with
       * worthPosting as a bonus rather than a gate. That is also how Opus
       * Clip's own score works: relative within the batch.
       */
      // Live mode is strict on purpose: only what the model would post, with
      // a strong opening. No minimum to fill, so a dull stretch yields nothing.
      const approved = judged.filter(({ verdict }) =>
        live
          ? Boolean(
              verdict &&
                verdict.worthPosting &&
                verdict.score >= live.minScore &&
                verdict.hook >= live.minHook
            )
          : verdict && verdict.score >= FILLER_FLOOR
      );
      const rankOf = (v: OllamaJudgement | undefined) =>
        v ? v.score + (v.worthPosting ? 10 : 0) : -1;

      // Never return nothing because the model was harsh. If it rejected
      // everything, fall back to its own top few - its ranking is still worth
      // more than the hook-phrase order it replaced.
      const pool = approved.length > 0 || live ? approved : judged;

      // Best first, with a few reserves past the target: a clip whose idea
      // cannot be closed inside the length limits is dropped after boundary
      // refinement, and the next one up takes its place.
      candidates = pool
        .sort((a, b) => rankOf(b.verdict) - rankOf(a.verdict))
        .slice(0, maxClips + RESERVE_CLIPS)
        .map((entry) => entry.candidate);

      rejectedByModel = shortlist.length - approved.length;
      engine = 'ollama';
    } catch (error) {
      // Falling back is better than failing: the cuts are already found.
      console.warn('[analysis] Ollama falló al elegir, se usa el orden heurístico:', error);
      // In live mode an unjudged window is not "striking"; try again next round.
      if (live) return nothingThisRound();
      candidates = shortlist.slice(0, maxClips);
    }
  } else if (live) {
    // Without the model nothing can say whether a moment is striking.
    return nothingThisRound();
  }

  if (live && candidates.length === 0) return nothingThisRound();

  // 4. Move each chosen clip's ending to where the idea actually closes.
  // Before the copy pass, so titles and captions describe the clip as cut.
  if (engine === 'ollama') {
    try {
      const refined = await refineBoundaries(candidates, words, (done, total) =>
        onProgress?.(
          `Ajustando dónde termina cada idea (${done + 1}/${total})...`,
          0.94 + (0.02 * done) / Math.max(1, total)
        )
      );

      // Still in best-first order here. Drop what cannot end cleanly, then
      // keep the target number and put them back in time order.
      const closed = refined.filter((clip) => !clip.unresolved);
      unresolvedDropped = refined.length - closed.length;
      candidates = (closed.length > 0 || live ? closed : refined)
        .slice(0, maxClips)
        .map(({ unresolved: _unresolved, ...clip }) => clip);
    } catch (error) {
      // The finder's own cuts are a fair fallback.
      console.warn('[analysis] falló el ajuste de finales:', error);
      candidates = candidates.slice(0, maxClips);
    }
  }

  // Refinement may push an ending later; in live mode it still has to leave
  // room after it, or the "idea closed" test was made against the edge.
  if (live) {
    candidates = candidates.filter((c) => c.endSeconds <= live.maxEnd);
    if (candidates.length === 0) return nothingThisRound();
  }

  candidates = candidates
    .slice(0, maxClips)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  if (engine === 'ollama') {
    try {
      onProgress?.(`Escribiendo títulos y copy con ${ollama.chosenModel}...`, 0.96);
      copyByIndex = await ollamaCopy(candidates, contextNotes);
    } catch (error) {
      // The cuts are already chosen; template copy is a fair degradation.
      console.warn('[analysis] Ollama falló escribiendo el copy:', error);
    }
  }

  const maxRaw = Math.max(...candidates.map((c) => c.score));

  const suggestedClips: ClipOut[] = candidates.map((candidate, index) => {
    const generated = copyByIndex.get(index);
    const fallback = templateCopy(candidate);
    const score = generated?.score
      ? Math.max(1, Math.min(100, Math.round(generated.score)))
      : normalizeScore(candidate.score, maxRaw);

    return {
      clipId: `clip_${index + 1}`,
      title: generated?.title?.trim() || fallback.title,
      hook: generated?.hook?.trim() || fallback.hook,
      description: generated?.description?.trim() || fallback.description,
      startTimeSeconds: candidate.startSeconds,
      endTimeSeconds: candidate.endSeconds,
      targetPlatforms: PLATFORMS,
      viralityScore: score,
      viralityMetrics: {
        hookImpact: Math.min(100, score + 3),
        retentionPotential: score,
        shareability: Math.max(40, score - 5),
        emotionalTrigger: generated?.emotionalTrigger?.trim() || inferTrigger(candidate),
      },
      // El respaldo sin modelo explica que no hay modelo. Si el modelo sí
      // corrió y solo se dejó este campo, repetir esa frase sería falso.
      viralityJustification:
        generated?.justification?.trim() ||
        (generated
          ? `Señales del transcript: ${
              candidate.reasons.length > 0 ? candidate.reasons.join(', ') : 'ritmo sostenido'
            }.`
          : fallback.viralityJustification),
      soundBiteQuote: candidate.bestQuote,
      suggestedSubtitles: subtitlesForWindow(words, candidate.startSeconds, candidate.endSeconds),
      socialPost: {
        caption: generated?.caption?.trim() || fallback.socialPost.caption,
        hashtags:
          generated?.hashtags && generated.hashtags.length > 0
            ? generated.hashtags
            : fallback.socialPost.hashtags,
        callToAction: generated?.callToAction?.trim() || fallback.socialPost.callToAction,
      },
    };
  });

  // Remember what was handed out, so the next upload of this video skips it.
  if (input.historyKey) {
    try {
      await recordDelivered(
        input.historyKey,
        suggestedClips.map((c) => ({
          start: c.startTimeSeconds,
          end: c.endTimeSeconds,
          title: c.title,
        }))
      );
    } catch (error) {
      // Losing the record only risks a repeat later; never fail the analysis.
      console.warn('[analysis] no se pudo guardar el historial de clips:', error);
    }
  }

  onProgress?.('Listo', 1);

  const historyText =
    (skippedDelivered > 0
      ? ` Se saltaron ${skippedDelivered} momentos que ya te di en análisis anteriores de este video.`
      : '') +
    (unresolvedDropped > 0
      ? ` ${unresolvedDropped} se cambiaron por otros porque su idea no se podía cerrar sin pasar de la duración máxima.`
      : '');

  return {
    summary:
      buildSummary(
        transcriptionSource,
        engine,
        suggestedClips.length,
        ollama.chosenModel,
        stats,
        rejectedByModel
      ) + historyText,
    engine,
    transcriptionSource,
    language,
    suggestedClips,
  };
}

function inferTrigger(candidate: ClipCandidate): string {
  if (candidate.reasons.some((r) => r.includes('reacción'))) return 'Humor';
  if (candidate.reasons.some((r) => r.includes('pregunta'))) return 'Curiosidad';
  if (candidate.reasons.some((r) => r.includes('gancho'))) return 'Intriga';
  if (candidate.reasons.some((r) => r.includes('énfasis'))) return 'Asombro';
  return 'Interés';
}

function buildSummary(
  source: AnalysisResult['transcriptionSource'],
  engine: AnalysisEngine,
  count: number,
  model: string | null,
  stats: FindClipsStats | null = null,
  rejectedByModel = 0
): string {
  const transcriptionText =
    source === 'whisper'
      ? 'Transcripción hecha en tu equipo con Whisper, con tiempos por palabra.'
      : 'Transcripción tomada de los subtítulos de YouTube; los tiempos por palabra son aproximados.';

  const engineText =
    engine === 'ollama'
      ? `${model} eligió cuáles valen la pena y escribió los títulos y el copy, en local.`
      : 'Sin modelo de lenguaje instalado: los cortes salen de señales del transcript (risas, preguntas, frases de gancho, ritmo) y los textos son plantillas para que los reescribas.';

  /**
   * What was rejected, when anything was.
   *
   * Said out loud because a six-hour stream returning five clips reads as the
   * app giving up, when it is the app refusing to hand over the stretches
   * where nobody is talking.
   */
  const discarded = stats ? stats.tooSparse + stats.tooShort + stats.duplicates + stats.belowBar : 0;
  const modelText =
    rejectedByModel > 0
      ? ` De los que quedaron, el modelo descartó ${rejectedByModel} por no tener un momento aprovechable.`
      : '';
  const filterText =
    discarded > 0
      ? ` Se ${discarded === 1 ? 'descartó 1 tramo' : `descartaron ${discarded} tramos`}: ${[
          stats && stats.tooSparse > 0 ? `${stats.tooSparse} con huecos de silencio` : null,
          stats && stats.tooShort > 0 ? `${stats.tooShort} demasiado cortos` : null,
          stats && stats.duplicates > 0 ? `${stats.duplicates} repetidos` : null,
          stats && stats.belowBar > 0 ? `${stats.belowBar} por debajo del nivel` : null,
        ]
          .filter(Boolean)
          .join(', ')}.`
      : '';

  const found = count === 1 ? '1 momento encontrado' : `${count} momentos encontrados`;
  return `${found}. ${transcriptionText} ${engineText}${filterText}${modelText}`;
}

// ---------------------------------------------------------------------------
// Per-clip re-transcription
// ---------------------------------------------------------------------------

export interface TranscribeClipInput {
  videoPath: string;
  startSeconds: number;
  durationSeconds: number;
}

/** Re-runs whisper on a single clip window, for fixing a bad stretch. */
export async function transcribeClip(input: TranscribeClipInput): Promise<{
  subtitles: SubtitleLineOut[];
}> {
  const result = await transcribe(input.videoPath, { language: 'auto' });

  const start = input.startSeconds;
  const end = input.startSeconds + input.durationSeconds;

  return { subtitles: subtitlesForWindow(result.words, start, end) };
}

// ---------------------------------------------------------------------------
// Alternative hooks
// ---------------------------------------------------------------------------

export interface GenerateHooksInput {
  title?: string;
  description?: string;
  soundBite?: string;
}

const HOOKS_SCHEMA = {
  type: 'object',
  properties: {
    hooks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          style: { type: 'string' },
          hookText: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['style', 'hookText', 'explanation'],
      },
    },
  },
  required: ['hooks'],
} as const;

/** Rewrites the opening line five ways. Needs Ollama; there is no useful heuristic for this. */
export async function generateHooks(input: GenerateHooksInput) {
  return generateJson<{ hooks?: unknown[] }>({
    system:
      'Eres un editor de video viral. Escribes en español natural y directo, sin sonar a publicidad.',
    prompt: `Genera 5 ganchos alternativos para este clip:
Título: ${input.title || 'Sin título'}
Descripción: ${input.description || 'Sin descripción'}
Frase clave: ${input.soundBite || 'N/A'}

Un gancho por cada estilo: curiosidad, opinión polémica, "cómo lograr X", historia, y error común.
Devuelve para cada uno: style, hookText y explanation.`,
    schema: HOOKS_SCHEMA as unknown as Record<string, unknown>,
    timeoutMs: 120_000,
  });
}
