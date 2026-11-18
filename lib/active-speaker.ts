import { spawn } from 'node:child_process';
import { findFfmpeg } from './ffmpeg.js';
import type { SpeakerRegion } from './reframe.js';
import type { Shot } from './shots.js';

/**
 * Works out who to keep in frame, moment by moment.
 *
 * This is the local stand-in for Opus Clip's Fill mode. It measures how much
 * each marked region changes between frames and follows whichever is moving
 * more, which on the footage this is meant for - a fixed camera on two seated
 * people - is the one talking.
 *
 * Be clear about what it is: a **movement** heuristic, not speech detection.
 * On a handheld or busy shot it follows motion rather than voice, so the UI
 * says so and the user can always fall back to Split or a fixed crop.
 *
 * Comparing the two regions against each other, rather than each against a
 * threshold, is what makes it survive camera shake: a wobble lifts both
 * readings together and the difference between them still points at the
 * speaker.
 */

export interface SpeakerTurn {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  /** Index into the marked regions. */
  speaker: number;
}

export interface TurnOptions {
  /** Samples per second taken from the video. */
  fps?: number;
  /** How much louder one side must be before switching, as a ratio. */
  switchRatio?: number;
  /** Shortest time a speaker stays on screen, in seconds. */
  minHold?: number;
}

/**
 * Turns two movement traces into a list of who is on screen when.
 *
 * Pure, so the smoothing rules can be tested without rendering video. Two
 * guards stop the result from flickering: a side has to lead by a clear margin
 * to take over, and once it does it holds for a minimum time.
 */
export function resolveTurns(
  traceA: number[],
  traceB: number[],
  durationSeconds: number,
  options: TurnOptions = {}
): SpeakerTurn[] {
  const fps = options.fps ?? 10;
  const switchRatio = options.switchRatio ?? 1.2;
  const minHold = options.minHold ?? 1.2;

  const samples = Math.min(traceA.length, traceB.length);
  if (samples === 0) return [{ start: 0, end: durationSeconds, speaker: 0 }];

  // Average over a window so a single bright frame cannot steal the shot.
  const window = Math.max(1, Math.round(fps * 0.5));
  const smooth = (trace: number[], index: number) => {
    const from = Math.max(0, index - window);
    const slice = trace.slice(from, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  };

  const turns: SpeakerTurn[] = [];
  let current = 0;
  let currentStart = 0;

  for (let i = 0; i < samples; i++) {
    const time = i / fps;
    const a = smooth(traceA, i);
    const b = smooth(traceB, i);

    const leader = a > b * switchRatio ? 0 : b > a * switchRatio ? 1 : current;

    if (leader !== current && time - currentStart >= minHold) {
      turns.push({ start: currentStart, end: time, speaker: current });
      current = leader;
      currentStart = time;
    }
  }

  turns.push({ start: currentStart, end: durationSeconds, speaker: current });

  // A turn shorter than the hold time can still slip in at the very end.
  return turns.filter((turn) => turn.end > turn.start + 0.05);
}

/**
 * Silences the movement traces where they mean nothing.
 *
 * A camera cut lights up every pixel at once, and on another camera's shot
 * the marked regions hold whoever happens to be there. Neither says anything
 * about who is talking, but both used to be read as "this side moved more" and
 * could hand the frame to the wrong person. Zeroing both sides leaves the
 * current speaker in place, since a switch needs one side to clearly lead.
 */
export function maskTraces(
  traceA: number[],
  traceB: number[],
  fps: number,
  shots: Shot[] | undefined,
  settleSeconds = 0.3
): [number[], number[]] {
  if (!shots || shots.length <= 1) return [traceA, traceB];

  const ignore = (time: number) =>
    shots.some(
      (shot) =>
        time >= shot.start &&
        time < shot.end &&
        (!shot.matchesReference || time < shot.start + settleSeconds)
    );

  const mask = (trace: number[]) => trace.map((value, i) => (ignore(i / fps) ? 0 : value));
  return [mask(traceA), mask(traceB)];
}

/** Reads per-frame luma difference for one cropped region. */
async function traceRegion(
  ffmpegPath: string,
  videoPath: string,
  crop: string,
  startSeconds: number,
  durationSeconds: number,
  fps: number
): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        '-v', 'error',
        '-ss', startSeconds.toString(),
        '-t', durationSeconds.toString(),
        '-i', videoPath,
        '-vf',
        `crop=${crop},fps=${fps},signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-`,
        '-f', 'null',
        '-',
      ],
      { windowsHide: true }
    );

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      resolve([...output.matchAll(/YDIF=([\d.]+)/g)].map((match) => Number(match[1])));
    });
  });
}

/** Turns a normalised region into an ffmpeg crop expression in source pixels. */
function cropExpression(region: SpeakerRegion): string {
  const w = Math.max(0.05, Math.min(1, region.width));
  const h = Math.max(0.05, Math.min(1, region.height));
  const x = Math.max(0, Math.min(1 - w, region.x));
  const y = Math.max(0, Math.min(1 - h, region.y));
  return `iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`;
}

export async function detectSpeakerTurns(
  videoPath: string,
  regions: SpeakerRegion[],
  startSeconds: number,
  durationSeconds: number,
  options: TurnOptions = {},
  shots?: Shot[]
): Promise<SpeakerTurn[]> {
  if (regions.length < 2) {
    return [{ start: 0, end: durationSeconds, speaker: 0 }];
  }

  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return [{ start: 0, end: durationSeconds, speaker: 0 }];

  const fps = options.fps ?? 10;

  // Sequential, not parallel: two ffmpeg passes over the same file compete for
  // the same disk and decoder and end up slower together than one after another.
  const traceA = await traceRegion(
    ffmpegPath,
    videoPath,
    cropExpression(regions[0]),
    startSeconds,
    durationSeconds,
    fps
  );
  const traceB = await traceRegion(
    ffmpegPath,
    videoPath,
    cropExpression(regions[1]),
    startSeconds,
    durationSeconds,
    fps
  );

  const [maskedA, maskedB] = maskTraces(traceA, traceB, fps, shots);
  return resolveTurns(maskedA, maskedB, durationSeconds, { ...options, fps });
}
