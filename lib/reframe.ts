/**
 * Builds the FFmpeg filter that turns a wide source into a vertical clip.
 *
 * Two framings here go beyond the original blur-fill:
 *
 *   focus - one speaker, cropped full-bleed so they fill the phone screen
 *   split - two speakers stacked, each cropped from their own part of the
 *           frame, for the case where both are talking in the same shot
 *
 * Speaker regions are marked by hand in the UI rather than detected. That is a
 * deliberate choice: a wrong automatic crop silently ruins every clip in a
 * batch, while a marked region is right by construction.
 */

export type FramingMode =
  | 'blur-fill'
  | 'zoom-crop'
  | 'fit'
  | 'focus'
  | 'split'
  | 'auto-fill'
  | 'gameplay';

/**
 * How much of the vertical frame the gameplay takes in 'gameplay' mode.
 *
 * The game gets the larger share because it is where the action is, but the
 * face still needs enough height to read as a reaction rather than a strip -
 * that is what makes a gaming clip work. 62/38 is the proportion the format
 * settled on.
 */
const GAMEPLAY_SHARE = 0.62;

/** A region of the source frame, normalised 0-1 so it survives any resolution. */
export interface SpeakerRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Second of the source the region was marked on. Lets the export tell the
   * shots from that camera apart from the rest (see shots.ts).
   */
  markedAt?: number;
}

/** Who is on screen when, from the active-speaker pass. */
export interface SpeakerTurnInput {
  start: number;
  end: number;
  speaker: number;
}

export interface ReframeInput {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  mode: FramingMode;
  speakers?: SpeakerRegion[];
  /**
   * Stream the graph reads from. Defaults to the raw input, but when speech
   * cleanup runs first the reframing has to consume its stitched output.
   */
  inputLabel?: string;
  /** Required by 'auto-fill': the crop follows these over time. */
  turns?: SpeakerTurnInput[];
  /**
   * Stretches of the output (seconds) that come from another camera than the
   * one the regions were marked on. They are shown whole over a blurred copy
   * instead of cropped. Only used by the modes that crop a marked region.
   */
  fallbackRanges?: Array<{ start: number; end: number }>;
  /** 'gameplay' only: where the webcam panel goes and how much height it takes. */
  gameplayLayout?: GameplayLayout;
}

export interface GameplayLayout {
  camPosition: 'top' | 'bottom';
  /** Fraction of the output height the webcam takes, 0.25-0.5. */
  camShare: number;
  /**
   * Size the webcam panel to the webcam's own shape instead of camShare, so
   * the whole webcam fills it exactly: no game around it, nothing cut off.
   */
  fitCam?: boolean;
}

/**
 * The layout the mode always had: game on top, webcam below at 38 %.
 *
 * Streamer clips on TikTok just as often put the face on top, and how big it
 * should be depends on how much is happening in the game, so both are now a
 * choice - with this as the default so nothing changes for existing exports.
 */
export const DEFAULT_GAMEPLAY_LAYOUT: GameplayLayout = {
  camPosition: 'bottom',
  camShare: 1 - GAMEPLAY_SHARE,
  fitCam: true,
};

/** Keeps a layout coming from the client inside what still looks right. */
export function normaliseGameplayLayout(value: unknown): GameplayLayout {
  const raw = (value ?? {}) as Partial<GameplayLayout>;
  const share = Number(raw.camShare);
  return {
    camPosition: raw.camPosition === 'top' ? 'top' : 'bottom',
    // Below a quarter the face stops reading as a reaction; above half the
    // game becomes the small one.
    camShare: Number.isFinite(share)
      ? clamp(share, 0.25, 0.5)
      : DEFAULT_GAMEPLAY_LAYOUT.camShare,
    fitCam: raw.fitCam !== false,
  };
}

/** Where the webcam is assumed to be when none was marked. */
const DEFAULT_CAM_REGION: SpeakerRegion = { x: 0.72, y: 0.6, width: 0.24, height: 0.34 };

/**
 * Panel heights for 'Streamer + juego'.
 *
 * With fitCam the webcam panel takes exactly the height the webcam's own
 * shape needs at full width - a 455x296 overlay becomes a 1080x702 panel -
 * so it is shown whole, edge to edge. Clamped to the same quarter-to-half
 * range as the fixed sizes; outside it the webcam is trimmed to fit, never
 * padded with game.
 */
