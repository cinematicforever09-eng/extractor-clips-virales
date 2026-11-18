import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * yt-dlp integration.
 *
 * This replaces @distube/ytdl-core, which as of this writing fails with
 * "Failed to find any playable formats" on current YouTube - a recurring
 * problem, because YouTube changes its player and every pure-JS extractor has
 * to catch up. yt-dlp is the maintained tool for this and usually ships a fix
 * within days, so a local app is better off shelling out to it than depending
 * on a library that breaks every few months.
 */

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
    const child = spawn(command, ['--version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

let cachedPath: string | null | undefined;

export async function findYtDlp(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;

  const isWindows = process.platform === 'win32';
  const exe = isWindows ? 'yt-dlp.exe' : 'yt-dlp';

  const explicit = process.env.YTDLP_PATH;
  if (explicit && (await isExecutable(explicit))) {
    cachedPath = explicit;
    return cachedPath;
  }

  // Bundled copy keeps the folder self-contained when moved to another PC.
  const bundled = path.join(projectRoot, 'bin', exe);
  if (await isExecutable(bundled)) {
    cachedPath = bundled;
    return cachedPath;
  }

  if (await runsSuccessfully('yt-dlp')) {
    cachedPath = 'yt-dlp';
    return cachedPath;
  }

  if (isWindows) {
    const wingetRoot = path.join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    const { readdir } = await import('node:fs/promises');
    try {
      const packages = await readdir(wingetRoot);
      for (const pkg of packages.filter((n) => n.toLowerCase().includes('yt-dlp'))) {
        const entries = await readdir(path.join(wingetRoot, pkg)).catch(() => []);
        for (const entry of entries) {
          const candidate = path.join(wingetRoot, pkg, entry);
          if (entry.toLowerCase() === exe && (await isExecutable(candidate))) {
            cachedPath = candidate;
            return cachedPath;
          }
          const nested = path.join(candidate, exe);
          if (await isExecutable(nested)) {
            cachedPath = nested;
            return cachedPath;
          }
        }
      }
    } catch {
      // No winget packages directory.
    }
  }

  cachedPath = null;
  return null;
}

export class YtDlpUnavailableError extends Error {
  constructor() {
    super(
      'yt-dlp no está instalado. Para usar enlaces de YouTube, ejecuta: winget install yt-dlp.yt-dlp'
    );
    this.name = 'YtDlpUnavailableError';
  }
}

/**
 * The JavaScript runtime yt-dlp needs for YouTube: the very Node running this
 * server.
 *
 * yt-dlp now solves YouTube's player challenges in JavaScript and only
 * enables Deno by default. With no runtime it warned "No supported JavaScript
 * runtime could be found... some formats may be missing" - on this machine
 * too, Node installed and all, because Node has to be enabled explicitly. On
 * a copied folder with a bundled node.exe it would not even be on PATH.
 * process.execPath is always there and always a working Node.
 */
export const JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`];

function run(args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const binary = await findYtDlp();
    if (!binary) return reject(new YtDlpUnavailableError());

    const child = spawn(binary, [...JS_RUNTIME_ARGS, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('yt-dlp tardó demasiado en responder.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);

      const friendly = explainYtDlpError(stderr);
      reject(
        friendly
          ? new UnsupportedUrlError(friendly)
          : new Error(`yt-dlp falló (código ${code}). ${stderr.trim().slice(0, 300)}`)
      );
    });
  });
}

export interface YtDlpMetadata {
  title?: string;
  uploader?: string;
  uploaderUrl?: string;
  duration?: number;
  description?: string;
  thumbnail?: string;
  /** Which site yt-dlp recognised, e.g. "youtube", "kick", "twitch". */
  extractor?: string;
  /** Site categories, e.g. YouTube's "Gaming" or "News & Politics". */
  categories?: string[];
  /** Uploader-set tags; game names often show up here. */
  tags?: string[];
  /** A stream still in progress has no fixed length and cannot be clipped. */
  isLive: boolean;
  /** Webpage URL as yt-dlp normalised it. */
  webpageUrl?: string;
}

export class LiveStreamError extends Error {
  constructor(site: string) {
    super(
      `Eso es una transmisión en vivo de ${site}. Para sacar clips mientras transmite, usa la pestaña "En directo".`
    );
    this.name = 'LiveStreamError';
  }
}

export class UnsupportedUrlError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnsupportedUrlError';
  }
}

/**
 * Turns yt-dlp's raw stderr into something a person can act on.
 *
 * Left untranslated, a failed paste shows "yt-dlp falló (código 1). ERROR:
 * [kick:live] xqc: The channel is not currently live" - true, but it reads as
 * a crash rather than as "that channel isn't streaming right now".
 */
export function explainYtDlpError(message: string): string | null {
  const cases: Array<[RegExp, string]> = [
    [
      /not currently live|channel is offline/i,
      'Ese canal no está emitiendo ahora mismo. Si quieres cortar una emisión pasada, busca el enlace del VOD o de un clip.',
    ],
    [
      /will begin in|is upcoming|premiere/i,
      'Esa emisión todavía no ha empezado. Vuelve cuando haya terminado y usa el enlace de la grabación.',
    ],
    [
      /Private video|private and cannot|requires authentication|Login required|members-only|only works when logged-in|--cookies/i,
      'Ese video pide iniciar sesión en el sitio, así que no se puede descargar. Descárgalo tú y súbelo como archivo.',
    ],
    [
      /Video unavailable|has been removed|no longer available|does not exist/i,
      'Ese video ya no está disponible en el sitio. Comprueba que el enlace siga funcionando.',
    ],
    [
      /confirm your age|age-restricted|Sign in to confirm/i,
      'El sitio pide iniciar sesión para ver ese video (edad o verificación), así que no se puede descargar. Descárgalo tú y súbelo como archivo.',
    ],
    [
      // YouTube phrases this as "has not made this video available in your
      // country", so matching on "not available" alone misses it.
      /available in your country|geo.?restrict|blocked it in your country/i,
      'Ese video está bloqueado en tu país.',
    ],
    [
      /Unsupported URL|is not a valid URL/i,
      'No reconozco ese enlace. Prueba con YouTube, Kick, Twitch, Vimeo, TikTok o sube el archivo directamente.',
    ],
    [
      /HTTP Error 404|HTTP Error 410|Not Found/i,
      'Ese enlace no existe. Revisa que esté completo y bien copiado.',
    ],
    [
      /HTTP Error 403|Forbidden/i,
      'El sitio rechazó la descarga. Suele pasar con videos restringidos o si has pedido muchos seguidos: espera unos minutos.',
    ],
    [
      /getaddrinfo|Connection reset|timed out|Unable to download webpage/i,
      'No se pudo conectar con el sitio. Revisa tu internet y vuelve a intentarlo.',
    ],
    [
      /Requested format is not available/i,
      'Ese video no ofrece ningún formato descargable compatible.',
    ],
  ];

  for (const [pattern, friendly] of cases) {
    if (pattern.test(message)) return friendly;
  }
  return null;
}

/**
 * Metadata for any URL yt-dlp recognises.
 *
 * Not YouTube-specific on purpose: yt-dlp ships over 1700 extractors, so the
 * same code path serves Kick, Twitch, Vimeo, TikTok and the rest. Restricting
 * this to YouTube was a limitation of this app, never of the tool.
 */
export async function fetchMetadata(url: string): Promise<YtDlpMetadata> {
  let raw: string;
  try {
    raw = await run(['-J', '--no-warnings', '--no-playlist', url]);
  } catch (error) {
    throw error;
  }

  const data = JSON.parse(raw) as Record<string, unknown>;

  // yt-dlp marks an in-progress broadcast with is_live, and sometimes only
  // with live_status; a finished one reports "was_live" or "not_live".
  const isLive =
    data.is_live === true ||
    data.live_status === 'is_live' ||
    data.live_status === 'is_upcoming';

  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    uploader: typeof data.uploader === 'string' ? data.uploader : undefined,
    uploaderUrl: typeof data.uploader_url === 'string' ? data.uploader_url : undefined,
    duration: typeof data.duration === 'number' ? data.duration : undefined,
    description:
      typeof data.description === 'string' ? data.description.slice(0, 800) : undefined,
    thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : undefined,
    extractor: typeof data.extractor_key === 'string' ? data.extractor_key : undefined,
    webpageUrl: typeof data.webpage_url === 'string' ? data.webpage_url : undefined,
    categories: Array.isArray(data.categories)
      ? data.categories.filter((c): c is string => typeof c === 'string')
      : undefined,
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : undefined,
    isLive,
  };
}

/**
 * Downloads any supported URL and merges it into a single local MP4.
 *
 * Streaming a YouTube URL straight into a <video> tag or into FFmpeg does not
 * work any more: YouTube has essentially stopped publishing progressive
 * (audio+video in one file) formats. Listing formats for a typical video now
 * returns only "video only" and "audio only" DASH streams, so there is no
 * single URL to hand to anything. yt-dlp downloads both and muxes them with
 * FFmpeg, which also makes preview scrubbing instant and lets every later step
 * treat a YouTube video exactly like an uploaded file.
 */
export async function downloadVideo(
  url: string,
  destDir: string,
  ffmpegPath: string | null,
  onProgress?: (fraction: number) => void,
  fileStem?: string
): Promise<string> {
  const binary = await findYtDlp();
  if (!binary) throw new YtDlpUnavailableError();

  // A stem derived from the URL keeps names predictable without assuming the
  // site uses YouTube-shaped ids.
  const stem = fileStem || `src_${Date.now().toString(36)}`;
  const outputTemplate = path.join(destDir, `${stem}.%(ext)s`);

  const args = [
    ...JS_RUNTIME_ARGS,
    // Cap at 1080p: anything more is wasted on a vertical clip and slows the
    // download for no visible gain.
    '-f',
    'bv*[height<=1080]+ba/b[height<=1080]/b',
    // Sorting matters more than the format string here. Asking only for "best
    // mp4 at 1080p" picks YouTube's Premium HLS rendition, which for a short
    // trailer was 90 MB fetched as hundreds of fragments where the plain https
    // h264 stream is 25 MB in one request. proto:https avoids HLS, and h264
    // both re-encodes fastest in FFmpeg and plays everywhere.
    '-S',
    'proto:https,vcodec:h264,res,br',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '-o',
    outputTemplate,
  ];

  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    // Point yt-dlp at the same binary the app found, so merging works even when
    // ffmpeg is not on PATH.
    args.push('--ffmpeg-location', ffmpegPath);
  }

  args.push(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stderr = '';

    // yt-dlp fetches video and audio as two separate files, each reporting its
    // own 0-100%. Reported raw, the bar runs to 87% and then drops back to 19%.
    // The video stream is by far the larger of the two, so it gets most of the
    // range and the audio pass fills in the tail.
    let filesSeen = 0;
    const VIDEO_SHARE = 0.85;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();

      const destinations = text.match(/\[download\] Destination:/g);
      if (destinations) filesSeen += destinations.length;

      // Lines look like: [download]  42.3% of 12.34MiB at 1.20MiB/s ETA 00:05
      const match = /\[download\]\s+([\d.]+)%/.exec(text);
      if (match && onProgress) {
        const fraction = Number(match[1]) / 100;
        const overall =
          filesSeen <= 1 ? fraction * VIDEO_SHARE : VIDEO_SHARE + fraction * (1 - VIDEO_SHARE);
        onProgress(Math.min(0.99, overall));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.on('error', (err) => reject(new Error(`No se pudo ejecutar yt-dlp: ${err.message}`)));

    child.on('close', (code) => {
      if (code === 0) return resolve();

      const friendly = explainYtDlpError(stderr);
      reject(
        friendly
          ? new UnsupportedUrlError(friendly)
          : new Error(`yt-dlp falló al descargar. ${stderr.trim().slice(0, 300)}`)
      );
    });
  });

  // The extension depends on what was merged, so find what actually landed.
  const produced = (await readdir(destDir)).find((name) => name.startsWith(`${stem}.`));
  if (!produced) throw new Error('yt-dlp terminó pero no se encontró el archivo descargado.');

  onProgress?.(1);
  return path.join(destDir, produced);
}

/**
 * Direct stream addresses for a live broadcast, for FFmpeg to record.
 *
 * YouTube serves a live stream as separate video and audio HLS playlists
 * (checked on a 24/7 channel: only "video only" and "audio only" formats), so
 * this can return two URLs; Twitch and Kick usually return one muxed URL. The
 * addresses expire after some hours, which is why the recorder calls this
 * again whenever FFmpeg drops out while the stream is still on.
 */
export async function getLiveStreamUrls(url: string): Promise<string[]> {
  const out = await run([
    '-g',
    '-f',
    'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--no-playlist',
    '--no-warnings',
    url,
  ]);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line));
}
