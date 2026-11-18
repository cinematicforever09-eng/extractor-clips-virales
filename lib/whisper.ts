import { spawn } from 'node:child_process';
import { access, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg } from './ffmpeg.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * whisper.cpp integration.
 *
 * Transcription runs on this machine instead of going to a cloud model. Besides
 * removing the API key and the quota, it is a better fit for the job: whisper
 * returns real per-word timestamps, so the word-by-word subtitle animation no
 * longer has to estimate them by sharing a line's duration out by word length.
 */

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the media. */
  start: number;
  end: number;
}

export interface WhisperResult {
  language: string;
  words: TranscriptWord[];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Candidate locations for the binary, best first.
 *
 * The bundled copy under bin/ comes first so a folder copied to another machine
 * keeps working. The path under "capcut copia audio y texto" is where this
 * user's existing whisper.cpp already lives, shared with two other projects -
 * pointing at it avoids a second 466 MB copy of the same model.
 */
function binaryCandidates(): string[] {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const names = [`whisper-cli${exe}`, `main${exe}`];

  const roots = [
    path.join(projectRoot, 'bin', 'whisper'),
    path.join(projectRoot, 'bin'),
    path.resolve(projectRoot, '..', 'capcut copia audio y texto', 'whisper'),
    path.join(homedir(), 'AppData', 'Local', 'remotion-whisper'),
  ];

  const candidates: string[] = [];
  if (process.env.WHISPER_PATH) candidates.push(process.env.WHISPER_PATH);
  for (const root of roots) {
    for (const name of names) candidates.push(path.join(root, name));
  }
  return candidates;
}

function modelCandidates(binaryDir: string): string[] {
  const candidates: string[] = [];
  if (process.env.WHISPER_MODEL) candidates.push(process.env.WHISPER_MODEL);

  // Larger models first: they are markedly better with Spanish proper nouns.
  const names = [
    'ggml-large-v3.bin',
    'ggml-large-v3-turbo.bin',
    'ggml-medium.bin',
    'ggml-small.bin',
    'ggml-base.bin',
  ];

  const roots = [
    path.join(projectRoot, 'bin', 'whisper'),
    binaryDir,
    path.join(binaryDir, 'models'),
    path.resolve(projectRoot, '..', 'capcut copia audio y texto', 'whisper'),
  ];

  // Name-major, not root-major: quality has to win over location. Iterating
  // folder by folder finds whatever happens to sit next to the binary first,
  // which is how a leftover ggml-small.bin beats the large model in bin/.
  for (const name of names) {
    for (const root of roots) candidates.push(path.join(root, name));
  }
  return candidates;
}

export interface WhisperInstall {
  binary: string;
  model: string;
  modelName: string;
  /**
   * Whether this build can use the GPU.
   *
   * Detected by looking for the CUDA runtime next to the binary rather than by
   * running it: the cublas builds ship their own DLLs, and a CPU build simply
   * does not have them. It matters a lot - the same minute of audio takes 27
   * seconds on CPU and 3 on this machine's GPU.
   */
  backend: 'gpu' | 'cpu';
  /**
   * Path to a Silero VAD model, when one is installed beside the binary.
   *
   * Voice activity detection is what stops whisper writing words over silence.
   * Asked to transcribe 30 seconds of digital silence between two bits of
   * speech, this build invented "Tiene cosas chismas."; with the VAD model it
   * emitted nothing there and kept all the real speech, timestamps intact.
   *
   * That mattered far beyond a stray phrase. Invented words in a silent
   * stretch are enough to seed a clip candidate, which is how a six-hour
   * just-chatting stream yielded clips where nobody speaks.
   *
   * It also makes a sparse stream faster, because the silence is never fed to
   * the decoder at all.
   */
  vadModel: string | null;
}

/**
 * Preset name for whisper.cpp's `-dtw`, which aligns tokens to audio using
 * dynamic time warping instead of the decoder's raw attention.
 *
 * It matters most for the turbo model: turbo has fewer decoder layers, and
 * without DTW its word boundaries drift by seconds - enough to put the
 * word-by-word highlight on the wrong word entirely.
 */
function dtwPreset(modelName: string): string | null {
  const name = modelName.toLowerCase();
  if (name.includes('large-v3-turbo')) return 'large.v3.turbo';
  if (name.includes('large-v3')) return 'large.v3';
  if (name.includes('large-v2')) return 'large.v2';
  if (name.includes('medium')) return 'medium';
  if (name.includes('small')) return 'small';
  if (name.includes('base')) return 'base';
  if (name.includes('tiny')) return 'tiny';
  return null;
}

/**
 * Looks for a Silero VAD model, newest version first.
 *
 * Optional on purpose: a copy of this folder without the file still
 * transcribes, just with whisper's hallucinations over silence left in.
 */
async function findVadModel(binaryDir: string): Promise<string | null> {
  const names = ['ggml-silero-v5.1.2.bin', 'ggml-silero-v5.bin', 'ggml-silero.bin'];
  const roots = [path.join(projectRoot, 'bin', 'whisper'), binaryDir, path.join(binaryDir, 'models')];

  const candidates = process.env.WHISPER_VAD_MODEL ? [process.env.WHISPER_VAD_MODEL] : [];
  for (const name of names) {
    for (const root of roots) candidates.push(path.join(root, name));
  }

  for (const candidate of candidates) {
    const ok = await access(candidate, constants.R_OK).then(
      () => true,
      () => false
    );
    if (ok) return candidate;
  }
  return null;
}

/**
 * Whether this build can actually use a GPU on this machine.
 *
 * Two conditions, and the second is the one that matters once the folder is
 * copied to another computer. The cublas DLLs beside the executable only say
 * the build was compiled for CUDA; they ship inside the folder, so they are
 * present on every machine it lands on. Whether there is an NVIDIA card with
 * a working driver is a property of the machine, and `nvidia-smi` - which
 * the driver installs - answers it. Without that check a laptop with no
 * NVIDIA card would report "Whisper por GPU" and every transcription would
 * first try, and fail, to start CUDA.
 */
async function hasCudaRuntime(binaryDir: string): Promise<boolean> {
  const { readdir } = await import('node:fs/promises');
  try {
    const files = await readdir(binaryDir);
    if (!files.some((name) => /^cublas64_\d+\.dll$/i.test(name))) return false;
  } catch {
    return false;
  }
  return hasNvidiaGpu();
}

async function hasNvidiaGpu(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let output = '';
    let settled = false;
    const finish = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    try {
      const child = spawn('nvidia-smi', ['-L'], { windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        finish(false);
      }, 6000);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 && /GPU \d+:/i.test(output));
      });
    } catch {
      finish(false);
    }
  });
}