export function gameplayPanels(
  layout: GameplayLayout,
  camRegion: SpeakerRegion | undefined,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): { camHeight: number; gameHeight: number; camShare: number } {
  let share = layout.camShare;
  if (layout.fitCam && camRegion) {
    const camW = clamp(camRegion.width, 0.01, 1) * sourceWidth;
    const camH = clamp(camRegion.height, 0.01, 1) * sourceHeight;
    share = clamp((targetWidth * (camH / camW)) / targetHeight, 0.25, 0.5);
  }
  const camHeight = evenSize(targetHeight * share);
  const gameHeight = evenSize(targetHeight - camHeight);
  return { camHeight, gameHeight, camShare: camHeight / targetHeight };
}

/**
 * The largest crop of the given shape that fits INSIDE a region, centred.
 *
 * The opposite of cropForRegion, which grows a region until it has the
 * shape. That is right for a head in a wide shot, and wrong for a webcam
 * overlay: growing it pulls the game around the overlay into the face panel.
 */
export function cropInsideRegion(
  region: SpeakerRegion,
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number
): CropRect {
  const rect = rectForRegion(region, sourceWidth, sourceHeight);
  let width = rect.width;
  let height = width / targetAspect;
  if (height > rect.height) {
    height = rect.height;
    width = height * targetAspect;
  }
  width = evenSize(width);
  height = evenSize(height);
  return {
    width,
    height,
    x: evenOffset(rect.x + (rect.width - width) / 2),
    y: evenOffset(rect.y + (rect.height - height) / 2),
  };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * H.264 chroma subsampling needs even dimensions, so both sizes and offsets
 * are rounded to even numbers - but they round differently.
 *
 * A size must never be zero, hence the floor of 2. An offset of 0 is perfectly
 * valid, and rounding one up can push the crop past the edge of the frame,
 * which FFmpeg rejects. So offsets round down and sizes round down too: both
 * err toward staying inside the picture.
 */
const evenSize = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
const evenOffset = (value: number) => Math.max(0, Math.floor(value / 2) * 2);

/**
 * Grows a marked region to the target aspect ratio, keeping it centred on the
 * subject and inside the frame.
 *
 * The region a person marks is roughly a head; a clip framed that tightly is
 * uncomfortable to watch, so it is padded before being fitted to the aspect.
 */
export function cropForRegion(
  region: SpeakerRegion,
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
  padding = 1.6
): CropRect {
  const centreX = (region.x + region.width / 2) * sourceWidth;
  const centreY = (region.y + region.height / 2) * sourceHeight;

  const markedW = Math.max(1, region.width * sourceWidth * padding);
  const markedH = Math.max(1, region.height * sourceHeight * padding);

  // Grow whichever side is too small, never shrink: cropping tighter than the
  // marked region would cut the subject the user explicitly pointed at.
  let width = markedW;
  let height = width / targetAspect;
  if (height < markedH) {
    height = markedH;
    width = height * targetAspect;
  }

  // Never ask for more than the source has.
  if (width > sourceWidth) {
    width = sourceWidth;
    height = width / targetAspect;
  }
  if (height > sourceHeight) {
    height = sourceHeight;
    width = height * targetAspect;
  }

  width = evenSize(Math.min(width, sourceWidth));
  height = evenSize(Math.min(height, sourceHeight));

  const x = evenOffset(clamp(centreX - width / 2, 0, Math.max(0, sourceWidth - width)));
  const y = evenOffset(clamp(centreY - height / 2, 0, Math.max(0, sourceHeight - height)));

  return { x, y, width, height };
}

/**
 * The marked region itself, clamped to the frame, with no aspect fitting.
 *
 * cropForRegion grows a region to a target shape, which is right when the
 * result has to fill a panel. It is wrong for a gameplay area: forcing a wide
 * playfield into a portrait panel makes it grow vertically until it hits the
 * top and bottom of the source, then shrink horizontally to compensate - and
 * what comes out is a narrow vertical strip with the HUD, the minimap and most
 * of the action cropped away. Measured on a 1920x1080 source: a marked region
 * of 1152x540 came out as an 980x1080 slice.
 */
function rectForRegion(
  region: SpeakerRegion,
  sourceWidth: number,
  sourceHeight: number
): CropRect {
  const width = evenSize(clamp(region.width, 0.05, 1) * sourceWidth);
  const height = evenSize(clamp(region.height, 0.05, 1) * sourceHeight);

  return {
    width,
    height,
    x: evenOffset(clamp(region.x * sourceWidth, 0, Math.max(0, sourceWidth - width))),
    y: evenOffset(clamp(region.y * sourceHeight, 0, Math.max(0, sourceHeight - height))),
  };
}

/** Centre crop, used when a mode needs a region but none was marked. */
function centreRegion(): SpeakerRegion {
  return { x: 0.25, y: 0.1, width: 0.5, height: 0.8 };
}

export interface ReframeResult {
  /** Complete filter_complex graph ending in [vout]. */
  filter: string;
  /** What the graph actually did, for the UI to report honestly. */
  appliedMode: FramingMode;
}

function buildBaseFilter(input: ReframeInput): ReframeResult {
  const { sourceWidth, sourceHeight, targetWidth, targetHeight } = input;
  const speakers = input.speakers ?? [];
  const targetAspect = targetWidth / targetHeight;
  const src = input.inputLabel ?? '[0:v]';

  if (input.mode === 'split') {
    // Two stacked panels, each half the output height.
    const panelHeight = evenSize(targetHeight / 2);
    const panelAspect = targetWidth / panelHeight;

    const regions = speakers.length >= 2 ? speakers.slice(0, 2) : [centreRegion(), centreRegion()];
    const [top, bottom] = regions.map((r) =>
      cropForRegion(r, sourceWidth, sourceHeight, panelAspect)
    );

    const filter =
      `${src}split=2[a][b];` +
      `[a]crop=${top.width}:${top.height}:${top.x}:${top.y},` +
      `scale=${targetWidth}:${panelHeight}[top];` +
      `[b]crop=${bottom.width}:${bottom.height}:${bottom.x}:${bottom.y},` +
      `scale=${targetWidth}:${panelHeight}[bottom];` +
      `[top][bottom]vstack=inputs=2`;

    return { filter, appliedMode: 'split' };
  }

  if (input.mode === 'gameplay') {
    // A streamer clip: what they are playing on top, their reaction below.
    //
    // The two panels come from different parts of the same frame, which is
    // exactly how these sources are laid out - a full-screen game with the
    // webcam sitting in one corner. Cropping them apart and stacking them is
    // what turns an unwatchable 16:9 shrunk onto a phone into something where
    // both the game and the face are legible.
    const layout = normaliseGameplayLayout(input.gameplayLayout ?? DEFAULT_GAMEPLAY_LAYOUT);
    const { camHeight, gameHeight } = gameplayPanels(
      layout,
      speakers[0],
      sourceWidth,
      sourceHeight,
      targetWidth,
      targetHeight
    );

    // Marked first is the webcam - it is the small, specific thing a user can
    // point at precisely. The game defaults to the whole frame, which is right
    // far more often than not.
    const camRegion = speakers[0] ?? DEFAULT_CAM_REGION;
    const gameRegion = speakers[1] ?? { x: 0, y: 0, width: 1, height: 1 };

    // The game is shown whole, never cropped: its edges carry the health bar,
    // the minimap, the score. Whatever the panel has left over is filled with
    // a blurred copy of the same picture rather than black bars, the same way
    // blur-fill does, so the panel reads as one image.
    const game = rectForRegion(gameRegion, sourceWidth, sourceHeight);
    // The webcam fills its panel with webcam only. A marked webcam is cropped
    // INSIDE its box: growing it to the panel's shape, as the other modes do
    // for a head in a wide shot, pulled a strip of the game into the face
    // panel - exactly what "the camera should fit the space" complained about.
    // With fitCam the panel already has the webcam's shape, so the crop is the
    // whole box. Only the unmarked default keeps the old grow-to-fit, since a
    // guessed box is not a webcam boundary anyway.
    const cam = speakers[0]
      ? cropInsideRegion(camRegion, sourceWidth, sourceHeight, targetWidth / camHeight)
      : cropForRegion(camRegion, sourceWidth, sourceHeight, targetWidth / camHeight, 1.05);

    const gameCrop = `crop=${game.width}:${game.height}:${game.x}:${game.y}`;

    const filter =
      `${src}split=3[gf][gb][c];` +
      `[gb]${gameCrop},scale=${targetWidth}:${gameHeight}:force_original_aspect_ratio=increase,` +
      `crop=${targetWidth}:${gameHeight},gblur=sigma=24,eq=brightness=-0.2[gbg];` +
      `[gf]${gameCrop},scale=${targetWidth}:${gameHeight}:force_original_aspect_ratio=decrease[gfg];` +
      `[gbg][gfg]overlay=(W-w)/2:(H-h)/2[gtop];` +
      `[c]crop=${cam.width}:${cam.height}:${cam.x}:${cam.y},` +
      `scale=${targetWidth}:${camHeight}[cbot];` +
      (layout.camPosition === 'top'
        ? `[cbot][gtop]vstack=inputs=2`
        : `[gtop][cbot]vstack=inputs=2`);

    return { filter, appliedMode: 'gameplay' };
  }

  if (input.mode === 'auto-fill') {
    const turns = input.turns ?? [];

    // Falling back to a plain focus crop is better than refusing: the user
    // still gets a vertical clip, just without the switching.
    if (turns.length <= 1 || speakers.length < 2) {
      const region = speakers[0] ?? centreRegion();
      const crop = cropForRegion(region, sourceWidth, sourceHeight, targetAspect);
      return {
        filter:
          `${src}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
          `scale=${targetWidth}:${targetHeight}`,
        appliedMode: 'focus',
      };
    }

    // One crop size for everyone, so the shot does not change scale when it
    // cuts between speakers. Positions switch; framing stays put.
    const crops = speakers
      .slice(0, 2)
      .map((region) => cropForRegion(region, sourceWidth, sourceHeight, targetAspect));
    const width = Math.min(...crops.map((c) => c.width));
    const height = Math.min(...crops.map((c) => c.height));

    const positions = speakers.slice(0, 2).map((region) => {
      const crop = cropForRegion(region, sourceWidth, sourceHeight, targetAspect);
      return {
        x: Math.max(0, Math.min(sourceWidth - width, crop.x + (crop.width - width) / 2)),
        y: Math.max(0, Math.min(sourceHeight - height, crop.y + (crop.height - height) / 2)),
      };
    });

    // Nested conditionals over t. crop's x and y carry the timeline flag, so
    // an expression mentioning t is re-evaluated every frame on its own - the
    // old `eval=frame` option does not exist in current builds and passing it
    // fails the whole render with "Option not found".
    const pick = (axis: 'x' | 'y') =>
      turns
        .slice(0, -1)
        .reduceRight(
          (rest, turn) =>
            `if(lt(t,${turn.end.toFixed(2)}),${Math.round(
              positions[Math.min(turn.speaker, 1)][axis]
            )},${rest})`,
          String(Math.round(positions[Math.min(turns[turns.length - 1].speaker, 1)][axis]))
        );

    return {
      filter:
        `${src}crop=${width}:${height}:'${pick('x')}':'${pick('y')}',` +
        `scale=${targetWidth}:${targetHeight}`,
      appliedMode: 'auto-fill',
    };
  }

  if (input.mode === 'focus') {
    const region = speakers[0] ?? centreRegion();
    const crop = cropForRegion(region, sourceWidth, sourceHeight, targetAspect);

    return {
      filter:
        `${src}crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
        `scale=${targetWidth}:${targetHeight}`,
      appliedMode: 'focus',
    };
  }

  if (input.mode === 'zoom-crop') {
    return {
      filter:
        `${src}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,` +
        `crop=${targetWidth}:${targetHeight}`,
      appliedMode: 'zoom-crop',
    };
  }

  if (input.mode === 'fit') {
    return {
      filter:
        `${src}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=0x0F172A`,
      appliedMode: 'fit',
    };
  }

  // blur-fill: enlarged blurred copy behind, sharp centred copy in front.
  return {
    filter:
      `${src}split=2[bg][fg];` +
      `[bg]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,` +
      `crop=${targetWidth}:${targetHeight},gblur=sigma=28,eq=brightness=-0.18[bgb];` +
      `[fg]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`,
    appliedMode: 'blur-fill',
  };
}

/** Modes that crop a marked region, and so go wrong after a cut to another camera. */
const REGION_MODES: FramingMode[] = ['focus', 'split', 'auto-fill', 'gameplay'];

/** `between(t,a,b)+...` - true while t is inside any of the ranges. */
export function rangesExpression(ranges: Array<{ start: number; end: number }>): string {
  return ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join('+');
}

export function buildReframeFilter(input: ReframeInput): ReframeResult {
  const ranges = (input.fallbackRanges ?? []).filter((r) => r.end > r.start);
  if (!REGION_MODES.includes(input.mode) || ranges.length === 0) {
    return buildBaseFilter(input);
  }

  const src = input.inputLabel ?? '[0:v]';

  // Both framings are rendered for the whole clip and the wide one is laid
  // over the cropped one only while another camera is on screen. Same output
  // size, so the overlay simply replaces the picture. Doing it by time rather
  // than by trimming and concatenating keeps the timeline intact for the
  // captions and the emoji that are burned on afterwards.
  const marked = buildBaseFilter({ ...input, inputLabel: '[rf_in]' });
  const wide = buildBaseFilter({ ...input, mode: 'blur-fill', inputLabel: '[bf_in]' });

  return {
    filter:
      `${src}split=2[rf_in][bf_in];` +
      `${marked.filter}[rf_out];` +
      `${wide.filter}[bf_out];` +
      `[rf_out][bf_out]overlay=0:0:enable='${rangesExpression(ranges)}'`,
    appliedMode: marked.appliedMode,
  };
}
