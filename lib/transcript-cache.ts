import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WhisperResult } from './whisper.js';

/**
 * Keeps each video's Whisper transcript on disk so it is only made once.
 *
 * The user sends the same long video again and again to get the next ten
 * clips (see clip-history.ts), and every one of those runs used to transcribe
 * the whole hour from scratch. The words do not change between runs - only
 * which windows have already been delivered does - so the transcript is the
 * obvious thing to keep. Idea taken from AutoClip, which writes every stage
 * of its pipeline to disk and resumes from the first one missing.
 *
 * Keyed on the same stable name the clip history uses (a YouTube id, or the
 * file name plus its duration), plus the language that was asked for and the
 * Whisper model: forcing a language, or swapping the model, must transcribe
 * again rather than hand back the old words.
 *
 * Lives inside the project folder like the clip history, so it survives a
 * restart. It is not part of the portable bundle (data/ is left out).
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(projectRoot, 'data', 'transcripts');

/** Bumped when the stored shape or the transcription settings change meaning. */
const CACHE_VERSION = 1;

interface CachedTranscript extends WhisperResult {
  version: number;
  key: string;
  createdAt: string;
}

export interface TranscriptCacheKey {
  /** From historyKey(): stable across downloads of the same video. */
  source: string;
  /** What the caller asked for - 'auto' or an ISO code - not what was detected. */
  language: string;
  /** Model file name, so a different model never reuses old words. */
  model: string;
}

/** The parts joined into one string, exposed so it can be tested. */
export function cacheKeyString(key: TranscriptCacheKey): string {
  return [key.source, key.language || 'auto', key.model].join('|');
}

function fileFor(key: TranscriptCacheKey): string {
  const hash = createHash('sha1').update(cacheKeyString(key)).digest('hex').slice(0, 20);
  return path.join(CACHE_DIR, `${hash}.json`);
}

export async function loadTranscript(key: TranscriptCacheKey): Promise<WhisperResult | null> {
  try {
    const stored = JSON.parse(await readFile(fileFor(key), 'utf8')) as CachedTranscript;
    // A hash collision or an older format reads as a miss, never as the
    // wrong video's words.
    if (stored.version !== CACHE_VERSION || stored.key !== cacheKeyString(key)) return null;
    if (!Array.isArray(stored.words) || stored.words.length === 0) return null;
    return { language: stored.language, words: stored.words };
  } catch {
    return null;
  }
}

export async function saveTranscript(key: TranscriptCacheKey, result: WhisperResult): Promise<void> {
  // An empty transcript is not worth remembering: it usually means the run
  // failed in a way worth retrying, not that the video has no speech.
  if (result.words.length === 0) return;
  await mkdir(CACHE_DIR, { recursive: true });
  const stored: CachedTranscript = {
    version: CACHE_VERSION,
    key: cacheKeyString(key),
    createdAt: new Date().toISOString(),
    language: result.language,
    words: result.words,
  };
  await writeFile(fileFor(key), JSON.stringify(stored), 'utf8');
}

