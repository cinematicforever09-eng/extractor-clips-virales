import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeVideo, type ClipOut } from './analysis.js';
import { clearDelivered } from './clip-history.js';
import { exportClip, findFfmpeg, probeMedia, type AspectRatio } from './ffmpeg.js';
import type { GameplayLayout, SpeakerRegion } from './reframe.js';
import { detectShots, SAME_WEBCAM_MAX_DISTANCE } from './shots.js';
import type { SubtitleAnimation, SubtitlePosition, SubtitleStyleId } from './ass.js';
import type { WatermarkSettings } from './watermark.js';
import { detectWebcamAnywhere, detectWebcamBox, type Box } from './webcam-box.js';
import { transcribe, type TranscriptWord } from './whisper.js';
import { fetchMetadata, getLiveStreamUrls } from './ytdlp.js';

/**
 * Clips from a stream while it is still on air.
 *
 * The stream is recorded in one-minute pieces. Every few minutes the new
 * pieces are transcribed (on this GPU, five minutes of audio take about ten
 * seconds) and the same judge the normal analysis uses - hook, flow, value -
 * looks at the recent stretch. What it approves is exported straight away
 * with the user's framing, captions and watermark, so a moment is a finished
 * MP4 a few minutes after it happened. When the stream ends (or the user
 * stops it) the recording is deleted and only the clips stay, as the user
 * asked.
 *
 * Two rules keep the clips worth posting rather than "whatever came up":
 *
 *  - A window is only judged once the stream has gone on SETTLE_SECONDS past
 *    its end. Until then nothing shows whether the idea closed or the
 *    streamer was mid-sentence.
 *  - Live mode is strict (see analysis.ts `live`): no quota to fill. A dull
 *    stretch produces nothing, and only what the model would post, with a
 *    strong opening, gets through.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where finished clips go, one folder per stream. Outside temp, on purpose. */
export const LIVE_OUTPUT_ROOT = path.join(projectRoot, 'clips-en-vivo');

/** Length of each recorded piece. */
export const SEGMENT_SECONDS = 60;
/** New audio needed before a round runs; shorter rounds waste the model's time. */
export const BATCH_SECONDS = 180;
/** How far back each round looks, so ideas that span two rounds are seen whole. */
export const LOOKBACK_SECONDS = 8 * 60;
/** Stream that must follow a window before it counts as closed. */
export const SETTLE_SECONDS = 25;
/** How often the recorder's progress is checked. */
const TICK_MS = 15_000;
/** Reconnects in a row before giving up on a dropped stream. */
const MAX_RECONNECTS = 5;

export type Strictness = 'alta' | 'media' | 'baja';

/** The bar a moment has to clear, per strictness level. Scores are 0-100. */
export function strictnessThresholds(level: Strictness): { minScore: number; minHook: number } {
  // Measured earlier on real material: genuine moments scored 50-85 and
  // filler 15-25 on this model. 'media' sits clear of the filler.
  switch (level) {
    case 'alta':
      return { minScore: 65, minHook: 65 };
    case 'baja':
      return { minScore: 45, minHook: 40 };
    default:
      return { minScore: 55, minHook: 55 };
  }
}

export interface LiveSettings {
  aspectRatio: AspectRatio;
  /**
   * 'focus' follows one person in vertical, 'split' stacks two, 'gameplay'
   * puts the game over the player's webcam. All three crop regions the user
   * marks on a frame of the live stream; the others need no marks.
   */
  framingMode: 'auto' | 'focus' | 'split' | 'gameplay' | 'blur-fill' | 'zoom-crop' | 'fit';
  /** 'gameplay': the webcam (and optionally the game) as marked on a live frame. */
  speakers?: SpeakerRegion[];
  gameplayLayout?: GameplayLayout;
  watermark?: WatermarkSettings | null;
  subtitleStyle: SubtitleStyleId;
  subtitleAnimation: SubtitleAnimation;
  subtitlePosition: SubtitlePosition;
  burnSubtitles: boolean;
  /** 'auto' or an ISO code. Auto is decided once, on the first round. */
  language: string;
  strictness: Strictness;
}

export interface LiveClip {
  id: string;
  title: string;
  hook: string;
  score: number;
  /** Seconds since the recording started. */
  start: number;
  end: number;
  status: 'waiting' | 'exporting' | 'ready' | 'error';
  fileName?: string;
  error?: string;
  caption?: string;
  hashtags?: string[];
}

