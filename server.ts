import express, { type Request, type Response, type NextFunction } from 'express';
import compression from 'compression';
import { createServer as createViteServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import { analyzeVideo, transcribeClip, generateHooks, type AnalysisResult } from './lib/analysis.js';
import { clearDelivered, getDelivered, historyKey } from './lib/clip-history.js';
import { findWhisper, getWhisperSpeed, groupWordsIntoLines, WhisperUnavailableError } from './lib/whisper.js';
import { planCleanup } from './lib/speech-cleanup.js';
import { detectSpeakerTurns } from './lib/active-speaker.js';
import { detectShots, SAME_WEBCAM_MAX_DISTANCE } from './lib/shots.js';
import { normaliseGameplayLayout } from './lib/reframe.js';
import { detectWebcamBox } from './lib/webcam-box.js';
import { normaliseWatermark } from './lib/watermark.js';
import {
  startLiveSession,
  getLiveSession,
  type LiveSettings,
  type Strictness,
} from './lib/live.js';
import { measureOllamaSpeed, getOllamaStatus, OllamaUnavailableError } from './lib/ollama.js';
import { fetchSourceInfo, isLinkIngestSupported, looksLikeUrl, normalizeUrl } from './lib/media.js';
import {
  YtDlpUnavailableError,
  LiveStreamError,
  UnsupportedUrlError,
  downloadVideo,
} from './lib/ytdlp.js';
import {
  exportClip,
  findFfmpeg,
  probeDuration,
  probeMedia,
  FfmpegUnavailableError,
} from './lib/ffmpeg.js';

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Bound to loopback on purpose.
 *
 * This build runs entirely on the user's own machine and it
 * can read local files by request. Listening on 0.0.0.0 would hand all of that
 * to anyone else on the same network.
 */
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(compression());
app.use(express.json({ limit: '64mb' }));

// ---------------------------------------------------------------------------
// Uploaded source registry
// ---------------------------------------------------------------------------
// FFmpeg needs a real file on disk. The browser only has a Blob, so each loaded
// video is streamed here once and reused for every clip exported from it.

const SOURCE_DIR = path.join(tmpdir(), 'extractor-clips-virales');
const sources = new Map<string, { filePath: string; fileName: string }>();

async function cleanupSources() {
  await rm(SOURCE_DIR, { recursive: true, force: true }).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void cleanupSources().finally(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/**
 * Whether this error is just the browser hanging up.
 *
 * Video elements abort range requests constantly - seeking, pausing, changing
 * source, closing the tab. None of that is a server fault and none of it is
 * worth a stack trace.
 */
function isClientDisconnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'EPIPE') {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /premature close|aborted|socket hang up/i.test(message);
}

function sendError(res: Response, error: unknown) {
  // Once a response has started - a streaming video, a finished export - the
  // status and headers are already on the wire and cannot be replaced. Trying
  // anyway throws ERR_HTTP_HEADERS_SENT from inside a .catch(), which is an
  // unhandled rejection, which takes the whole server process down.
  //
  // That is not theoretical: it is what killed this server mid-session, and
  // the user saw it as "No se pudo conectar con el servidor". A dropped
  // connection by a video player must never be able to stop the app.
  if (res.headersSent || res.writableEnded) {
    if (!isClientDisconnect(error)) {
      console.error('[api] fallo después de empezar a responder:', error);
    }
    res.destroy();
    return;
  }

  if (isClientDisconnect(error)) {
    // The client is gone; there is nobody left to tell.
    res.destroy();
    return;
  }

  if (error instanceof FfmpegUnavailableError) {
    return res.status(501).json({ error: error.message, ffmpegMissing: true });
  }
  if (error instanceof YtDlpUnavailableError) {
    return res.status(501).json({ error: error.message, ytDlpMissing: true });
  }
  // These two are the user's input, not a server fault, so they get a 400 and
  // a message that says what to do instead.
  if (error instanceof LiveStreamError) {
    return res.status(400).json({ error: error.message, isLive: true });
  }
  if (error instanceof UnsupportedUrlError) {
    return res.status(400).json({ error: error.message, unsupportedUrl: true });
  }
  if (error instanceof WhisperUnavailableError) {
    return res.status(501).json({ error: error.message, whisperMissing: true });
  }
  if (error instanceof OllamaUnavailableError) {
    return res.status(501).json({ error: error.message, ollamaMissing: true });
  }
  const message = error instanceof Error ? error.message : 'Error interno del servidor.';
  console.error('[api]', message);
  return res.status(500).json({ error: message });
}

/** Wraps an async handler so a rejected promise becomes a JSON error, not a hang. */
function handler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((error) => sendError(res, error));
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

app.get(
  '/api/health',
  handler(async (_req, res) => {
    const [ffmpegPath, linksReady, whisper, ollama] = await Promise.all([
      findFfmpeg(),
      isLinkIngestSupported(),
      findWhisper(),
      getOllamaStatus(),
    ]);

    res.json({
      status: 'ok',
      ffmpegAvailable: Boolean(ffmpegPath),
      exportEngine: ffmpegPath ? 'ffmpeg' : 'browser',
      linksEnabled: linksReady,
      whisperAvailable: Boolean(whisper),
      whisperModel: whisper?.modelName ?? null,
      whisperBackend: whisper?.backend ?? null,
      // Whether voice activity detection is available. Without it whisper
      // writes invented words over silence, and those were enough to seed
      // clips in which nobody speaks.
      whisperVad: Boolean(whisper?.vadModel),
      // Measured on this machine after the first transcription, so the UI can
      // quote a real figure instead of a constant that was wrong by 40x.
      ...(() => {
        const { speed, measured } = getWhisperSpeed(whisper?.backend ?? null);
        return { whisperSpeed: Math.round(speed * 10) / 10, whisperSpeedMeasured: measured };
      })(),
      ollamaAvailable: ollama.available,
      ollamaModel: ollama.chosenModel,
      // Tokens per second, measured. Null when there is no model to ask.
      // Surfaced because a contended GPU drops this by two orders of
      // magnitude and the only symptom otherwise is copy quietly going back
      // to templates after a long wait.
      ollamaSpeed: ollama.available ? await measureOllamaSpeed() : null,
      // Everything runs locally now; nothing leaves this machine.
      cloudServices: [],
    });
  })
);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface AnalysisJob {
  stage: string;
  progress: number;
  done: boolean;
  result?: AnalysisResult;
  error?: string;
  cancelled?: boolean;
}

const analysisJobs = new Map<string, AnalysisJob>();
/** Lets /cancel kill the whisper process a job is waiting on. */
const analysisAborts = new Map<string, AbortController>();

app.post(
  '/api/analyze-video',
  handler(async (req, res) => {
    const {
      sourceId,
      duration,
      contextNotes,
      transcript,
      transcriptionMode,
      language,
      allowRepeats,
    } = req.body ?? {};

    const source = sources.get(String(sourceId));
    if (!source?.filePath) {
      return res.status(404).json({
        error: 'La fuente de video ya no está disponible. Vuelve a cargar el video.',
      });
    }
    if (!duration || duration <= 0) {
      return res.status(400).json({ error: 'Duración de video inválida.' });
    }

    const jobId = randomUUID();
    const controller = new AbortController();
    analysisJobs.set(jobId, { stage: 'Preparando...', progress: 0, done: false });
    analysisAborts.set(jobId, controller);
    res.json({ jobId });

    void (async () => {
      try {
        const result = await analyzeVideo({
          videoPath: source.filePath,
          duration: Number(duration),
          contextNotes,
          transcript,
          transcriptionMode,
          language: typeof language === 'string' ? language : undefined,
          // The link for downloads, the file name for uploads; see historyKey.
          historyKey: historyKey(source.fileName || source.filePath, Number(duration)),
          allowRepeats: allowRepeats === true,
          signal: controller.signal,
          onProgress: (stage, progress) => {
            const job = analysisJobs.get(jobId);
            if (job) {
              job.stage = stage;
              job.progress = progress;
            }
          },
        });
        analysisJobs.set(jobId, { stage: 'Listo', progress: 1, done: true, result });
      } catch (error) {
        const cancelled = controller.signal.aborted;
        analysisJobs.set(jobId, {
          stage: cancelled ? 'Cancelado' : 'Error',
          progress: 0,
          done: true,
          cancelled,
          error: cancelled
            ? 'Análisis cancelado.'
            : error instanceof Error
              ? error.message
              : 'Fallo al analizar el video.',
        });
      } finally {
        analysisAborts.delete(jobId);
      }
    })();
  })
);

/**
 * How many clips of a loaded video were already delivered, and a way to
 * forget them. The UI shows the count so a short result reads as "this video
 * is running out" rather than as the app getting worse.
 */
app.post(
  '/api/clip-history',
  handler(async (req, res) => {
    const { sourceId, duration, clear } = req.body ?? {};
    const source = sources.get(String(sourceId));
    if (!source?.filePath || !duration) {
      return res.json({ delivered: 0 });
    }
    const key = historyKey(source.fileName || source.filePath, Number(duration));
    if (clear === true) {
      const removed = await clearDelivered(key);
      return res.json({ delivered: 0, removed });
    }
    res.json({ delivered: (await getDelivered(key)).length });
  })
);

app.post(
  '/api/analyze-video/:jobId/cancel',
  handler(async (req, res) => {
    const controller = analysisAborts.get(String(req.params.jobId));
    if (!controller) return res.status(404).json({ error: 'Análisis no encontrado o ya terminado.' });
    controller.abort();
    res.json({ cancelled: true });
  })
);

app.get(
  '/api/analyze-video/:jobId',
  handler(async (req, res) => {
    const job = analysisJobs.get(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Análisis no encontrado.' });
    res.json(job);
    if (job.done) setTimeout(() => analysisJobs.delete(String(req.params.jobId)), 120000);
  })
);

app.post(
  '/api/transcribe-clip',
  handler(async (req, res) => {
    const { sourceId, startSeconds, durationSeconds } = req.body ?? {};
    const source = sources.get(String(sourceId));
    if (!source?.filePath) {
      return res.status(404).json({ error: 'La fuente de video ya no está disponible.' });
    }
    res.json(
      await transcribeClip({
        videoPath: source.filePath,
        startSeconds: Number(startSeconds) || 0,
        durationSeconds: Math.max(0.5, Number(durationSeconds) || 30),
      })
    );
  })
);

app.post(
  '/api/generate-hooks',
  handler(async (req, res) => {
    res.json(await generateHooks(req.body ?? {}));
  })
);

// ---------------------------------------------------------------------------
// YouTube (works here because the server and the browser share a public IP)
// ---------------------------------------------------------------------------

app.post(
  '/api/source/info',
  handler(async (req, res) => {
    const raw = String(req.body?.url || '').trim();
    if (!looksLikeUrl(raw)) {
      return res.status(400).json({ error: 'Eso no parece un enlace de video.' });
    }
    res.json(await fetchSourceInfo(raw));
  })
);

/**
 * Downloads a linked video into the source registry.
 *
 * Runs as a background job with a pollable status: a long video takes far
 * longer than a request should be held open, and the UI needs real progress.
 */
interface DownloadJob {
  progress: number;
  done: boolean;
  sourceId?: string;
  duration?: number | null;
  error?: string;
}

const downloadJobs = new Map<string, DownloadJob>();

app.post(
  '/api/source/prepare',
  handler(async (req, res) => {
    const raw = String(req.body?.url || '').trim();
    if (!looksLikeUrl(raw)) {
      return res.status(400).json({ error: 'Eso no parece un enlace de video.' });
    }

    const url = normalizeUrl(raw);
    const jobId = randomUUID();
    downloadJobs.set(jobId, { progress: 0, done: false });
    res.json({ jobId });

    // Deliberately not awaited: the client polls /api/source/prepare/:jobId.
    void (async () => {
      try {
        await mkdir(SOURCE_DIR, { recursive: true });
        const ffmpegPath = await findFfmpeg();
        const filePath = await downloadVideo(url, SOURCE_DIR, ffmpegPath, (fraction) => {
          const job = downloadJobs.get(jobId);
          if (job) job.progress = fraction;
        });

        const sourceId = randomUUID();
        sources.set(sourceId, { filePath, fileName: url });

        downloadJobs.set(jobId, {
          progress: 1,
          done: true,
          sourceId,
          duration: await probeDuration(filePath),
        });
      } catch (error) {
        downloadJobs.set(jobId, {
          progress: 0,
          done: true,
          error: error instanceof Error ? error.message : 'Fallo al descargar el video.',
        });
      }
    })();
  })
);

app.get(
  '/api/source/prepare/:jobId',
  handler(async (req, res) => {
    const job = downloadJobs.get(String(req.params.jobId));
    if (!job) return res.status(404).json({ error: 'Descarga no encontrada.' });
    res.json(job);
    if (job.done) setTimeout(() => downloadJobs.delete(String(req.params.jobId)), 60000);
  })
);

/**
 * Serves a registered source for playback, with byte-range support so the
 * preview player can scrub without downloading the whole file first.
 */
app.get(
  '/api/source/:sourceId/stream',
  handler(async (req, res) => {
    const source = sources.get(String(req.params.sourceId));
    if (!source?.filePath) return res.status(404).json({ error: 'Fuente no encontrada.' });

    const { size } = await stat(source.filePath);
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
      res.setHeader('Content-Length', String(size));
      await pipeline(createReadStream(source.filePath), res);
      return;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

    if (start >= size || start > end) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    await pipeline(createReadStream(source.filePath, { start, end }), res);
  })
);

// ---------------------------------------------------------------------------
// Source upload
// ---------------------------------------------------------------------------

app.post(
  '/api/source/upload',
  // No body parser here on purpose. express.raw() would buffer the whole upload
  // into memory and leave req already consumed, so the pipeline below would
  // write an empty file - and an 8 GB video has no business being buffered.
  handler(async (req, res) => {
    await mkdir(SOURCE_DIR, { recursive: true });

    const fileName = String(req.header('x-file-name') || 'video.mp4');
    const sourceId = randomUUID();
    const filePath = path.join(SOURCE_DIR, `${sourceId}${path.extname(fileName) || '.mp4'}`);

    await pipeline(req, createWriteStream(filePath));

    const { size } = await stat(filePath);
    if (size === 0) {
      await rm(filePath, { force: true });
      return res.status(400).json({ error: 'El archivo llegó vacío.' });
    }

    sources.set(sourceId, { filePath, fileName });
    res.json({ sourceId, fileName, bytes: size, duration: await probeDuration(filePath) });
  })
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Snaps a click on a streamer's webcam to the overlay's exact rectangle, so
 * the webcam panel shows the face and nothing of the game around it.
 */
app.post(
  '/api/webcam-box',
  handler(async (req, res) => {
    const { sourceId, time, x, y } = req.body ?? {};
    const source = sources.get(String(sourceId));
    if (!source?.filePath) return res.status(404).json({ error: 'Fuente no encontrada.' });

    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) return res.json({ box: null });

    const duration = (await probeDuration(source.filePath)) ?? Number(time) + 1;
    const box = await detectWebcamBox(
      ffmpegPath,
      source.filePath,
      Number(time) || 0,
      duration,
      Math.min(1, Math.max(0, Number(x) || 0)),
      Math.min(1, Math.max(0, Number(y) || 0))
    );
    res.json({ box });
  })
);

// ---------------------------------------------------------------------------
// Live: record a stream that is still on air and clip it as it goes
// ---------------------------------------------------------------------------

const LIVE_FRAMINGS = ['auto', 'focus', 'split', 'gameplay', 'blur-fill', 'zoom-crop', 'fit'];

/** Settings from the client, reduced to what live mode supports. */
function liveSettingsFrom(raw: Record<string, unknown> = {}): LiveSettings {
  const framing = LIVE_FRAMINGS.includes(String(raw.framingMode))
    ? (raw.framingMode as LiveSettings['framingMode'])
    : 'auto';
  const strictness = ['alta', 'media', 'baja'].includes(String(raw.strictness))
    ? (raw.strictness as Strictness)
    : 'media';
  return {
    aspectRatio: ['9:16', '1:1', '16:9'].includes(String(raw.aspectRatio))
      ? (raw.aspectRatio as LiveSettings['aspectRatio'])
      : '9:16',
    framingMode: framing,
    speakers: Array.isArray(raw.speakers) ? (raw.speakers as LiveSettings['speakers']) : undefined,
    gameplayLayout: normaliseGameplayLayout(raw.gameplayLayout),
    watermark: normaliseWatermark(raw.watermark),
    subtitleStyle: (typeof raw.subtitleStyle === 'string' ? raw.subtitleStyle : 'pill') as LiveSettings['subtitleStyle'],
    subtitleAnimation: (typeof raw.subtitleAnimation === 'string'
      ? raw.subtitleAnimation
      : 'word-pop') as LiveSettings['subtitleAnimation'],
    subtitlePosition: 'bottom',
    burnSubtitles: raw.burnSubtitles !== false,
    language: typeof raw.language === 'string' && raw.language ? raw.language : 'auto',
    strictness,
  };
}

app.post(
  '/api/live/start',
  handler(async (req, res) => {
    const raw = String(req.body?.url || '').trim();
    if (!looksLikeUrl(raw)) {
      return res.status(400).json({ error: 'Eso no parece un enlace de un directo.' });
    }
    await mkdir(SOURCE_DIR, { recursive: true });
    const session = await startLiveSession(
      normalizeUrl(raw),
      liveSettingsFrom(req.body?.settings ?? {}),
      SOURCE_DIR
    );
    res.json(session.view());
  })
);

app.get(
  '/api/live/:id',
  handler(async (req, res) => {
    const session = getLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Sesión de directo no encontrada.' });
    res.json(session.view());
  })
);

app.post(
  '/api/live/:id/stop',
  handler(async (req, res) => {
    const session = getLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Sesión de directo no encontrada.' });
    // Finishing takes a while (last round + exports); report progress by polling.
    void session.stop();
    res.json(session.view());
  })
);

app.post(
  '/api/live/:id/settings',
  handler(async (req, res) => {
    const session = getLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Sesión de directo no encontrada.' });
    const body = req.body ?? {};
    const update: Partial<LiveSettings> = {};
    // Switching framing mid-stream (auto guessed wrong, or the user changed
    // their mind): the old marks belong to the old framing, so they go.
    if (LIVE_FRAMINGS.includes(String(body.framingMode))) {
      update.framingMode = body.framingMode as LiveSettings['framingMode'];
      update.speakers = [];
    }
    if (Array.isArray(body.speakers)) update.speakers = body.speakers;
    if (body.gameplayLayout) update.gameplayLayout = normaliseGameplayLayout(body.gameplayLayout);
    if ('watermark' in body) update.watermark = normaliseWatermark(body.watermark);
    session.setSettings(update);
    res.json(session.view());
  })
);

app.get(
  '/api/live/:id/frame',
  handler(async (req, res) => {
    const session = getLiveSession(String(req.params.id));
    const frame = session ? await session.latestFrame() : null;
    if (!frame) return res.status(404).json({ error: 'Todavía no hay imagen del directo.' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    // Marks made on this frame carry its time, so camera cuts can be judged
    // against the shot the person was marked in.
    res.setHeader('X-Frame-Time', String(session?.frameTime() ?? ''));
    res.end(frame);
  })
);

app.post(
  '/api/live/:id/webcam',
  handler(async (req, res) => {
    const session = getLiveSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: 'Sesión de directo no encontrada.' });
    const x = Math.min(1, Math.max(0, Number(req.body?.x) || 0));
    const y = Math.min(1, Math.max(0, Number(req.body?.y) || 0));
    res.json({ box: await session.findWebcam(x, y) });
  })
);

app.get(
  '/api/live/:id/clips/:clipId',
  handler(async (req, res) => {
    const file = getLiveSession(String(req.params.id))?.clipFile(String(req.params.clipId));
    if (!file) return res.status(404).json({ error: 'Clip no encontrado.' });
    res.download(file);
  })
);

app.post(
  '/api/live/:id/open-folder',
  handler(async (req, res) => {
    const dir = getLiveSession(String(req.params.id))?.view().outputDir;
    if (!dir) return res.status(404).json({ error: 'Sesión de directo no encontrada.' });
    // Only ever a folder this app created under clips-en-vivo.
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    res.json({ opened: true });
  })
);

app.post(
  '/api/export',
  handler(async (req, res) => {
    const {
      sourceId,
      clipTitle = 'clip',
      startSeconds = 0,
      durationSeconds = 30,
      aspectRatio = '9:16',
      framingMode = 'blur-fill',
      subtitles = [],
      subtitleStyle = 'pill',
      subtitlePosition = 'bottom',
      subtitleAnimation = 'word-pop',
      burnSubtitles = true,
      speakers,
      speechCleanup = false,
      removeFillers = true,
      subtitleOverrides,
      emojiImages,
      gameplayLayout,
      watermark,
    } = req.body ?? {};

    const source = sources.get(sourceId);
    if (!source) {
      return res.status(404).json({
        error: 'La fuente de video ya no está disponible. Vuelve a cargar el video.',
      });
    }

    const inputPath = source.filePath;

    await mkdir(SOURCE_DIR, { recursive: true });
    const outputPath = path.join(SOURCE_DIR, `${randomUUID()}.mp4`);

    // The marked regions are normalised, so turning them into pixel crops
    // needs the source frame size.
    const geometry = await probeMedia(inputPath);

    // Speech cleanup needs per-word timings. They ride along inside the
    // subtitles the client already holds, so nothing extra has to be sent.
    let activeSubtitles = subtitles;
    let keepSegments;

    if (speechCleanup) {
      const words = (subtitles as Array<{ words?: Array<{ text: string; start: number; end: number }> }>)
        .flatMap((line) => line.words ?? []);

      if (words.length > 0) {
        const clipDuration = Math.max(0.5, Number(durationSeconds));
        const plan = planCleanup(words, 0, clipDuration, { removeFillers });

        if (plan.segments.length > 1 || plan.removedFillers > 0) {
          keepSegments = plan.segments;
          // Captions have to follow the cuts, or they drift out of sync with
          // the speech they are transcribing.
          activeSubtitles = groupWordsIntoLines(plan.words).map((line) => ({
            text: line.text,
            startTime: Math.round(line.start * 10) / 10,
            endTime: Math.round(line.end * 10) / 10,
            words: line.words,
          }));
        }
      }
    }

    // The framings that crop a marked region need to know where the camera
    // cuts, and which shots come from the camera the region was marked on;
    // the others are shown whole instead (see lib/shots.ts).
    let shots;
    if (
      (framingMode === 'focus' ||
        framingMode === 'split' ||
        framingMode === 'auto-fill' ||
        framingMode === 'gameplay') &&
      aspectRatio !== 'original'
    ) {
      const ffmpegPath = await findFfmpeg();
      const markedAt = Array.isArray(speakers)
        ? (speakers as Array<{ markedAt?: unknown }>).find((s) => typeof s?.markedAt === 'number')
            ?.markedAt
        : undefined;
      // Without a marked webcam there is nothing to compare: the default
      // corner is a guess, and judging every shot against a guess would only
      // add noise.
      const comparable =
        framingMode !== 'gameplay' || (Array.isArray(speakers) && speakers.length > 0);
      if (ffmpegPath && comparable) {
        shots = await detectShots(
          ffmpegPath,
          inputPath,
          Number(startSeconds) || 0,
          Math.max(0.5, Number(durationSeconds) || 30),
          typeof markedAt === 'number' ? markedAt : null,
          // A stream's game changes every pixel, so only the webcam box is
          // compared - and only if one was actually marked.
          framingMode === 'gameplay'
            ? { region: speakers[0], maxDistance: SAME_WEBCAM_MAX_DISTANCE }
            : {}
        );
      }
    }

    // The auto-fill framing needs to know who is talking when, which means a
    // quick movement pass over the clip before rendering it.
    let turns;
    if (framingMode === 'auto-fill' && Array.isArray(speakers) && speakers.length >= 2) {
      turns = await detectSpeakerTurns(
        inputPath,
        speakers,
        Number(startSeconds) || 0,
        Math.max(0.5, Number(durationSeconds) || 30),
        {},
        shots
      );
    }

    try {
      await exportClip({
        inputPath,
        turns,
        shots,
        gameplayLayout: normaliseGameplayLayout(gameplayLayout),
        watermark: normaliseWatermark(watermark),
        sourceWidth: geometry.width ?? undefined,
        sourceHeight: geometry.height ?? undefined,
        speakers,
        outputPath,
        startSeconds: Number(startSeconds),
        durationSeconds: Math.max(0.5, Number(durationSeconds)),
        aspectRatio,
        framingMode,
        subtitles: activeSubtitles,
        keepSegments,
        subtitleStyle,
        subtitleOverrides,
        emojiImages,
        subtitlePosition,
        subtitleAnimation,
        burnSubtitles,
      });

      const safeName =
        String(clipTitle).replace(/[^a-z0-9_-]/gi, '_').slice(0, 45) || 'clip_viral';

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}_${String(aspectRatio).replace(':', 'x')}.mp4"`
      );
      res.setHeader('Content-Length', String((await stat(outputPath)).size));

      await pipeline(createReadStream(outputPath), res);
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  })
);

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

/**
 * Last line of defence: a stray error must not close the app.
 *
 * This is a tool someone runs on their own machine and leaves open while they
 * work. If the process exits, every page they have open starts reporting "no
 * se pudo conectar con el servidor" and the only cure is relaunching the .bat.
 * A long download or a half-written export is worth far more than the purity
 * of crashing on an unexpected error, so these are logged loudly and survived.
 *
 * Deliberately loud rather than silent: a swallowed error nobody can see is
 * how a bug lives for months.
 */
function installCrashGuards() {
  process.on('uncaughtException', (error) => {
    console.error('\n[servidor] Error no capturado (el servidor sigue en pie):\n', error);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('\n[servidor] Promesa rechazada sin manejar (el servidor sigue en pie):\n', reason);
  });
}

async function start() {
  installCrashGuards();

  // Explicit http server so Vite's HMR websocket can ride on the same port via
  // the upgrade handshake. Giving HMR its own port leaves it with nothing
  // listening, which floods the browser console with failed connections.
  const httpServer = createHttpServer(app);

  if (IS_PRODUCTION) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*splat', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, HOST, async () => {
    const [ffmpegPath, linksReady] = await Promise.all([findFfmpeg(), isLinkIngestSupported()]);
    console.log('');
    console.log('  Extractor de Clips Virales');
    console.log(`  Abre:    http://localhost:${PORT}`);
    console.log(
      `  Export:  ${ffmpegPath ? 'FFmpeg (MP4 rapido)' : 'navegador (FFmpeg no encontrado)'}`
    );
    console.log(
      `  Enlaces: ${linksReady ? 'YouTube, Kick, Twitch, Vimeo y +1700 sitios' : 'no disponible (falta yt-dlp)'}`
    );
    const whisper = await findWhisper();
    const ollama = await getOllamaStatus();
    console.log(
      `  Whisper: ${whisper ? `${whisper.modelName} (${whisper.backend === 'gpu' ? 'GPU' : 'CPU'})` : 'no encontrado'}`
    );
    console.log(`  Ollama:  ${ollama.chosenModel ?? 'no disponible (cortes por heuristicas)'}`);
    console.log('');
  });
}

start().catch((err) => {
  console.error('Fallo al iniciar el servidor:', err);
  process.exit(1);
});
