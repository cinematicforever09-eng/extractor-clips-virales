import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAssFile,
  captionMetrics,
  type SubtitleStyleId,
  type SubtitlePosition,
  type SubtitleAnimation,
  type StyleOverrides,
} from './ass.js';
import {
  collectEmojiCues,
  planEmojiLayout,
  estimateCaptionLines,
  buildEmojiOverlayFilter,
  type EmojiCue,
} from './emoji-overlay.js';
import type { TimedLine } from './subtitles.js';
import {
  buildReframeFilter,
  type FramingMode as ReframeMode,
  type SpeakerRegion,
  type SpeakerTurnInput,
  type GameplayLayout,
  gameplayPanels,
  normaliseGameplayLayout,
} from './reframe.js';
import { buildCleanupFilter, type KeepSegment } from './speech-cleanup.js';
import { buildLoudnormFilter, measureLoudness } from './loudness.js';
import { accentForClip } from './accent.js';
import { getSubtitleStyle } from './subtitle-styles.js';
import { buildWatermarkFilter, decodeWatermarkPng, type WatermarkSettings } from './watermark.js';
import { fallbackRanges, remapToKept, type Shot } from './shots.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type AspectRatio = '9:16' | '1:1' | '16:9' | 'original';
export type FramingMode = ReframeMode;
export type { SpeakerRegion };

export interface ExportRequest {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  framingMode: FramingMode;
  subtitles: TimedLine[];
  subtitleStyle: SubtitleStyleId;
  subtitlePosition: SubtitlePosition;
  subtitleAnimation: SubtitleAnimation;
  burnSubtitles: boolean;
  /** Regions the user marked, for the focus and split framings. */
  speakers?: SpeakerRegion[];
  /** Source geometry, needed to turn normalised regions into pixel crops. */
  sourceWidth?: number;
  sourceHeight?: number;
  /**
   * Spans to keep, relative to the start of the clip. When present the clip is
   * cut and stitched before anything else, so pauses and fillers disappear.
   */
  keepSegments?: KeepSegment[];
  /** Who is on screen when, for the auto-fill framing. */
  turns?: SpeakerTurnInput[];
  /** Size, colour and position tweaks on top of the subtitle preset. */
  subtitleOverrides?: StyleOverrides;
  /**
   * Each emoji the captions use, rasterised by the browser as a base64 PNG.
   *
   * Keyed by the emoji itself. libass cannot draw colour emoji, so these
   * pixels are the only way a burned-in 🔥 looks like the one in the preview.
   */
  emojiImages?: Record<string, string>;
  /**
   * Bring the audio to -14 LUFS (see loudness.ts). On unless explicitly
   * turned off.
   */
  normalizeLoudness?: boolean;
  /**
   * Camera shots in the clip, from shots.ts, relative to the clip start and
   * already flagged as matching the frame the regions were marked on or not.
   * Shots that do not match are shown whole (blur-fill) instead of cropped.
   */
  shots?: Shot[];
  /** 'gameplay' only: webcam on top or below, and how tall. */
  gameplayLayout?: GameplayLayout;
  /** The user's PNG logo, laid over the finished picture (see watermark.ts). */
  watermark?: WatermarkSettings | null;
  onProgress?: (fraction: number) => void;
}

