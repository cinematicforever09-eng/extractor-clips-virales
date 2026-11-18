import { YoutubeTranscript } from 'youtube-transcript';
import type { TranscriptChunk } from './subtitles.js';
import {
  fetchMetadata,
  findYtDlp,
  LiveStreamError,
  UnsupportedUrlError,
  type YtDlpMetadata,
} from './ytdlp.js';

/**
 * Any video the app can ingest from a link.
 *
 * This used to be YouTube-only, which was a limitation of this app rather than
 * of the tooling underneath: yt-dlp ships over 1700 extractors. Pasting a Kick
 * link used to fail with "URL de YouTube no válida" even though yt-dlp handles
 * kick:vod, kick:clips and kick:live perfectly well.
 */

const YOUTUBE_ID = /^[a-zA-Z0-9_-]{11}$/;

/** Sites worth naming in the UI, because people actually paste them. */
export const POPULAR_SITES = ['YouTube', 'Kick', 'Twitch', 'Vimeo', 'TikTok', 'Instagram'];

export interface SourceInfo {
  url: string;
  title: string;
  author: string;
  authorUrl: string;
  thumbnailUrl: string;
  duration: number;
  description: string;
  /** Which extractor matched, for messages and for caption lookup. */
  site: string;
  hasTranscript: boolean;
  transcript: TranscriptChunk[];
}

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (YOUTUBE_ID.test(trimmed)) return true;
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\S*$/i.test(trimmed);
}

/** Tidies what a person pastes: quotes, angle brackets, a bare video id. */
export function normalizeUrl(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();

  if (YOUTUBE_ID.test(cleaned)) return `https://www.youtube.com/watch?v=${cleaned}`;
  if (!/^https?:\/\//i.test(cleaned)) return `https://${cleaned}`;
  return cleaned;
}

/** Extracts a YouTube id, used only to look up captions. */
export function youtubeIdFrom(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(parsed.hostname)) {
      return null;
    }

    const vParam = parsed.searchParams.get('v');
    if (vParam && YOUTUBE_ID.test(vParam)) return vParam;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname.includes('youtu.be') && segments[0] && YOUTUBE_ID.test(segments[0])) {
      return segments[0];
    }

    for (let i = 0; i < segments.length; i++) {
      if (['shorts', 'live', 'embed', 'v', 'e'].includes(segments[i].toLowerCase())) {
        const candidate = segments[i + 1];
        if (candidate && YOUTUBE_ID.test(candidate)) return candidate;
      }
    }
  } catch {
    /* not a URL we can parse */
  }
  return null;
}

/** Captions published alongside a YouTube video, when there are any. */
async function fetchYouTubeCaptions(videoId: string): Promise<TranscriptChunk[]> {
  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId);
    if (!Array.isArray(raw) || raw.length === 0) return [];

    return raw.map((entry: { text?: string; offset: number; duration: number }) => ({
      // The library has reported offsets in both seconds and milliseconds
      // across versions, so normalise on magnitude.
      text:
        entry.text
          ?.replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim() || '',
      start: Math.round((entry.offset > 100 ? entry.offset / 1000 : entry.offset) * 10) / 10,
      duration:
        Math.round((entry.duration > 100 ? entry.duration / 1000 : entry.duration) * 10) / 10,
    }));
  } catch (err) {
    console.warn('[media] captions:', err instanceof Error ? err.message : err);
    return [];
  }
}

function friendlySite(metadata: YtDlpMetadata): string {
  const raw = metadata.extractor || '';
  if (/youtube/i.test(raw)) return 'YouTube';
  if (/kick/i.test(raw)) return 'Kick';
  if (/twitch/i.test(raw)) return 'Twitch';
  if (/vimeo/i.test(raw)) return 'Vimeo';
  if (/tiktok/i.test(raw)) return 'TikTok';
  if (/instagram/i.test(raw)) return 'Instagram';
  return raw || 'ese sitio';
}

export async function fetchSourceInfo(rawInput: string): Promise<SourceInfo> {
  const url = normalizeUrl(rawInput);
  const metadata = await fetchMetadata(url);
  const site = friendlySite(metadata);

  // Clipping needs a finished recording with a known length.
  if (metadata.isLive) throw new LiveStreamError(site);

  const youtubeId = youtubeIdFrom(metadata.webpageUrl || url);
  const transcript = youtubeId ? await fetchYouTubeCaptions(youtubeId) : [];

  let duration = metadata.duration ?? 0;
  if (duration <= 0 && transcript.length > 0) {
    const last = transcript[transcript.length - 1];
    duration = Math.ceil(last.start + last.duration);
  }

  if (duration <= 0) {
    throw new UnsupportedUrlError(
      `No pude averiguar cuánto dura ese video de ${site}. Si es una transmisión o una lista de reproducción, usa el enlace de un video concreto.`
    );
  }

  return {
    url: metadata.webpageUrl || url,
    title: metadata.title || 'Video',
    author: metadata.uploader || site,
    authorUrl: metadata.uploaderUrl || '',
    thumbnailUrl: metadata.thumbnail || '',
    duration,
    description: metadata.description || '',
    site,
    hasTranscript: transcript.length > 0,
    transcript,
  };
}

/** Whether links can be ingested at all on this machine. */
export async function isLinkIngestSupported(): Promise<boolean> {
  return (await findYtDlp()) !== null;
}
