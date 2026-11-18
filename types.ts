export interface TranscriptSegment {
  text: string;
  start: number; // in seconds
  duration: number; // in seconds
}

/** Un video traído por enlace, de cualquier sitio que yt-dlp reconozca. */
export interface SourceVideoInfo {
  url: string;
  /** Nombre legible del sitio: YouTube, Kick, Twitch... */
  site: string;
  /** Local playback URL, available once the video has been downloaded. */
  streamUrl?: string;
  /** Handle for the downloaded file on the server, used for export. */
  sourceId?: string;
  title: string;
  author: string;
  authorUrl?: string;
  thumbnailUrl: string;
  duration: number; // in seconds
  description?: string;
  hasTranscript: boolean;
  transcript?: TranscriptSegment[];
}

export interface SubtitleWordTiming {
  text: string;
  /** Seconds relative to the start of the clip. */
  start: number;
  end: number;
  /**
   * An emoji pinned to this word, which pops in on the beat it is spoken.
   * Burned in as an image, because no caption font carries colour emoji.
   */
  emoji?: string;
}

export interface SubtitleLine {
  text: string;
  startTime: number; // Relative to clip start in seconds
  endTime: number;   // Relative to clip start in seconds
  /**
   * Real per-word timings from Whisper, when available. The caption animations
   * prefer these over estimating word boundaries from word length.
   */
  words?: SubtitleWordTiming[];
}

export interface ViralityMetrics {
  hookImpact: number; // 1-100
  retentionPotential: number; // 1-100
  shareability: number; // 1-100
  emotionalTrigger: string;
}

export interface SocialPost {
  caption: string;
  hashtags: string[];
  callToAction: string;
}

export interface ClipIdea {
  clipId: string;
  title: string;
  hook: string;
  description: string;
  startTimeSeconds: number; // Absolute time in original video
  endTimeSeconds: number;   // Absolute time in original video
  targetPlatforms: string[];
  viralityScore: number; // 1-100
  viralityMetrics: ViralityMetrics;
  viralityJustification: string;
  soundBiteQuote?: string;
  suggestedSubtitles: SubtitleLine[];
  socialPost: SocialPost;
}

export interface AnalysisResponse {
  summary: string;
  overallRating?: number;
  suggestedClips: ClipIdea[];
}

export enum SubtitleStyleType {
  PILL = 'pill',
  HORMOZI = 'hormozi',
  MRBEAST = 'mrbeast',
  CLEAN_MINIMAL = 'clean_minimal',
  CYBERPUNK = 'cyberpunk',
  CLASSIC = 'classic',
}

export interface SubtitleStyle {
  id: SubtitleStyleType;
  name: string;
  description: string;
  badge: string;
  previewClass: string;
  textColor: string;
}

export type AspectRatioType = '9:16' | '1:1' | '16:9' | 'original';

export type FramingMode =
  | 'blur-fill'
  | 'zoom-crop'
  | 'fit'
  | 'focus'
  | 'split'
  | 'auto-fill'
  | 'gameplay';

/** Zona del fotograma marcada por el usuario, normalizada 0-1. */
export interface SpeakerRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Second of the source the region was marked on (the reference frame). */
  markedAt?: number;
}

/** 'Streamer + juego': where the webcam panel goes and how much height it takes. */
export interface GameplayLayout {
  camPosition: 'top' | 'bottom';
  /** Fraction of the vertical frame, 0.25-0.5. Ignored while fitCam is on. */
  camShare: number;
  /** Panel takes the webcam's own shape, so it fits exactly. */
  fitCam?: boolean;
}

export const DEFAULT_GAMEPLAY_LAYOUT: GameplayLayout = {
  camPosition: 'bottom',
  camShare: 0.38,
  fitCam: true,
};

/**
 * Where the transcript comes from.
 *
 *   captions - YouTube's own subtitles: instant, but timed per phrase and with
 *              no markers for laughter or applause
 *   whisper  - transcribe locally: per-word timings and audience reactions, at
 *              roughly 1.2x real time on CPU
 */
export type TranscriptionModeType = 'captions' | 'whisper';

export type SubtitleAnimationType =
  | 'none'
  | 'fade'
  | 'pop'
  | 'slide'
  | 'karaoke'
  | 'word-pop';

export interface SubtitleAnimationOption {
  id: SubtitleAnimationType;
  name: string;
  description: string;
  badge: string;
}

export interface GeneratedHook {
  style: string;
  hookText: string;
  explanation: string;
}

/**
 * The user's own logo burned onto every export. Fractions of the frame, so
 * the same settings fit 9:16, 1:1 and 16:9 (mirrors lib/watermark.ts).
 */
export interface WatermarkSettings {
  /** PNG as a data URL. */
  image: string;
  /** Logo width as a fraction of the video width. */
  widthRatio: number;
  /** Centre of the logo, 0-1. */
  x: number;
  y: number;
  /** 0-1. */
  opacity: number;
}

export const DEFAULT_WATERMARK: Omit<WatermarkSettings, 'image'> = {
  widthRatio: 0.25,
  x: 0.5,
  y: 0.93,
  opacity: 0.85,
};
