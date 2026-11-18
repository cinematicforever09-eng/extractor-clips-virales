import { spawn } from 'node:child_process';

/**
 * Finds the camera cuts inside a clip, and which shots come from the camera
 * the user marked their regions on.
 *
 * Why this exists: focus, split and auto-fill crop a region the user marked
 * on one reference frame. That is right by construction on a fixed camera,
 * and wrong after every cut on anything edited - a TV show or a three-camera
 * podcast cuts to the guest, to the audience, to a wide shot, and the same
 * pixel region then holds a wall or half a face. Measured on a 50 s clip of a
 * Colombian late-night show: 14 shots, 7 of them from other cameras.
 *
 * So the clip is split into shots (FFmpeg's scdet, no new dependencies) and
 * each shot is compared with the frame the regions were marked on. Shots from
 * the same camera keep the marked framing; the rest are shown whole over a
 * blurred copy, which never cuts anyone off. Idea taken from AutoClip, whose
 * crop paths never carry across a cut.
 *
 * Deliberately not face detection: a wrong guess here only costs a shot shown
 * wide instead of tight, never a crop on the wrong person.
 */

export interface Shot {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  /** Same camera set-up as the frame the regions were marked on. */
  matchesReference: boolean;
}

export interface TimeRange {
  start: number;
  end: number;
}

/** scdet score (0-100) above which a frame starts a new shot. FFmpeg's default. */
export const CUT_THRESHOLD = 10;

/** A "shot" shorter than this is a flash or a dissolve, not a camera change. */
export const MIN_SHOT_SECONDS = 0.4;

/**
 * Mean difference (0-255) between two tiny greyscale thumbnails above which
 * they are different cameras.
 *
 * Measured on the same show: frames from the marked camera at other moments
 * scored 11-18 (people move, hands gesture), frames from any other camera
 * 38-59. 26 sits in the empty gap between the two groups.
 */
export const SAME_CAMERA_MAX_DISTANCE = 26;

/**
 * The same test on just the webcam box of a stream ('Streamer + juego').
 *
 * The whole frame is useless there: the game changes every pixel all the
 * time. The webcam box is what stays put, so that is what is compared.
 * Measured on a two-hour Rubius stream against the median reference below:
 * the box with him in it scored 7-40 (he leans in, the lighting shifts); the
 * same box after he moved the webcam, or hid it for a cutscene, 46-65.
 * 43 sits in the gap.
 */
export const SAME_WEBCAM_MAX_DISTANCE = 43;

/** Restricts the comparison to one part of the frame, in 0-1 units. */
export interface CompareRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectShotsOptions {
  /** Only this part of the frame is cut-detected and compared. */
  region?: CompareRegion;
  /** Distance above which a shot counts as another camera / layout. */
  maxDistance?: number;
}

/** FFmpeg crop for a normalised region, clamped to the frame. */
export function regionCrop(region: CompareRegion): string {
  const w = Math.max(0.05, Math.min(1, region.width));
  const h = Math.max(0.05, Math.min(1, region.height));
  const x = Math.max(0, Math.min(1 - w, region.x));
  const y = Math.max(0, Math.min(1 - h, region.y));
  return `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`;
}

/** Thumbnail size used for the comparison. Small on purpose: layout, not detail. */
export const SIGNATURE_WIDTH = 32;
export const SIGNATURE_HEIGHT = 18;

