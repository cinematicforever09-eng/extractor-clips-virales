import { spawn } from 'node:child_process';

/**
 * Finds the exact rectangle of a streamer's webcam overlay around a click.
 *
 * A click in the picker drops a generic box, which on a stream always takes
 * in a strip of game around the face; in the webcam panel that strip reads as
 * a mistake. The overlay itself is easy to find once several moments are
 * compared: its border stays in the same place while the game behind it
 * changes completely, so its edges survive a per-pixel median over frames
 * spread a minute and a half apart, and the game's do not.
 *
 * One catch, found on a real stream: the streamer's room is static too, so
 * vertical edges inside the webcam (a chair, a shelf) persist just like the
 * border does. Long horizontal lines inside a webcam are rare, though. So the
 * top and bottom borders are found first, and the sides come from how far
 * those horizontal borders run. Measured on a two-hour Rubius stream, at four
 * moments and two different overlay positions: within 4 px of the real box
 * every time.
 *
 * Returns null when nothing convincing is found; the caller keeps the box the
 * user placed.
 */

/** Analysis size: half of 1080p, plenty for straight lines and 4x cheaper. */
export const ANALYSIS_WIDTH = 960;
export const ANALYSIS_HEIGHT = 540;

/** Seconds around the reference moment that the frames are taken from. */
const SAMPLE_OFFSETS = [-40, -25, -12, -5, 0, 5, 12, 25, 40];

/** Gradient (0-255) a persistent edge needs on the median frame. */
const EDGE = 6;

/** Gaps a border line may have and still count as one line, in pixels. */
const MAX_GAP = 6;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * Median over frames of the horizontal and vertical gradients.
 *
 * gx[y][x] is the jump between x and x+1 (vertical edges); gy[y][x] between
 * y and y+1 (horizontal edges). Stored flat, row-major.
 */
export function persistentEdges(
  frames: Uint8Array[],
  width: number,
  height: number
): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const sample = new Array<number>(frames.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < width - 1) {
        for (let f = 0; f < frames.length; f++) sample[f] = Math.abs(frames[f][i + 1] - frames[f][i]);
        gx[i] = median(sample);
      }
      if (y < height - 1) {
        for (let f = 0; f < frames.length; f++) sample[f] = Math.abs(frames[f][i + width] - frames[f][i]);
        gy[i] = median(sample);
      }
    }
  }
  return { gx, gy };
}

/** Longest stretch of `on` through `start`, allowing short gaps. */
function runThrough(on: boolean[], start: number): [number, number] {
  let left = start;
  let miss = 0;
  while (left > 0) {
    miss = on[left - 1] ? 0 : miss + 1;
    if (miss > MAX_GAP) break;
    left--;
  }
  left += miss;

  let right = start;
  miss = 0;
  while (right < on.length - 1) {
    miss = on[right + 1] ? 0 : miss + 1;
    if (miss > MAX_GAP) break;
    right++;
  }
  right -= miss;
  return [left, right];
}

/**
 * The webcam box around (px, py), in analysis pixels, from persistent edges.
 * Pure, so it can be tested on synthetic frames.
 */
export function findBoxInEdges(
  gx: Float32Array,
  gy: Float32Array,
  width: number,
  height: number,
  px: number,
  py: number
): Box | null {
  // How horizontal-edgy each row is near the click.
  const rowScore = new Array<number>(height).fill(0);
  const fromX = Math.max(0, px - 60);
  const toX = Math.min(width, px + 60);
  for (let y = 0; y < height - 1; y++) {
    let sum = 0;
    for (let x = fromX; x < toX; x++) sum += gy[y * width + x];
    rowScore[y] = sum / Math.max(1, toX - fromX);
  }
  const floor = Math.max(12, 6 * median(rowScore));

  /** A row that is a real straight line through the click column. */
  const lineAt = (row: number): [number, number] | null => {
    const on: boolean[] = new Array(width);
    for (let x = 0; x < width; x++) {
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = row + dy;
        if (y >= 0 && y < height - 1) best = Math.max(best, gy[y * width + x]);
      }
      on[x] = best > EDGE;
    }
    if (!on.slice(Math.max(0, px - 3), px + 4).some(Boolean)) return null;
    const [left, right] = runThrough(on, Math.min(width - 1, Math.max(0, px)));
    return right - left >= width * 0.08 ? [left, right] : null;
  };

  const strongestLine = (from: number, to: number): number | null => {
    let best: number | null = null;
    let bestScore = 0;
    for (let y = Math.max(0, from); y < Math.min(height - 1, to); y++) {
      if (rowScore[y] > bestScore && rowScore[y] >= floor && lineAt(y)) {
        best = y;
        bestScore = rowScore[y];
      }
    }
    return best;
  };

  const top = strongestLine(0, py - 4);
  const bottom = strongestLine(py + 4, height - 1);
  const lines = [top, bottom].filter((r): r is number => r !== null).map((r) => lineAt(r)!);

  // No horizontal border at all: nothing trustworthy to build a box from.
  if (lines.length === 0) return null;

  const left = Math.min(...lines.map((l) => l[0]));
  const right = Math.max(...lines.map((l) => l[1]));

  const box: Box = {
    // A line that reaches the frame edge means the webcam sits against it.
    x: left <= 1 ? 0 : left,
    y: top === null ? 0 : top + 1,
    width: (right >= width - 2 ? width : right + 1) - (left <= 1 ? 0 : left),
    height: (bottom === null ? height : bottom + 1) - (top === null ? 0 : top + 1),
  };

  // Sanity: it must contain the click and look like an overlay, not the frame.
  const contains =
    px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
  const area = (box.width * box.height) / (width * height);
  if (!contains || box.width < width * 0.08 || box.height < height * 0.08 || area > 0.6) {
    return null;
  }
  return box;
}

