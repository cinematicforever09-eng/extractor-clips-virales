import { spawn } from 'node:child_process';

/**
 * Brings every exported clip to the same loudness.
 *
 * Clips cut from different parts of a long video come out at different
 * volumes - a quiet guest, a shouting audience - and on a feed that reads as
 * one clip being broken. -14 LUFS integrated is what TikTok, Reels and Shorts
 * normalise to anyway, so hitting it here means the platform leaves the audio
 * alone. Idea taken from AutoClip, which does the same on every export.
 *
 * Two passes, the way EBU R128 recommends: one measures the clip, the second
 * applies a single linear gain computed from that measurement. A one-pass
 * loudnorm guesses as it goes and pumps the volume up and down mid-sentence,
 * which on speech sounds like a bad compressor. The measuring pass decodes
 * audio only, so it costs well under a second on a one-minute clip.
 */

export const TARGET_LUFS = -14;
export const TRUE_PEAK = -1.5;
export const LOUDNESS_RANGE = 11;

export interface LoudnessMeasurement {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

/** Reads the JSON block loudnorm prints at the end of a measuring pass. */
export function parseLoudnormOutput(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const measured = {
      inputI: Number(json.input_i),
      inputTp: Number(json.input_tp),
      inputLra: Number(json.input_lra),
      inputThresh: Number(json.input_thresh),
      targetOffset: Number(json.target_offset),
    };
    // A silent clip measures as -inf, which is not a number loudnorm will take
    // back as input. Better to leave such a clip untouched than fail the export.
    return Object.values(measured).every(Number.isFinite) ? measured : null;
  } catch {
    return null;
  }
}

/**
 * The loudnorm filter for the second pass: one linear gain for the whole clip.
 *
 * Only ever built from a real measurement. A clip that could not be measured
 * (no audio track, or pure silence) is exported untouched instead.
 */
export function buildLoudnormFilter(measured: LoudnessMeasurement): string {
  return (
    `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LOUDNESS_RANGE}` +
    `:measured_I=${measured.inputI}` +
    `:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}` +
    `:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}` +
    `:linear=true`
  );
}

/** First pass: measures the clip's audio. Null when it has none or it fails. */
export function measureLoudness(
  ffmpegPath: string,
  inputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<LoudnessMeasurement | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-nostats',
        '-ss', startSeconds.toString(),
        '-t', durationSeconds.toString(),
        '-i', inputPath,
        '-vn',
        '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LOUDNESS_RANGE}:print_format=json`,
        '-f', 'null',
        '-',
      ],
      { windowsHide: true }
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? parseLoudnormOutput(stderr) : null));
  });
}