/** Cut times from scdet's metadata=print output. */
export function parseSceneCuts(output: string): number[] {
  return [...output.matchAll(/pts_time:([\d.]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

/**
 * Turns cut times into contiguous shots covering the whole clip.
 *
 * A cut that would leave a shot shorter than the minimum is dropped, so the
 * short piece joins the shot before it: a dissolve fires scdet on several
 * consecutive frames, and each of those is not a shot of its own.
 */
export function cutsToShots(
  cuts: number[],
  durationSeconds: number,
  minShot = MIN_SHOT_SECONDS
): TimeRange[] {
  const shots: TimeRange[] = [];
  let start = 0;

  for (const cut of cuts) {
    if (cut <= start + minShot || cut >= durationSeconds - minShot) continue;
    shots.push({ start, end: cut });
    start = cut;
  }
  shots.push({ start, end: durationSeconds });
  return shots;
}

/**
 * How different two thumbnails are, ignoring overall brightness.
 *
 * Each is compared around its own mean, so a light flash or an exposure change
 * on the same camera does not read as a cut to another one.
 */
export function frameDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return Infinity;

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < length; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= length;
  meanB /= length;

  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(a[i] - meanA - (b[i] - meanB));
  return total / length;
}

/**
 * Per-pixel median of several thumbnails: what a region usually looks like.
 *
 * Used as the reference for a stream's webcam box. A single frame is a
 * gamble there - found on a real stream, the moment the user marked fell in
 * a cutscene with the webcam hidden, so every shot WITH the webcam was judged
 * "another camera" and the clip came out the wrong way round. The webcam is
 * on screen most of the time, so the median over a minute and a half shows
 * it even when the marked instant does not.
 */
export function medianSignature(signatures: ArrayLike<number>[]): Uint8Array {
  const usable = signatures.filter((s) => s.length > 0);
  const length = Math.min(...usable.map((s) => s.length));
  const result = new Uint8Array(Number.isFinite(length) ? length : 0);
  const column = new Array<number>(usable.length);
  for (let i = 0; i < result.length; i++) {
    for (let f = 0; f < usable.length; f++) column[f] = usable[f][i];
    column.sort((a, b) => a - b);
    result[i] = column[column.length >> 1];
  }
  return result;
}

/** Seconds around the marked moment sampled for a webcam reference. */
const REFERENCE_OFFSETS = [-40, -25, -12, -5, 0, 5, 12, 25, 40];

/** Where a shot is sampled: its middle, away from any dissolve at its edges. */
export function shotSampleTime(shot: TimeRange): number {
  return (shot.start + shot.end) / 2;
}

/** The ranges of a clip that should be shown whole rather than cropped. */
export function fallbackRanges(shots: Shot[]): TimeRange[] {
  return shots
    .filter((shot) => !shot.matchesReference)
    .map(({ start, end }) => ({ start, end }));
}

/**
 * Moves ranges on the clip's own timeline onto the timeline left after speech
 * cleanup has cut pauses out of it.
 *
 * Without this, a shot boundary would land a few seconds late by the end of a
 * clip that lost its pauses, and the wide fallback would start mid-shot.
 */
export function remapToKept(ranges: TimeRange[], keep: TimeRange[] | undefined): TimeRange[] {
  if (!keep || keep.length === 0) return ranges;

  const result: TimeRange[] = [];
  for (const range of ranges) {
    let offset = 0;
    for (const segment of keep) {
      const from = Math.max(range.start, segment.start);
      const to = Math.min(range.end, segment.end);
      if (to > from) {
        result.push({
          start: offset + (from - segment.start),
          end: offset + (to - segment.start),
        });
      }
      offset += segment.end - segment.start;
    }
  }

  // Neighbouring pieces of the same range are one range on the new timeline.
  return result.reduce<TimeRange[]>((merged, range) => {
    const last = merged[merged.length - 1];
    if (last && range.start - last.end < 0.01) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

// ---------------------------------------------------------------------------
// FFmpeg passes
// ---------------------------------------------------------------------------

function run(ffmpegPath: string, args: string[], wantStdout: 'text'): Promise<string>;
function run(ffmpegPath: string, args: string[], wantStdout: 'binary'): Promise<Buffer>;
function run(ffmpegPath: string, args: string[], wantStdout: 'text' | 'binary') {
  return new Promise<string | Buffer>((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    const finish = () => {
      const all = Buffer.concat(chunks);
      resolve(wantStdout === 'text' ? all.toString() : all);
    };
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function findCuts(
  ffmpegPath: string,
  inputPath: string,
  startSeconds: number,
  durationSeconds: number,
  region?: CompareRegion
): Promise<number[]> {
  // Scaled down first: scdet compares whole frames, and a 320-pixel frame
  // finds the same cuts as a 1080p one in a fraction of the time (1.6 s for
  // 50 s of 1080p on this machine).
  const output = await run(
    ffmpegPath,
    [
      '-v', 'error',
      '-nostdin',
      '-ss', startSeconds.toString(),
      '-t', durationSeconds.toString(),
      '-i', inputPath,
      '-an',
      '-vf',
      `${region ? `${regionCrop(region)},` : ''}scale=320:-2,scdet=threshold=${CUT_THRESHOLD},` +
        'metadata=select:key=lavfi.scd.time,metadata=print:file=-',
      '-f', 'null',
      '-',
    ],
    'text'
  );
  return parseSceneCuts(output);
}

async function signatureAt(
  ffmpegPath: string,
  inputPath: string,
  seconds: number,
  region?: CompareRegion
): Promise<Buffer> {
  return run(
    ffmpegPath,
    [
      '-v', 'error',
      '-nostdin',
      '-ss', Math.max(0, seconds).toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf',
      `${region ? `${regionCrop(region)},` : ''}` +
        `scale=${SIGNATURE_WIDTH}:${SIGNATURE_HEIGHT}:flags=area,format=gray`,
      '-f', 'rawvideo',
      '-',
    ],
    'binary'
  );
}

/**
 * Splits a clip into shots and flags which ones share the reference camera.
 *
 * `referenceSeconds` is the moment of the source the regions were marked on.
 * Without one (regions marked before this existed) the longest shot stands in
 * for it: in an edited conversation the main camera is the one on screen most.
 *
 * Never throws. If anything fails the whole clip comes back as one matching
 * shot, which is exactly how exports behaved before shots existed.
 */
export async function detectShots(
  ffmpegPath: string,
  inputPath: string,
  startSeconds: number,
  durationSeconds: number,
  referenceSeconds?: number | null,
  options: DetectShotsOptions = {}
): Promise<Shot[]> {
  const whole: Shot[] = [{ start: 0, end: durationSeconds, matchesReference: true }];
  const { region } = options;
  const maxDistance = options.maxDistance ?? SAME_CAMERA_MAX_DISTANCE;

  try {
    const ranges = cutsToShots(
      await findCuts(ffmpegPath, inputPath, startSeconds, durationSeconds, region),
      durationSeconds
    );
    // With a whole-frame comparison one shot means one camera, nothing to
    // check. A webcam box can be in the wrong place for the entire clip, so
    // that one is checked even when nothing cut.
    if (ranges.length <= 1 && !region) return whole;

    const referenceTime =
      typeof referenceSeconds === 'number' && Number.isFinite(referenceSeconds)
        ? referenceSeconds
        : startSeconds +
          shotSampleTime(ranges.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a)));

    let reference: Uint8Array | Buffer;
    if (region) {
      const samples: Buffer[] = [];
      for (const offset of REFERENCE_OFFSETS) {
        samples.push(await signatureAt(ffmpegPath, inputPath, Math.max(0, referenceTime + offset), region));
      }
      reference = medianSignature(samples.filter((s) => s.length >= SIGNATURE_WIDTH * SIGNATURE_HEIGHT));
    } else {
      reference = await signatureAt(ffmpegPath, inputPath, referenceTime);
    }
    if (reference.length < SIGNATURE_WIDTH * SIGNATURE_HEIGHT) return whole;

    const shots: Shot[] = [];
    for (const range of ranges) {
      const signature = await signatureAt(
        ffmpegPath,
        inputPath,
        startSeconds + shotSampleTime(range),
        region
      );
      const distance = frameDistance(signature, reference);
      shots.push({ ...range, matchesReference: distance <= maxDistance });
    }

    const other = shots.filter((shot) => !shot.matchesReference).length;
    console.log(
      `[shots] ${region ? '(zona de cámara) ' : ''}${shots.length} tomas, ${other} de otra cámara: ` +
        shots
          .map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}${s.matchesReference ? '' : '*'}`)
          .join(' ')
    );
    return shots;
  } catch (error) {
    console.warn('[shots] no se pudieron detectar las tomas:', error);
    return whole;
  }
}