function grabFrame(ffmpegPath: string, inputPath: string, seconds: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        '-v', 'error',
        '-nostdin',
        '-ss', Math.max(0, seconds).toFixed(2),
        '-i', inputPath,
        '-frames:v', '1',
        '-vf', `scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT},format=gray`,
        '-f', 'rawvideo',
        '-',
      ],
      { windowsHide: true }
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const all = Buffer.concat(chunks);
      resolve(all.length === ANALYSIS_WIDTH * ANALYSIS_HEIGHT ? new Uint8Array(all) : null);
    });
  });
}

/**
 * Detects the webcam box around a click, in 0-1 units of the frame.
 *
 * `seconds` is the frame the user clicked on; `duration` keeps the samples
 * inside the video.
 */
export async function detectWebcamBox(
  ffmpegPath: string,
  inputPath: string,
  seconds: number,
  duration: number,
  clickX: number,
  clickY: number
): Promise<Box | null> {
  const times = SAMPLE_OFFSETS.map((offset) =>
    Math.min(Math.max(0, duration - 1), Math.max(0, seconds + offset))
  );
  const frames: Uint8Array[] = [];
  for (const time of times) {
    const frame = await grabFrame(ffmpegPath, inputPath, time);
    if (frame) frames.push(frame);
  }
  // A median needs a few frames that actually differ to beat the game.
  if (frames.length < 5) return null;

  const { gx, gy } = persistentEdges(frames, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const box = findBoxInEdges(
    gx,
    gy,
    ANALYSIS_WIDTH,
    ANALYSIS_HEIGHT,
    Math.round(clickX * ANALYSIS_WIDTH),
    Math.round(clickY * ANALYSIS_HEIGHT)
  );
  if (!box) return null;

  return {
    x: box.x / ANALYSIS_WIDTH,
    y: box.y / ANALYSIS_HEIGHT,
    width: box.width / ANALYSIS_WIDTH,
    height: box.height / ANALYSIS_HEIGHT,
  };
}

// ---------------------------------------------------------------------------
// Finding a webcam without a click
// ---------------------------------------------------------------------------

/**
 * Where to probe for an overlay. Webcams sit along the edges and in the
 * corners of a stream, almost never in the middle, so the probes do too.
 */
const PROBE_X = [0.06, 0.14, 0.24, 0.76, 0.86, 0.94];
const PROBE_Y = [0.08, 0.18, 0.3, 0.7, 0.82, 0.92];

/** Is this rectangle shaped and placed like a facecam? Pure, for tests. */
export function looksLikeWebcam(box: Box, width: number, height: number): boolean {
  const area = (box.width * box.height) / (width * height);
  const aspect = box.width / box.height;
  const centreX = (box.x + box.width / 2) / width;
  // 1.5-20 % of the frame: smaller is a HUD icon, larger is a split screen.
  // Measured: Rubius's facecam is 6.5 %; a panel of a three-way news
  // interview on DW came out at 29 % and 85 % of the height - a person, not
  // an overlay, so height is capped at 60 % too.
  // Aspect 0.7-2.6 covers 4:3, 16:9 and square cams; a lower-third news
  // banner is far wider than that.
  // And off-centre: a box in the middle is the content, not an overlay.
  return (
    area >= 0.015 &&
    area <= 0.2 &&
    box.height / height <= 0.6 &&
    aspect >= 0.7 &&
    aspect <= 2.6 &&
    Math.abs(centreX - 0.5) > 0.2
  );
}

/**
 * Looks for a webcam overlay anywhere in the frame, with no click.
 *
 * The persistent-edge map is built once and probed at points along the
 * edges. Several probes inside the same overlay find the same rectangle,
 * so a box only counts when at least two agree - a single hit is usually a
 * HUD element or a graphic that happened to stay still.
 */
export async function detectWebcamAnywhere(
  ffmpegPath: string,
  inputPath: string,
  seconds: number,
  duration: number
): Promise<Box | null> {
  const times = SAMPLE_OFFSETS.map((offset) =>
    Math.min(Math.max(0, duration - 1), Math.max(0, seconds + offset))
  );
  const frames: Uint8Array[] = [];
  for (const time of times) {
    const frame = await grabFrame(ffmpegPath, inputPath, time);
    if (frame) frames.push(frame);
  }
  if (frames.length < 5) return null;

  const { gx, gy } = persistentEdges(frames, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  return pickWebcam(gx, gy, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
}

/** The probing and voting, separate from FFmpeg so it can be tested. */
export function pickWebcam(
  gx: Float32Array,
  gy: Float32Array,
  width: number,
  height: number
): Box | null {
  const votes: Array<{ box: Box; hits: number }> = [];
  const same = (a: Box, b: Box) =>
    Math.abs(a.x - b.x) <= width * 0.02 &&
    Math.abs(a.y - b.y) <= height * 0.02 &&
    Math.abs(a.width - b.width) <= width * 0.02 &&
    Math.abs(a.height - b.height) <= height * 0.02;

  for (const px of PROBE_X) {
    for (const py of PROBE_Y) {
      const box = findBoxInEdges(gx, gy, width, height, Math.round(px * width), Math.round(py * height));
      if (!box || !looksLikeWebcam(box, width, height)) continue;
      const existing = votes.find((v) => same(v.box, box));
      if (existing) existing.hits++;
      else votes.push({ box, hits: 1 });
    }
  }

  const best = votes.sort((a, b) => b.hits - a.hits)[0];
  if (!best || best.hits < 2) return null;
  return {
    x: best.box.x / width,
    y: best.box.y / height,
    width: best.box.width / width,
    height: best.box.height / height,
  };
}