let cached: WhisperInstall | null | undefined;

export async function findWhisper(): Promise<WhisperInstall | null> {
  if (cached !== undefined) return cached;

  for (const binary of binaryCandidates()) {
    if (!(await isExecutable(binary))) continue;

    for (const model of modelCandidates(path.dirname(binary))) {
      const usable =
        (await isExecutable(model).catch(() => false)) ||
        // Models are data, not executables; access(X_OK) can refuse them.
        (await access(model, constants.R_OK).then(
          () => true,
          () => false
        ));

      if (usable) {
        const backend = (await hasCudaRuntime(path.dirname(binary))) ? 'gpu' : 'cpu';
        const vadModel = await findVadModel(path.dirname(binary));
        cached = { binary, model, modelName: path.basename(model), backend, vadModel };
        return cached;
      }
    }
  }

  cached = null;
  return null;
}

export function resetWhisperCache(): void {
  cached = undefined;
}

export class TranscriptionCancelledError extends Error {
  constructor() {
    super('Transcripción cancelada.');
    this.name = 'TranscriptionCancelledError';
  }
}

export class WhisperUnavailableError extends Error {
  constructor() {
    super(
      'No se encontró whisper.cpp. Coloca main.exe y un modelo ggml-*.bin en la carpeta bin/whisper del proyecto.'
    );
    this.name = 'WhisperUnavailableError';
  }
}