export interface LiveSessionView {
  id: string;
  url: string;
  title: string;
  status: 'starting' | 'recording' | 'finishing' | 'done' | 'error';
  message: string;
  recordedSeconds: number;
  analyzedSeconds: number;
  rounds: number;
  outputDir: string;
  clips: LiveClip[];
  needsWebcamMark: boolean;
  /** The framing in use; 'auto' until the stream has been looked at. */
  framingMode: LiveSettings['framingMode'];
  detected: StreamKind | null;
  /** The regions in use, so the page can draw them - including auto-found ones. */
  marks: SpeakerRegion[];
  /** How many regions the framing needs marked, and how many are. */
  marksNeeded: number;
  marksSet: number;
  error?: string;
}

/** What 'auto' decided the stream is, and why - shown to the user. */
export interface StreamKind {
  kind: 'videojuego' | 'videojuego-sin-camara' | 'gente';
  reason: string;
}

/**
 * Picks the framing for 'auto' from what the stream is.
 *
 * The strongest signal is a webcam overlay sitting on top of the picture: that
 * is what a game stream looks like, and finding it also gives the exact box to
 * frame, so the user does not have to click. The site's category backs it up
 * both ways - a "Gaming" stream with no overlay is a game shown without a
 * face, and a news channel's picture-in-picture is not a facecam even though
 * it looks like one.
 */
export function decideFraming(
  info: { categories?: string[]; tags?: string[]; title?: string },
  webcam: Box | null
): { mode: LiveSettings['framingMode']; speakers?: SpeakerRegion[]; kind: StreamKind } {
  const categories = (info.categories ?? []).map((c) => c.toLowerCase());
  const saysGaming = categories.some((c) => c.includes('gaming') || c.includes('juegos'));
  const saysOther = categories.length > 0 && !saysGaming;

  if (webcam && !saysOther) {
    return {
      mode: 'gameplay',
      speakers: [webcam],
      kind: {
        kind: 'videojuego',
        reason: 'Encontré la webcam del jugador encima del juego y la marqué sola.',
      },
    };
  }
  if (saysGaming) {
    return {
      mode: 'blur-fill',
      kind: {
        kind: 'videojuego-sin-camara',
        reason: 'El canal es de videojuegos pero no se ve webcam: va el juego completo en vertical.',
      },
    };
  }
  return {
    mode: 'focus',
    kind: {
      kind: 'gente',
      reason: webcam
        ? 'Parece un directo de gente hablando (el recuadro que se ve no es una webcam de juego).'
        : 'Parece un directo de gente hablando.',
    },
  };
}

