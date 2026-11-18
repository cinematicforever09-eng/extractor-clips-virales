import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Remembers which stretches of each video have already been handed out.
 *
 * The user builds a page made only of clips, and sends the same long video
 * more than once to get more of them. With the judging made deterministic
 * every upload returned the same ten clips; with it left random, the quality
 * of each set was a coin toss. Remembering what was delivered gives both:
 * every run still ranks the whole video the same careful way, and simply
 * skips what this user already has, so the next upload brings the next best
 * moments instead of the same ones or worse ones.
 *
 * Stored as JSON inside the project folder, not in the temp directory, so it
 * survives a restart - losing it would quietly start repeating clips.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_FILE = path.join(projectRoot, 'data', 'clip-history.json');

export interface DeliveredWindow {
  start: number;
  end: number;
  /** When it was handed out, for the user's own reference. */
  at: string;
  title?: string;
}

type History = Record<string, DeliveredWindow[]>;

async function load(): Promise<History> {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, 'utf8')) as History;
  } catch {
    // Missing or unreadable: start empty rather than refuse to analyse.
    return {};
  }
}

async function save(history: History): Promise<void> {
  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 1), 'utf8');
}

/**
 * A stable name for a video, so two uploads of it match.
 *
 * For YouTube only the video id counts: the user's own link carried
 * `&t=678s`, and a timestamp or playlist parameter must not make the same
 * video look new. Anything else is keyed on its address or file name plus
 * its rounded duration, which keeps two different files that happen to share
 * a name apart.
 */
export function historyKey(source: string, duration: number): string {
  const youtube =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(source);
  if (youtube) return `youtube:${youtube[1]}`;

  const clean = source.split('#')[0].trim().toLowerCase();
  return `${clean}|${Math.round(duration)}`;
}

export async function getDelivered(key: string): Promise<DeliveredWindow[]> {
  return (await load())[key] ?? [];
}

export async function recordDelivered(
  key: string,
  windows: Array<{ start: number; end: number; title?: string }>
): Promise<void> {
  if (windows.length === 0) return;
  const history = await load();
  const at = new Date().toISOString();
  history[key] = [...(history[key] ?? []), ...windows.map((w) => ({ ...w, at }))];
  await save(history);
}

export async function clearDelivered(key: string): Promise<number> {
  const history = await load();
  const removed = history[key]?.length ?? 0;
  delete history[key];
  await save(history);
  return removed;
}

/**
 * Whether a candidate repeats something already delivered.
 *
 * Overlap is measured against the shorter of the two, so a refined clip that
 * grew a few seconds still matches the window it came from. A third is
 * enough: two clips sharing that much of their running time are the same
 * clip to anyone scrolling past them.
 */
export function overlapsDelivered(
  window: { start: number; end: number },
  delivered: DeliveredWindow[]
): boolean {
  return delivered.some((d) => {
    const overlap = Math.min(d.end, window.end) - Math.max(d.start, window.start);
    const shorter = Math.min(d.end - d.start, window.end - window.start);
    return shorter > 0 && overlap > shorter / 3;
  });
}