/** Extracts the 16 kHz mono WAV whisper.cpp expects. */
async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('FFmpeg es necesario para extraer el audio antes de transcribir.');

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-i', videoPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        '-y',
        outputPath,
      ],
      { windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1500);
    });
    child.on('error', (err) => reject(new Error(`No se pudo ejecutar FFmpeg: ${err.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`FFmpeg falló extrayendo el audio. ${stderr.trim().slice(0, 200)}`))
    );
  });
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

// ---------------------------------------------------------------------------
// How fast this machine actually transcribes
// ---------------------------------------------------------------------------

/**
 * Transcription speed as a multiple of real time, measured on this machine.
 *
 * The UI used to show a flat `duration × 1.2`, which on this hardware was out
 * by more than an order of magnitude - a 63-minute video was announced as
 * "~76 min" when the GPU does it in about two. An estimate that wrong is not a
 * cosmetic problem: it is the difference between someone using the good
 * transcription and settling for YouTube's phrase-level captions.
 *
 * So it is measured rather than guessed. The defaults below only apply until
 * the first real transcription finishes, and are deliberately pessimistic -
 * finishing early is a nice surprise, finishing late is a broken promise.
 */
const DEFAULT_SPEED: Record<string, number> = { gpu: 20, cpu: 1 };

let measuredSpeed: number | null = null;

/** pcm_s16le, 16 kHz, mono - the format extractAudio always writes. */
const WAV_BYTES_PER_SECOND = 16000 * 2;

async function recordSpeed(wavPath: string, elapsedMs: number): Promise<void> {
  if (elapsedMs < 500) return; // Too short to measure anything meaningful.

  try {
    const { size } = await stat(wavPath);
    const audioSeconds = (size - 44) / WAV_BYTES_PER_SECOND; // minus the header
    if (audioSeconds < 20) return;

    const speed = audioSeconds / (elapsedMs / 1000);

    // A rolling average, so one run competing with a game or an export does
    // not reset the figure the user is shown.
    measuredSpeed = measuredSpeed === null ? speed : measuredSpeed * 0.6 + speed * 0.4;
  } catch {
    // Only an estimate is at stake; never fail a transcription over it.
  }
}

/**
 * Transcription speed to show the user, as a multiple of real time.
 *
 * `measured` says whether this came from a real run on this machine or is
 * still the conservative default, so the UI can be honest about which it is.
 */
export function getWhisperSpeed(backend: string | null): { speed: number; measured: boolean } {
  if (measuredSpeed !== null) return { speed: measuredSpeed, measured: true };
  return { speed: DEFAULT_SPEED[backend ?? 'cpu'] ?? 1, measured: false };
}

interface SpeechRegion {
  start: number;
  end: number;
}

/**
 * Finds the stretches of a WAV where someone is talking.
 *
 * Uses FFmpeg's silencedetect, which reports the silences; the speech is what
 * is left between them. One pass over a 16 kHz mono file is cheap next to
 * transcribing it, and it is what lets language detection sample speech
 * rather than whatever happened to be at a given timestamp.
 *
 * The -35 dB threshold is below room tone and crowd noise but well under
 * speech; the 1.5 s minimum keeps ordinary pauses from splitting a region.
 */
async function findSpeechRegions(
  ffmpeg: string,
  wavPath: string,
  audioSeconds: number
): Promise<SpeechRegion[]> {
  const output = await new Promise<string>((resolve) => {
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-i', wavPath, '-af', 'silencedetect=n=-35dB:d=1.5', '-f', 'null', '-'],
      { windowsHide: true }
    );

    let text = '';
    const collect = (chunk: Buffer) => {
      text += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });

  const silences: SpeechRegion[] = [];
  let openedAt: number | null = null;

  for (const line of output.split(/\r\?\n/)) {
    const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (startMatch) openedAt = Math.max(0, Number(startMatch[1]));

    const endMatch = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (endMatch && openedAt !== null) {
      silences.push({ start: openedAt, end: Number(endMatch[1]) });
      openedAt = null;
    }
  }

  // A silence still open at EOF runs to the end of the file.
  if (openedAt !== null) silences.push({ start: openedAt, end: audioSeconds });

  // Nothing detected means no silence worth the name: it is all speech.
  if (silences.length === 0) return [{ start: 0, end: audioSeconds }];

  const speech: SpeechRegion[] = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start > cursor) speech.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < audioSeconds) speech.push({ start: cursor, end: audioSeconds });

  return speech;
}

/**
 * Works out what language is being spoken by sampling across the whole file.
 *
 * whisper detects the language from the **first 30 seconds only**, and on a
 * long video that is the least representative part there is: a channel
 * sting, a music bed, applause, a cold open. A Spanish TV show six hours long
 * came back transcribed in Arabic because of what happened to be at 0:00, and
 * the damage went far past the captions - the clip finder was then matching
 * Spanish hook phrases against Arabic text, and the model was being asked
 * which passage of gibberish was funniest.
 *
 * So the language is voted on instead: several 30-second excerpts spread
 * through the audio, each detected on its own, probabilities summed. Detection
 * is just one encoder pass per excerpt, a second or two in total on the GPU,
 * which is nothing next to transcribing hours of audio in the wrong language.
 *
 * Returns null when it cannot tell, and the caller falls back to whisper's own
 * detection rather than forcing a guess.
 */
async function detectLanguage(
  install: WhisperInstall,
  wavPath: string,
  workDir: string,
  signal?: AbortSignal
): Promise<string | null> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;

  let audioSeconds = 0;
  try {
    const { size } = await stat(wavPath);
    audioSeconds = (size - 44) / WAV_BYTES_PER_SECOND;
  } catch {
    return null;
  }

  // Short enough that the first 30 s is the whole thing anyway.
  if (audioSeconds < 120) return null;

  const WINDOW = 30;

  /**
   * Sample where somebody is actually talking.
   *
   * Spreading samples evenly was not enough: on a source with long quiet
   * stretches most of them landed on silence or a music bed, and whisper
   * reports those as a language with real confidence - a synthetic chord
   * came back as English at p=0.88, which outvoted the one sample that had
   * speech in it. Detecting the language of music is worse than not
   * detecting at all, because it then gets forced on the whole file.
   */
  const speech = await findSpeechRegions(ffmpeg, wavPath, audioSeconds);
  const usable = speech.filter((region: SpeechRegion) => region.end - region.start >= 8);

  // Nothing but silence; let whisper decide for itself.
  if (usable.length === 0) return null;

  const wanted = Math.min(5, Math.max(2, Math.floor(audioSeconds / 300)));

  // Longest regions first, so each sample has the most speech available, then
  // back into time order so the sampling still spans the whole file.
  const picked = [...usable]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, wanted)
    .sort((a, b) => a.start - b.start);

  const offsets = picked.map((region) => {
    const middle = (region.start + region.end) / 2;
    return Math.max(region.start, Math.min(middle - WINDOW / 2, region.end - 1));
  });

  const samples = offsets.length;

  const votes = new Map<string, number>();

  for (let i = 0; i < samples; i += 1) {
    if (signal?.aborted) return null;

    const at = offsets[i];
    const excerpt = path.join(workDir, `lang-${i}.wav`);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          ffmpeg,
          ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', at.toFixed(2),
            '-t', String(WINDOW), '-i', wavPath, '-ac', '1', '-ar', '16000',
            '-c:a', 'pcm_s16le', '-y', excerpt],
          { windowsHide: true }
        );
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
      });

      const detected = await new Promise<{ lang: string; p: number } | null>((resolve) => {
        const child = spawn(
          install.binary,
          // No -np here. "No prints" suppresses the very line this parses -
          // "auto-detected language: es (p = 0.99)" - so with it every sample
          // came back unreadable, the vote was always empty, and detection
          // silently fell back to whisper's first-30-seconds guess. That is
          // the bug this whole function exists to fix.
          [
            '-m', install.model, '-f', excerpt, '-l', 'auto', '-dl',
            ...(install.backend === 'gpu' ? [] : ['-ng']),
          ],
          { cwd: path.dirname(install.binary), windowsHide: true }
        );

        let output = '';
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4000);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', () => resolve(null));
        child.on('close', () => {
          const match = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i.exec(output);
          resolve(match ? { lang: match[1].toLowerCase(), p: Number(match[2]) || 0 } : null);
        });
      });

      // A low-confidence excerpt is usually music or a crowd, so it is left
      // out of the vote rather than allowed to drag it.
      if (detected && detected.p >= 0.5) {
        votes.set(detected.lang, (votes.get(detected.lang) ?? 0) + detected.p);
      }
    } catch {
      // One bad excerpt should never stop a transcription.
    } finally {
      await rm(excerpt, { force: true }).catch(() => {});
    }
  }

  if (votes.size === 0) return null;

  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `[whisper] idioma detectado por muestreo: ${best[0]} ` +
      `(${[...votes.entries()].map(([l, p]) => `${l}:${p.toFixed(2)}`).join(', ')})`
  );
  return best[0];
}

export interface TranscribeOptions {
  /** ISO code, or 'auto' to detect. */
  language?: string;
  /** Fraction 0-1, estimated from how much audio has been consumed. */
  onProgress?: (fraction: number) => void;
  threads?: number;
  /** Kills the whisper process. Transcribing a long video takes minutes. */
  signal?: AbortSignal;
}

/**
 * Transcribes a media file into timed words.
 *
 * `-ml 1 --split-on-word` makes whisper.cpp emit one word per segment with its
 * own start and end, which is exactly the granularity the caption animations
 * need. Grouping words back into readable lines is done by the caller.
 */
export async function transcribe(
  mediaPath: string,
  options: TranscribeOptions = {}
): Promise<WhisperResult> {
  const install = await findWhisper();
  if (!install) throw new WhisperUnavailableError();

  const workDir = await mkdtemp(path.join(tmpdir(), 'viral-whisper-'));
  const wavPath = path.join(workDir, 'audio.wav');
  const outBase = path.join(workDir, 'out');

  try {
    await extractAudio(mediaPath, wavPath);

    // Only when the caller has not forced one: an explicit choice wins.
    const requested = options.language || 'auto';
    const language =
      requested === 'auto'
        ? ((await detectLanguage(install, wavPath, workDir, options.signal)) ?? 'auto')
        : requested;

    const baseArgs = [
      '-m', install.model,
      '-f', wavPath,
      '-l', language,
      '-ml', '1',
      '-sow',
      '-oj',
      '-of', outBase,
      '-np',
      '-pp',
      '-t', String(options.threads ?? 8),
    ];

    const run = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new TranscriptionCancelledError());
          return;
        }

        const child = spawn(install.binary, args, {
          cwd: path.dirname(install.binary),
          windowsHide: true,
        });

        let cancelled = false;
        const onAbort = () => {
          cancelled = true;
          child.kill();
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        let stderr = '';

        const readProgress = (chunk: Buffer) => {
          // whisper.cpp prints "whisper_print_progress_callback: progress =  42%"
          const match = /progress\s*=\s*(\d+)%/.exec(chunk.toString());
          if (match && options.onProgress) {
            // whisper.cpp can report past 100 on the final chunk.
            options.onProgress(Math.min(1, Number(match[1]) / 100));
          }
        };

        child.stdout.on('data', readProgress);
        child.stderr.on('data', (chunk: Buffer) => {
          readProgress(chunk);
          stderr = (stderr + chunk.toString()).slice(-2000);
        });

        child.on('error', (err) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(new Error(`No se pudo ejecutar whisper.cpp: ${err.message}`));
        });

        child.on('close', (code) => {
          options.signal?.removeEventListener('abort', onAbort);
          if (cancelled) return reject(new TranscriptionCancelledError());
          if (code === 0) return resolve();
          reject(new Error(`whisper.cpp falló (código ${code}). ${stderr.trim().slice(0, 300)}`));
        });
      });

    const startedAt = Date.now();

    const preset = dtwPreset(install.modelName);
    const dtwArgs = preset ? ['-dtw', preset] : [];
    const vadArgs = install.vadModel
      ? ['--vad', '--vad-model', install.vadModel, '--vad-speech-pad-ms', '120']
      : [];

    /**
     * Attempts in order, each dropping one optional flag an older build may
     * not understand. VAD goes first because it is the newest of the two.
     * The last attempt is plain whisper, so neither extra can be the reason a
     * transcription fails outright.
     *
     * The 120 ms speech padding above is wider than the 30 ms default: at the
     * default, VAD clipped the attack of the first word of an utterance, and a
     * caption that starts a frame late is more noticeable than one that starts
     * a frame early.
     */
    /**
     * GPU attempts first when there is a GPU, then the same ladder on the
     * CPU with `-ng`.
     *
     * The CPU rungs are what keep the folder working on another computer: a
     * CUDA build copied to a machine whose driver is too old for it fails to
     * initialise the GPU, and without a CPU retry that machine could not
     * transcribe at all. Slower is far better than not at all. On a machine
     * with no NVIDIA card the GPU rungs are skipped outright.
     */
    const cpu = ['-ng'];
    const gpuLadder =
      install.backend === 'gpu'
        ? [[...baseArgs, ...dtwArgs, ...vadArgs], [...baseArgs, ...dtwArgs], baseArgs]
        : [];
    const cpuLadder = [
      [...baseArgs, ...cpu, ...dtwArgs, ...vadArgs],
      [...baseArgs, ...cpu, ...vadArgs],
      [...baseArgs, ...cpu],
    ];

    // Drop attempts identical to an earlier one (no VAD model, no DTW preset,
    // or neither), so a missing extra never costs a second run.
    const attempts = [...gpuLadder, ...cpuLadder].filter(
      (args, index, all) => all.findIndex((other) => other.join('\u0000') === args.join('\u0000')) === index
    );

    /** Names the extras an argument list still carries, for the retry log. */
    const extras = (args: string[]) => {
      const names = [
        args.includes('-ng') ? 'CPU' : 'GPU',
        args.includes('--vad') && 'VAD',
        args.includes('-dtw') && 'DTW',
      ].filter(Boolean);
      return names.join(' + ');
    };

    for (let i = 0; i < attempts.length; i++) {
      try {
        await run(attempts[i]);
        break;
      } catch (error) {
        if (error instanceof TranscriptionCancelledError) throw error;
        if (i === attempts.length - 1) throw error;
        console.warn(
          `[whisper] falló con ${extras(attempts[i])}, se reintenta con ${extras(attempts[i + 1])}:`,
          error instanceof Error ? error.message.slice(0, 160) : error
        );
      }
    }

    await recordSpeed(wavPath, Date.now() - startedAt);

    const raw = await readFile(`${outBase}.json`, 'utf8');
    const parsed = JSON.parse(raw) as WhisperJson;

    const words: TranscriptWord[] = [];
    for (const segment of parsed.transcription ?? []) {
      const text = (segment.text ?? '').trim();
      // whisper.cpp emits empty and dash-only segments between utterances.
      if (!text || text === '-') continue;

      const start = (segment.offsets?.from ?? 0) / 1000;
      const end = (segment.offsets?.to ?? 0) / 1000;
      if (end <= start) continue;

      words.push({ text, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
    }

    options.onProgress?.(1);

    return { language: parsed.result?.language || options.language || 'es', words };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Groups timed words into caption-sized lines.
 *
 * Breaks on sentence punctuation, on a pause longer than `pauseSeconds`, or
 * once a line reaches `maxWords` - the same cues a human editor uses, and what
 * keeps a line from running past the width of a phone screen.
 */
export function groupWordsIntoLines(
  words: TranscriptWord[],
  maxWords = 5,
  pauseSeconds = 0.6
): Array<{ text: string; start: number; end: number; words: TranscriptWord[] }> {
  const lines: Array<{ text: string; start: number; end: number; words: TranscriptWord[] }> = [];
  let current: TranscriptWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      text: current.map((w) => w.text).join(' '),
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);

    const next = words[i + 1];
    const endsSentence = /[.!?…]$/.test(word.text);
    const longPause = next ? next.start - word.end >= pauseSeconds : true;

    if (endsSentence || longPause || current.length >= maxWords) flush();
  }

  flush();
  return lines;
}