export interface Segment {
  file: string;
  /** Seconds since the recording started. */
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

/** Reads FFmpeg's segment list (csv: file,start,end), skipping a half-written last line. */
export function parseSegmentList(csv: string): Array<{ file: string; duration: number }> {
  return csv
    .split(/\r?\n/)
    .map((line) => line.trim().split(','))
    .filter((parts) => parts.length >= 3)
    .map(([file, start, end]) => ({ file, duration: Number(end) - Number(start) }))
    .filter((s) => s.file && Number.isFinite(s.duration) && s.duration > 0);
}

/** The recorded pieces a stretch of the stream lives in, in order. */
export function segmentsCovering(segments: Segment[], start: number, end: number): Segment[] {
  return segments.filter((s) => s.end > start && s.start < end);
}

/** A title made safe for a Windows file name. */
export function safeFileName(title: string, fallback = 'clip'): string {
  const clean = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    // Stream titles love "🔴 EN VIVO"; emoji in a folder name break some tools.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return clean || fallback;
}

/** Words of the stretch a round should look at. */
export function wordsForRound(words: TranscriptWord[], until: number): TranscriptWord[] {
  const from = Math.max(0, until - LOOKBACK_SECONDS);
  return words.filter((w) => w.start >= from && w.end <= until + 0.01);
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------

function runFfmpeg(ffmpegPath: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, cwd });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1500);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg ${code}: ${stderr.trim()}`))
    );
  });
}

/** Joins recorded pieces into one file without re-encoding. */
async function joinSegments(ffmpegPath: string, dir: string, pieces: Segment[], outName: string) {
  const listName = `${outName}.txt`;
  await writeFile(
    path.join(dir, listName),
    pieces.map((p) => `file '${p.file.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8'
  );
  await runFfmpeg(
    ffmpegPath,
    ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outName],
    dir
  );
  await rm(path.join(dir, listName), { force: true });
  return path.join(dir, outName);
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export class LiveSession {
  readonly id = randomUUID().slice(0, 8);
  private status: LiveSessionView['status'] = 'starting';
  private message = 'Conectando con el directo...';
  private error?: string;
  private title = '';
  private segDir: string;
  private outputDir = '';
  private segments: Segment[] = [];
  /** How many entries of the current run's list are already in `segments`. */
  private listCount = 0;
  private run = 0;
  private recorder: ChildProcess | null = null;
  private reconnects = 0;
  private stopping = false;
  private words: TranscriptWord[] = [];
  private transcribedUntil = 0;
  private analyzedUntil = 0;
  private rounds = 0;
  private language: string | undefined;
  private clips: LiveClip[] = [];
  private clipData = new Map<string, ClipOut>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private exportChain: Promise<void> = Promise.resolve();

  constructor(
    readonly url: string,
    private settings: LiveSettings,
    tempRoot: string
  ) {
    this.segDir = path.join(tempRoot, `live-${this.id}`);
  }

  private get historyKey() {
    return `live:${this.id}`;
  }

  view(): LiveSessionView {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      status: this.status,
      message: this.message,
      recordedSeconds: this.segments.at(-1)?.end ?? 0,
      analyzedSeconds: this.analyzedUntil,
      rounds: this.rounds,
      outputDir: this.outputDir,
      clips: [...this.clips],
      needsWebcamMark: this.needsWebcamMark(),
      framingMode: this.settings.framingMode,
      detected: this.detected,
      marks: this.settings.speakers ?? [],
      marksNeeded: this.marksNeeded(),
      marksSet: this.settings.speakers?.length ?? 0,
      error: this.error,
    };
  }

  /** Regions the chosen framing needs before a crop means anything. */
  private marksNeeded() {
    const mode = this.settings.framingMode;
    return mode === 'split' ? 2 : mode === 'focus' || mode === 'gameplay' ? 1 : 0;
  }

  /** True while clips must wait: a crop without its marks would be a guess. */
  private needsWebcamMark() {
    // Undecided 'auto' waits too: exporting before knowing whether this is a
    // game or a conversation would frame it wrong.
    if (this.settings.framingMode === 'auto') return true;
    return (this.settings.speakers?.length ?? 0) < this.marksNeeded();
  }

  private detected: StreamKind | null = null;
  private streamInfo: { categories?: string[]; tags?: string[]; title?: string } = {};
  private detecting = false;

  /**
   * Looks at the first minutes and settles 'auto'. Needs two minutes of
   * recording, so the persistent-edge test has frames far enough apart.
   */
  private async detectKind() {
    if (this.detecting || this.settings.framingMode !== 'auto') return;
    const recorded = this.segments.at(-1)?.end ?? 0;
    if (recorded < 2 * SEGMENT_SECONDS) return;
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) return;

    this.detecting = true;
    this.message = 'Mirando si es un directo de gente o de videojuego...';
    const recent = this.segments.slice(-3);
    let webcam: Box | null = null;
    try {
      const joined = await joinSegments(ffmpegPath, this.segDir, recent, `detect-${Date.now()}.ts`);
      try {
        const length = recent.at(-1)!.end - recent[0].start;
        webcam = await detectWebcamAnywhere(ffmpegPath, joined, length / 2, length);
      } finally {
        await rm(joined, { force: true });
      }
    } catch (error) {
      console.warn('[live] no se pudo mirar el tipo de directo:', error);
    } finally {
      this.detecting = false;
    }

    const decision = decideFraming(this.streamInfo, webcam);
    this.detected = decision.kind;
    console.log(`[live] tipo de directo: ${decision.kind.kind} -> ${decision.mode}`);
    this.setSettings({
      framingMode: decision.mode,
      speakers: decision.speakers?.map((s) => ({ ...s, markedAt: recent.at(-1)!.start })),
    });
  }

  /** Second of the recording the last frame shown to the user came from. */
  private lastFrameTime: number | null = null;

  clipFile(clipId: string): string | null {
    const clip = this.clips.find((c) => c.id === clipId);
    return clip?.fileName ? path.join(this.outputDir, clip.fileName) : null;
  }

  async start(): Promise<void> {
    const metadata = await fetchMetadata(this.url);
    if (!metadata.isLive) {
      throw new Error(
        'Ese enlace no está en directo ahora mismo. Para un video ya terminado usa el análisis normal.'
      );
    }
    this.title = metadata.title || 'Directo';
    this.streamInfo = { categories: metadata.categories, tags: metadata.tags, title: metadata.title };
    // Local time, as the user reads it on their clock (toISOString is UTC).
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
    this.outputDir = path.join(LIVE_OUTPUT_ROOT, `${stamp} ${safeFileName(this.title, 'directo')}`);
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(this.segDir, { recursive: true });

    await this.startRecorder();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** Starts (or restarts, after a drop) FFmpeg on the stream's current URLs. */
  private async startRecorder() {
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) throw new Error('FFmpeg no está disponible.');

    const urls = await getLiveStreamUrls(this.url);
    if (urls.length === 0) throw new Error('No se encontró la señal del directo.');

    this.run++;
    this.listCount = 0;
    const inputs = urls.slice(0, 2).flatMap((u) => ['-i', u]);
    const maps = urls.length >= 2 ? ['-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?'];

    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        ...inputs,
        ...maps,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-segment_list', `list-${this.run}.csv`,
        '-segment_list_type', 'csv',
        '-reset_timestamps', '1',
        `r${this.run}-%05d.ts`,
      ],
      { windowsHide: true, cwd: this.segDir }
    );
    this.recorder = child;
    this.status = 'recording';
    this.message = 'Grabando el directo...';

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    child.on('close', () => void this.onRecorderExit(stderr));
  }

  /** FFmpeg stopped: the stream ended, the URL expired, or the user stopped it. */
  private async onRecorderExit(stderr: string) {
    this.recorder = null;
    if (this.stopping) return;

    await this.readSegmentList();
    let stillLive = false;
    try {
      stillLive = (await fetchMetadata(this.url)).isLive;
    } catch {
      stillLive = false;
    }

    if (stillLive && this.reconnects < MAX_RECONNECTS) {
      this.reconnects++;
      this.message = `Se cortó la señal; reconectando (${this.reconnects}/${MAX_RECONNECTS})...`;
      console.warn('[live] reconectando:', stderr.trim().slice(0, 300));
      setTimeout(() => {
        this.startRecorder().catch((error) => this.fail(error));
      }, 3000);
      return;
    }

    this.message = 'El directo terminó. Sacando los últimos clips...';
    await this.finish();
  }

  /** Adds the pieces FFmpeg has finished writing since the last look. */
  private async readSegmentList() {
    let csv = '';
    try {
      csv = await readFile(path.join(this.segDir, `list-${this.run}.csv`), 'utf8');
    } catch {
      return;
    }
    const entries = parseSegmentList(csv);
    for (const entry of entries.slice(this.listCount)) {
      const start = this.segments.at(-1)?.end ?? 0;
      this.segments.push({ file: entry.file, start, end: start + entry.duration });
      // A piece arriving means the stream is flowing again.
      this.reconnects = 0;
    }
    this.listCount = entries.length;
  }

  private async tick(finishing = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.readSegmentList();
      if (this.settings.framingMode === 'auto') await this.detectKind();
      const recorded = this.segments.at(-1)?.end ?? 0;
      const fresh = recorded - this.transcribedUntil;
      if (fresh <= 0 || (!finishing && fresh < BATCH_SECONDS)) return;

      await this.transcribeNew();
      await this.findClips(finishing);
    } catch (error) {
      console.warn('[live] fallo en la ronda:', error);
      this.message = `Hubo un problema en una ronda (se reintenta): ${
        error instanceof Error ? error.message.slice(0, 140) : String(error)
      }`;
    } finally {
      this.busy = false;
    }
  }

  private async transcribeNew() {
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) return;

    const pieces = this.segments.filter((s) => s.start >= this.transcribedUntil - 0.01);
    if (pieces.length === 0) return;

    this.message = `Transcribiendo ${Math.round((pieces.at(-1)!.end - pieces[0].start) / 60)} min nuevos...`;
    const joined = await joinSegments(ffmpegPath, this.segDir, pieces, `batch-${this.rounds}.ts`);
    try {
      const result = await transcribe(joined, {
        // Detected once, then kept: every later round gets the same language
        // instead of guessing again from three minutes of audio.
        language: this.language ?? this.settings.language ?? 'auto',
      });
      this.language ??= result.language;
      const offset = pieces[0].start;
      this.words.push(
        ...result.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))
      );
      this.transcribedUntil = pieces.at(-1)!.end;
    } finally {
      await rm(joined, { force: true });
    }
  }

  private async findClips(finishing: boolean) {
    const until = this.transcribedUntil;
    const words = wordsForRound(this.words, until);
    this.rounds++;
    this.message = 'Buscando momentos llamativos...';

    const { minScore, minHook } = strictnessThresholds(this.settings.strictness);
    const result = await analyzeVideo({
      words,
      duration: until,
      language: this.language,
      historyKey: this.historyKey,
      live: {
        maxEnd: finishing ? until : until - SETTLE_SECONDS,
        minScore,
        minHook,
        maxClips: 3,
      },
    });
    this.analyzedUntil = finishing ? until : Math.max(0, until - SETTLE_SECONDS);

    for (const clip of result.suggestedClips) {
      const id = randomUUID().slice(0, 8);
      this.clipData.set(id, clip);
      this.clips.push({
        id,
        title: clip.title,
        hook: clip.hook,
        score: clip.viralityScore,
        start: clip.startTimeSeconds,
        end: clip.endTimeSeconds,
        status: 'waiting',
        caption: clip.socialPost.caption,
        hashtags: clip.socialPost.hashtags,
      });
      this.queueExport(id);
    }

    this.message =
      result.suggestedClips.length > 0
        ? `${result.suggestedClips.length} clip(s) nuevos en esta ronda. Grabando...`
        : 'Nada llamativo en los últimos minutos. Sigue grabando...';
  }

  /** Exports run one at a time: FFmpeg already fills the CPU with one clip. */
  private queueExport(clipId: string) {
    this.exportChain = this.exportChain.then(() => this.exportOne(clipId)).catch(() => {});
  }

  private async exportOne(clipId: string) {
    const clip = this.clips.find((c) => c.id === clipId);
    const data = this.clipData.get(clipId);
    if (!clip || !data) return;

    // Streamer layout without the webcam marked would guess a corner for every
    // clip; better to wait for the mark (setSettings re-queues these).
    if (this.needsWebcamMark()) {
      clip.status = 'waiting';
      return;
    }

    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) return;
    clip.status = 'exporting';

    const pieces = segmentsCovering(this.segments, clip.start - 0.5, clip.end + 0.5);
    let source: string | null = null;
    try {
      source = await joinSegments(ffmpegPath, this.segDir, pieces, `clip-${clipId}.ts`);
      const geometry = await probeMedia(source);
      const startInSource = clip.start - pieces[0].start;
      const duration = clip.end - clip.start;
      const index = this.clips.filter((c) => c.status === 'ready').length + 1;
      const fileName = `${String(index).padStart(2, '0')} - ${safeFileName(clip.title)}.mp4`;

      const mode = this.settings.framingMode;
      const speakers = this.marksNeeded() > 0 ? this.settings.speakers : undefined;

      // Camera cuts. A stream's game changes every pixel, so in streamer
      // mode only the webcam box is compared; for people talking the whole
      // frame is, against the moment they were marked when this clip covers
      // it, or else its longest shot (the main camera, in a talk stream).
      let shots;
      if (speakers?.[0] && mode === 'gameplay') {
        shots = await detectShots(ffmpegPath, source, startInSource, duration, null, {
          region: speakers[0],
          maxDistance: SAME_WEBCAM_MAX_DISTANCE,
        });
      } else if (speakers?.[0]) {
        const markedAt = speakers[0].markedAt;
        const inSource =
          typeof markedAt === 'number' && markedAt >= pieces[0].start && markedAt <= pieces.at(-1)!.end
            ? markedAt - pieces[0].start
            : null;
        shots = await detectShots(ffmpegPath, source, startInSource, duration, inSource);
      }

      await exportClip({
        inputPath: source,
        outputPath: path.join(this.outputDir, fileName),
        startSeconds: startInSource,
        durationSeconds: duration,
        aspectRatio: this.settings.aspectRatio,
        // 'auto' never reaches here (clips wait until it is decided); the
        // fallback only satisfies the type.
        framingMode: mode === 'auto' ? 'blur-fill' : mode,
        speakers,
        shots,
        gameplayLayout: this.settings.gameplayLayout,
        watermark: this.settings.watermark ?? null,
        sourceWidth: geometry.width ?? undefined,
        sourceHeight: geometry.height ?? undefined,
        subtitles: data.suggestedSubtitles,
        subtitleStyle: this.settings.subtitleStyle,
        subtitlePosition: this.settings.subtitlePosition,
        subtitleAnimation: this.settings.subtitleAnimation,
        burnSubtitles: this.settings.burnSubtitles,
      });
      clip.fileName = fileName;
      clip.status = 'ready';
    } catch (error) {
      clip.status = 'error';
      clip.error = error instanceof Error ? error.message.slice(0, 200) : String(error);
      console.warn('[live] fallo exportando', clip.title, error);
    } finally {
      if (source) await rm(source, { force: true });
    }
  }

  /** Framing changed mid-stream (typically: the webcam was just marked). */
  setSettings(update: Partial<LiveSettings>) {
    this.settings = { ...this.settings, ...update };
    for (const clip of this.clips) {
      if (clip.status === 'waiting' && !this.needsWebcamMark()) this.queueExport(clip.id);
    }
  }

  /** When the last frame handed out was recorded; marks made on it carry this. */
  frameTime(): number | null {
    return this.lastFrameTime;
  }

  /** A recent frame of the stream, for marking the webcam or the people on. */
  async latestFrame(): Promise<Buffer | null> {
    const ffmpegPath = await findFfmpeg();
    const last = this.segments.at(-1);
    if (!ffmpegPath || !last) return null;
    this.lastFrameTime = last.start + 5;
    return new Promise((resolve) => {
      const child = spawn(
        ffmpegPath,
        ['-v', 'error', '-ss', '5', '-i', last.file, '-frames:v', '1', '-vf', 'scale=960:-2', '-f', 'mjpeg', '-'],
        { windowsHide: true, cwd: this.segDir }
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    });
  }

  /** Snaps a click on the live frame to the webcam overlay, over the last minutes. */
  async findWebcam(x: number, y: number): Promise<Box | null> {
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath || this.segments.length === 0) return null;
    const recent = this.segments.slice(-3);
    const joined = await joinSegments(ffmpegPath, this.segDir, recent, `webcam-${Date.now()}.ts`);
    try {
      const length = recent.at(-1)!.end - recent[0].start;
      return await detectWebcamBox(ffmpegPath, joined, length / 2, length, x, y);
    } finally {
      await rm(joined, { force: true });
    }
  }

  /** Stop recording, judge what is left, finish the exports, delete the recording. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.recorder?.kill('SIGINT');
    this.recorder?.kill();
    await this.finish();
  }

  private async finish() {
    if (this.status === 'finishing' || this.status === 'done') return;
    this.stopping = true;
    this.status = 'finishing';
    if (this.timer) clearInterval(this.timer);

    // Let a round already running end before the last one.
    while (this.busy) await new Promise((r) => setTimeout(r, 500));
    this.message = 'Revisando los últimos minutos...';
    await this.tick(true);
    this.message = 'Terminando de exportar...';
    await this.exportChain;

    // The user chose to keep only the clips.
    await rm(this.segDir, { recursive: true, force: true }).catch(() => {});
    await clearDelivered(this.historyKey).catch(() => 0);

    const ready = this.clips.filter((c) => c.status === 'ready').length;
    const waiting = this.clips.filter((c) => c.status === 'waiting').length;
    this.status = 'done';
    this.message =
      `Listo: ${ready} clip${ready === 1 ? '' : 's'} en la carpeta. La grabación se borró.` +
      (waiting > 0 ? ` ${waiting} no se exportaron porque faltó marcar la cámara.` : '');
  }

  private fail(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.status = 'error';
    this.message = this.error;
    if (this.timer) clearInterval(this.timer);
    void rm(this.segDir, { recursive: true, force: true }).catch(() => {});
  }
}

const sessions = new Map<string, LiveSession>();

export async function startLiveSession(url: string, settings: LiveSettings, tempRoot: string) {
  const session = new LiveSession(url, settings, tempRoot);
  await session.start();
  sessions.set(session.id, session);
  return session;
}

export function getLiveSession(id: string): LiveSession | undefined {
  return sessions.get(id);
}

/** Stops every session; used when the server shuts down. */
export async function stopAllLiveSessions() {
  await Promise.all([...sessions.values()].map((s) => s.stop().catch(() => {})));
}