// ---------------------------------------------------------------------------
// Locating the binary
// ---------------------------------------------------------------------------

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runsSuccessfully(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['-version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

let cachedPath: string | null | undefined;

/**
 * Finds an ffmpeg binary, in order of preference:
 *
 *   1. FFMPEG_PATH, for an explicit override.
 *   2. bin/ffmpeg.exe inside the project, so the whole folder can be copied to
 *      another machine and still export without a system install.
 *   3. PATH.
 *   4. The layout winget uses, which does not always land on PATH until the
 *      shell is restarted - a common "ffmpeg is installed but not found" case.
 *
 * Returns null when none is usable; the caller then falls back to the browser
 * export engine rather than failing.
 */
export async function findFfmpeg(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  const isWindows = process.platform === 'win32';
  const exe = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

  const explicit = process.env.FFMPEG_PATH;
  if (explicit && (await isExecutable(explicit))) {
    cachedPath = explicit;
    return cachedPath;
  }

  const bundled = path.join(projectRoot, 'bin', exe);
  if (await isExecutable(bundled)) {
    cachedPath = bundled;
    return cachedPath;
  }

  if (await runsSuccessfully('ffmpeg')) {
    cachedPath = 'ffmpeg';
    return cachedPath;
  }

  if (isWindows) {
    const wingetRoot = path.join(
      homedir(),
      'AppData',
      'Local',
      'Microsoft',
      'WinGet',
      'Packages'
    );
    const { readdir } = await import('node:fs/promises');
    try {
      const packages = await readdir(wingetRoot);
      for (const pkg of packages.filter((name) => name.toLowerCase().includes('ffmpeg'))) {
        const builds = await readdir(path.join(wingetRoot, pkg)).catch(() => []);
        for (const build of builds) {
          const candidate = path.join(wingetRoot, pkg, build, 'bin', exe);
          if (await isExecutable(candidate)) {
            cachedPath = candidate;
            return cachedPath;
          }
        }
      }
    } catch {
      // No winget packages directory; fall through.
    }
  }

  cachedPath = null;
  return null;
}

/** Forces re-detection, for when the user installs ffmpeg without restarting. */
export function resetFfmpegCache(): void {
  cachedPath = undefined;
}

// ---------------------------------------------------------------------------
// Filter graph
// ---------------------------------------------------------------------------

function targetSize(aspectRatio: AspectRatio): { width: number; height: number } | null {
  switch (aspectRatio) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '16:9':
      return { width: 1920, height: 1080 };
    default:
      return null; // keep the source geometry
  }
}

/**
 * Builds the video filter chain.
 *
 * Reframing happens first and subtitles are burned last, so text is rendered at
 * output resolution and never scaled or blurred along with the picture. The
 * reframing geometry lives in reframe.ts, where it is unit tested.
 */
interface BuiltFilter {
  filter: string;
  /** Stream to map as video output. */
  videoMap: string;
  /** Stream to map as audio, or null to take the input's own track. */
  audioMap: string | null;
}

/** The emoji PNGs this export needs, already laid out and indexed as inputs. */
interface EmojiPlan {
  cues: EmojiCue[];
  layout: { size: number; x: number; y: number };
  /** FFmpeg input index of the first PNG; 0 is the source video. */
  firstInputIndex: number;
}

function buildVideoFilter(
  request: ExportRequest,
  burnSubtitles: boolean,
  assFileName: string,
  emoji: EmojiPlan | null
): BuiltFilter | null {
  const size = targetSize(request.aspectRatio);

  // Cleanup runs first so everything downstream works on the shortened clip.
  const cleanup = request.keepSegments
    ? buildCleanupFilter(request.keepSegments, true)
    : null;

  const videoSource = cleanup ? cleanup.videoLabel : '[0:v]';
  const prefix = cleanup ? `${cleanup.filter};` : '';
  const audioMap = cleanup ? cleanup.audioLabel : null;

  /**
   * Composites the emoji last of all.
   *
   * After the subtitles on purpose: an emoji is meant to sit over the picture
   * next to the caption, and anything burned in afterwards would paint over it.
   */
  const withEmoji = (graph: string, label: string): BuiltFilter => {
    const overlays = emoji
      ? buildEmojiOverlayFilter(label, emoji.cues, emoji.layout, emoji.firstInputIndex)
      : null;

    if (!overlays) return { filter: graph, videoMap: label, audioMap };
    return {
      filter: `${graph};${overlays.filter}`,
      videoMap: overlays.outLabel,
      audioMap,
    };
  };

  if (!size) {
    // 'original' keeps the source geometry; only subtitles are applied.
    if (!burnSubtitles && !cleanup && !emoji) return null;
    return withEmoji(
      `${prefix}${videoSource}${burnSubtitles ? `ass=${assFileName}:fontsdir=fonts` : 'null'}[vout]`,
      '[vout]'
    );
  }

  const { filter } = buildReframeFilter({
    sourceWidth: request.sourceWidth ?? 1920,
    sourceHeight: request.sourceHeight ?? 1080,
    targetWidth: size.width,
    targetHeight: size.height,
    mode: request.framingMode,
    speakers: request.speakers,
    turns: request.turns,
    gameplayLayout: request.gameplayLayout,
    inputLabel: videoSource,
    // Shot times are on the clip's own timeline; after speech cleanup the
    // picture runs on the stitched one.
    fallbackRanges: request.shots
      ? remapToKept(fallbackRanges(request.shots), request.keepSegments)
      : undefined,
  });

  return withEmoji(
    `${prefix}${filter}${burnSubtitles ? `,ass=${assFileName}:fontsdir=fonts` : ''}[vout]`,
    '[vout]'
  );
}

// ---------------------------------------------------------------------------
// Running the export
// ---------------------------------------------------------------------------

export class FfmpegUnavailableError extends Error {
  constructor() {
    super('FFmpeg no está disponible en este equipo.');
    this.name = 'FfmpegUnavailableError';
  }
}

/**
 * Where captions go in 'Streamer + juego' when the user has not dragged them.
 *
 * On the seam between the game and the webcam. The usual bottom position
 * lands on the streamer's mouth when the webcam is below, and on the game's
 * HUD when it is above; the seam covers neither and is where the eye moves
 * between the two anyway. A caption the user dragged keeps its spot.
 */
export function gameplayCaptionAnchor(
  request: Pick<ExportRequest, 'framingMode' | 'gameplayLayout' | 'speakers' | 'sourceWidth' | 'sourceHeight' | 'subtitleOverrides'>,
  size: { width: number; height: number } | null
): { x: number; y: number } | null {
  if (request.framingMode !== 'gameplay' || !size || request.subtitleOverrides?.anchor) return null;
  const layout = normaliseGameplayLayout(request.gameplayLayout);
  const { camHeight, gameHeight } = gameplayPanels(
    layout,
    request.speakers?.[0],
    request.sourceWidth ?? 1920,
    request.sourceHeight ?? 1080,
    size.width,
    size.height
  );
  const seam = layout.camPosition === 'bottom' ? gameHeight : camHeight;
  return { x: 0.5, y: seam / size.height };
}

export async function exportClip(request: ExportRequest): Promise<void> {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) throw new FfmpegUnavailableError();

  const size = targetSize(request.aspectRatio);
  const burn = request.burnSubtitles && request.subtitles.length > 0;

  const seamAnchor = gameplayCaptionAnchor(request, size);
  let subtitleOverrides = seamAnchor
    ? { ...request.subtitleOverrides, anchor: seamAnchor }
    : request.subtitleOverrides;

  // Word-box captions: unless the user picked a colour, the box takes the
  // palette colour that contrasts most with this clip (see accent.ts).
  if (burn && getSubtitleStyle(request.subtitleStyle).wordBox && !subtitleOverrides?.highlight) {
    const accent = await accentForClip(
      ffmpegPath,
      request.inputPath,
      request.startSeconds,
      request.durationSeconds
    );
    subtitleOverrides = { ...subtitleOverrides, highlight: accent.hex };
  }

  // The ass filter's path parsing chokes on Windows drive colons and
  // backslashes. Writing the file into a scratch directory and running ffmpeg
  // with that directory as its cwd lets us reference it by bare filename.
  const workDir = await mkdtemp(path.join(tmpdir(), 'viral-clip-'));
  const assFileName = 'subs.ass';

  try {
    if (burn) {
      const ass = buildAssFile(
        request.subtitles,
        request.subtitleStyle,
        size?.width ?? 1080,
        size?.height ?? 1920,
        request.subtitlePosition,
        request.subtitleAnimation,
        subtitleOverrides
      );
      await writeFile(path.join(workDir, assFileName), ass, 'utf8');
      // Caption fonts that ship with the app (Montserrat for the word-box
      // style), copied next to the subtitles so libass finds them by a bare
      // relative name - the same reason the .ass itself lives here.
      await cp(path.join(projectRoot, 'fonts'), path.join(workDir, 'fonts'), { recursive: true }).catch(
        () => {}
      );
    }

    // ---- Emoji cues -------------------------------------------------------
    //
    // Derived from the captions here rather than sent by the client, because
    // speech cleanup rewrites the word timings before this point. Reading them
    // off the finished captions is what keeps an emoji on its word after a cut.
    const emojiImages = request.emojiImages ?? {};
    const cues = collectEmojiCues(request.subtitles).filter((cue) => emojiImages[cue.emoji]);
    const emojiFiles: string[] = [];
    let emojiPlan = null;

    if (cues.length > 0) {
      const metrics = captionMetrics(
        request.subtitleStyle,
        size?.width ?? 1080,
        size?.height ?? 1920,
        subtitleOverrides
      );

      const outWidth = size?.width ?? 1080;
      // The emoji has to clear the tallest caption it shares the screen with,
      // not just the one it belongs to: a single position is used for the whole
      // clip, so the worst case is the one that matters.
      const captionLines = Math.max(
        ...request.subtitles.map((line) =>
          estimateCaptionLines(line.text, outWidth, metrics.fontSize, Math.round(60 * (outWidth / 1080)))
        )
      );

      emojiPlan = {
        cues,
        layout: planEmojiLayout({
          width: outWidth,
          height: size?.height ?? 1920,
          position: request.subtitlePosition,
          fontSize: metrics.fontSize,
          marginV: metrics.marginV,
          captionLines,
          anchorY: subtitleOverrides?.anchor?.y,
        }),
        // Input 0 is the video, so the PNGs start at 1.
        firstInputIndex: 1,
      };

      for (const [index, cue] of cues.entries()) {
        const file = `emoji${index}.png`;
        await writeFile(
          path.join(workDir, file),
          Buffer.from(emojiImages[cue.emoji].replace(/^data:image\/png;base64,/, ''), 'base64')
        );
        emojiFiles.push(file);
      }
    }

    const built = buildVideoFilter(request, burn, assFileName, emojiPlan);

    // ---- Watermark --------------------------------------------------------
    //
    // Written next to the subtitles and referenced by bare name, for the same
    // Windows-path reason. It is the input right after the emoji PNGs.
    const watermarkPng = request.watermark ? decodeWatermarkPng(request.watermark.image) : null;
    const watermarkFile = watermarkPng ? 'watermark.png' : null;
    if (watermarkFile && watermarkPng) {
      await writeFile(path.join(workDir, watermarkFile), watermarkPng);
    }

    // ---- Loudness ---------------------------------------------------------
    //
    // Measured on the source range. When speech cleanup stitches the clip the
    // pauses it drops are below loudnorm's gate anyway, so the integrated
    // level of the raw range and of the stitched one are practically equal.
    const measured =
      request.normalizeLoudness === false
        ? null
        : await measureLoudness(
            ffmpegPath,
            request.inputPath,
            request.startSeconds,
            request.durationSeconds
          );
    const loudnorm = measured ? buildLoudnormFilter(measured) : null;

    // A stitched track already comes out of the filter graph, so the gain has
    // to be applied inside it; the input's own track takes a plain -af.
    let audioMap = built?.audioMap ?? '0:a:0?';
    let graph = built?.filter;
    let videoMap = built?.videoMap ?? null;

    if (watermarkFile && request.watermark) {
      const frameWidth = size?.width ?? request.sourceWidth ?? 1920;
      const wm = buildWatermarkFilter(
        videoMap ?? '[0:v]',
        1 + emojiFiles.length,
        frameWidth,
        request.watermark
      );
      graph = graph ? `${graph};${wm}` : wm;
      videoMap = '[vwm]';
    }
    if (loudnorm && built?.audioMap) {
      graph = `${graph ?? built.filter};${built.audioMap}${loudnorm}[anorm]`;
      audioMap = '[anorm]';
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',
      // Seeking before -i is the fast path; ffmpeg still decodes accurately
      // because the output is re-encoded.
      '-ss', request.startSeconds.toString(),
      '-t', request.durationSeconds.toString(),
      '-i', request.inputPath,
    ];

    // The PNGs go in after the source, so their indices match the plan above.
    // No -ss or -t in front of them: those apply to the next input only, and
    // seeking a still image would land past its single frame.
    for (const file of emojiFiles) args.push('-i', file);
    if (watermarkFile) args.push('-i', watermarkFile);

    if (graph && videoMap) {
      args.push('-filter_complex', graph, '-map', videoMap);
    } else {
      args.push('-map', '0:v:0');
    }

    // '?' makes the input's own track optional, so a silent source does not
    // abort. A stitched track comes from the filter graph and always exists.
    args.push('-map', audioMap);
    if (loudnorm && audioMap === '0:a:0?') args.push('-af', loudnorm);

    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-ac', '2',
      // Puts the index at the front so the file starts playing before it is
      // fully downloaded - what social platforms expect.
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      '-y',
      request.outputPath
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { cwd: workDir, windowsHide: true });

      let stderr = '';
      const totalMicros = Math.max(1, request.durationSeconds * 1_000_000);

      child.stdout.on('data', (chunk: Buffer) => {
        const match = /out_time_us=(\d+)/g.exec(chunk.toString());
        if (match && request.onProgress) {
          request.onProgress(Math.min(0.99, Number(match[1]) / totalMicros));
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        // Keep only the tail; a failing filtergraph can produce a lot of text.
        stderr = (stderr + chunk.toString()).slice(-4000);
      });

      child.on('error', (err) => reject(new Error(`No se pudo ejecutar FFmpeg: ${err.message}`)));

      child.on('close', (code) => {
        if (code === 0) {
          request.onProgress?.(1);
          resolve();
        } else {
          reject(new Error(`FFmpeg terminó con código ${code}. ${stderr.trim()}`));
        }
      });
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface MediaInfo {
  duration: number | null;
  width: number | null;
  height: number | null;
}

/**
 * Reads duration and frame size.
 *
 * Parsed from ffmpeg's own stderr rather than ffprobe, because the bundled
 * builds in bin/ do not always ship ffprobe alongside ffmpeg.
 */
export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return { duration: null, width: null, height: null };

  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath], { windowsHide: true });
    let output = '';

    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve({ duration: null, width: null, height: null }));
    child.on('close', () => {
      const time = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(output);
      const duration = time
        ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
        : null;

      // The first "NNNxNNN" on a Video: line is the coded frame size.
      const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(output);

      resolve({
        duration,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
      });
    });
  });
}

/** Kept for callers that only need the length. */
export async function probeDuration(inputPath: string): Promise<number | null> {
  return (await probeMedia(inputPath)).duration;
}
