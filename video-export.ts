import {
  ClipIdea,
  SubtitleLine,
  SubtitleStyleType,
  AspectRatioType,
  FramingMode,
  SubtitleAnimationType,
} from './types';
import { wordsForLine } from './lib/ass';
import { getSubtitleStyle, type SubtitleStyleDef } from './lib/subtitle-styles';

// Format seconds into SRT timecode (00:00:00,000)
export function formatSrtTime(seconds: number): string {
  const pad = (n: number, z = 2) => String(Math.floor(n)).padStart(z, '0');
  const hrs = pad(seconds / 3600);
  const mins = pad((seconds % 3600) / 60);
  const secs = pad(seconds % 60);
  const ms = pad((seconds % 1) * 1000, 3);
  return `${hrs}:${mins}:${secs},${ms}`;
}

// Format seconds into VTT timecode (00:00:00.000)
export function formatVttTime(seconds: number): string {
  const pad = (n: number, z = 2) => String(Math.floor(n)).padStart(z, '0');
  const hrs = pad(seconds / 3600);
  const mins = pad((seconds % 3600) / 60);
  const secs = pad(seconds % 60);
  const ms = pad((seconds % 1) * 1000, 3);
  return `${hrs}:${mins}:${secs}.${ms}`;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').substring(0, 45) || 'clip_viral';
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// Export SRT file
export function downloadSrtFile(subtitles: SubtitleLine[], filename: string) {
  let srtContent = '';
  subtitles.forEach((sub, index) => {
    srtContent += `${index + 1}\n`;
    srtContent += `${formatSrtTime(sub.startTime)} --> ${formatSrtTime(sub.endTime)}\n`;
    srtContent += `${sub.text.trim()}\n\n`;
  });

  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(filename)}.srt`);
}

// Export VTT file
export function downloadVttFile(subtitles: SubtitleLine[], filename: string) {
  let vttContent = 'WEBVTT\n\n';
  subtitles.forEach((sub, index) => {
    vttContent += `${index + 1}\n`;
    vttContent += `${formatVttTime(sub.startTime)} --> ${formatVttTime(sub.endTime)}\n`;
    vttContent += `${sub.text.trim()}\n\n`;
  });

  const blob = new Blob([vttContent], { type: 'text/vtt;charset=utf-8' });
  triggerDownload(blob, `${sanitizeFilename(filename)}.vtt`);
}

// Export Full Social Media Kit Text File
export function downloadSocialKit(clip: ClipIdea) {
  const duration = Math.max(1, Math.round(clip.endTimeSeconds - clip.startTimeSeconds));
  const subtitlesText = clip.suggestedSubtitles && clip.suggestedSubtitles.length > 0
    ? clip.suggestedSubtitles.map(sub => 
        `  [${sub.startTime.toFixed(1)}s - ${sub.endTime.toFixed(1)}s] ${sub.text}`
      ).join('\n')
    : '  (Sin subtítulos registrados)';

  const content = `=====================================================
🚀 ESTRATEGIA VIRAL & KIT DE PUBLICACIÓN - GEMINI AI
=====================================================
TÍTULO: ${clip.title}
DURACIÓN: ${duration} segundos (${clip.startTimeSeconds.toFixed(1)}s - ${clip.endTimeSeconds.toFixed(1)}s)
PUNTUACIÓN DE VIRALIDAD: ${clip.viralityScore}/100

🔥 GANCHO DE APERTURA (HOOK):
"${clip.hook}"

💬 CITA DESTACADA (SOUNDBITE):
"${clip.soundBiteQuote || clip.hook}"

📊 MÉTRICAS DE VIRALIDAD:
- Impacto de Gancho: ${clip.viralityMetrics?.hookImpact || 80}/100
- Potencial de Retención: ${clip.viralityMetrics?.retentionPotential || 85}/100
- Compartibilidad: ${clip.viralityMetrics?.shareability || 75}/100
- Detonante Emocional: ${clip.viralityMetrics?.emotionalTrigger || 'Curiosidad y Sorpresa'}

💡 JUSTIFICACIÓN ESTRATÉGICA:
${clip.viralityJustification}

📱 PLATAFORMAS OBJETIVO:
${clip.targetPlatforms.join(' • ')}

📝 COPY LISTO PARA REDES SOCIALES (TIKTOK / REELS / SHORTS):
${clip.socialPost?.caption || ''}

🏷️ HASHTAGS RECOMENDADOS:
${(clip.socialPost?.hashtags || []).join(' ')}

🎯 LLAMADA A LA ACCIÓN (CTA):
${clip.socialPost?.callToAction || 'Comenta qué opinas abajo 👇'}

📜 SUBTÍTULOS TIMECODEADOS:
${subtitlesText}

=====================================================
Generado con Extractor de Clips Virales
=====================================================`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, `kit_viral_${sanitizeFilename(clip.title)}.txt`);
}

export interface ExportVideoOptions {
  videoSource?: HTMLVideoElement | string | null;
  clipTitle: string;
  startTime: number;
  endTime: number;
  aspectRatio: AspectRatioType;
  framingMode?: FramingMode; // 'blur-fill' | 'zoom-crop' | 'fit'
  subtitleStyle: SubtitleStyleType;
  subtitles: SubtitleLine[];
  burnSubtitles?: boolean;
  subtitlePosition?: 'bottom' | 'center' | 'top';
  subtitleAnimation?: SubtitleAnimationType;
  onProgress: (progress: number, message: string) => void;
}

// Wrap text into multiple lines for canvas drawing
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (let i = 0; i < words.length; i++) {
    const testLine = currentLine ? `${currentLine} ${words[i]}` : words[i];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Subtitle rendering
// ---------------------------------------------------------------------------
// Mirrors lib/ass.ts so the browser fallback produces the same look FFmpeg
// would. Word timings come from splitLineIntoWords(), the same helper the ASS
// generator uses, so the highlight lands on the same word at the same moment.

/** Ease-out-back, matching the overshoot of the CSS and ASS pop. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface LineEntrance {
  alpha: number;
  scale: number;
  offsetY: number;
}

/** Entrance state for animations that act on the line as a whole. */
function lineEntrance(animation: SubtitleAnimationType, elapsedMs: number): LineEntrance {
  const rest: LineEntrance = { alpha: 1, scale: 1, offsetY: 0 };

  switch (animation) {
    case 'fade':
      return { ...rest, alpha: clamp01(elapsedMs / 120) };

    case 'pop':
    case 'word-pop': {
      const t = clamp01(elapsedMs / 190);
      return {
        alpha: clamp01(elapsedMs / 60),
        scale: 0.72 + (1 - 0.72) * easeOutBack(t),
        offsetY: 0,
      };
    }

    case 'slide': {
      const t = clamp01(elapsedMs / 190);
      return { alpha: clamp01(elapsedMs / 120), scale: 1, offsetY: 28 * (1 - t) };
    }

    default:
      return rest;
  }
}

/** Colour and scale for one word at the current moment. */
function wordState(
  animation: SubtitleAnimationType,
  spec: SubtitleStyleDef,
  word: { startMs: number; endMs: number },
  elapsedMs: number
): { color: string; scale: number } {
  if (animation === 'karaoke') {
    // Cumulative fill: once a word has been reached it stays highlighted.
    return { color: elapsedMs >= word.startMs ? spec.highlight : spec.base, scale: 1 };
  }

  if (animation !== 'word-pop') return { color: spec.base, scale: 1 };

  const accentIn = 70;
  const accentOut = 90;

  if (elapsedMs < word.startMs || elapsedMs > word.endMs + accentOut) {
    return { color: spec.base, scale: 1 };
  }

  // Grow into the accent, hold, then settle back.
  let strength: number;
  if (elapsedMs < word.startMs + accentIn) {
    strength = (elapsedMs - word.startMs) / accentIn;
  } else if (elapsedMs <= word.endMs) {
    strength = 1;
  } else {
    strength = 1 - (elapsedMs - word.endMs) / accentOut;
  }

  strength = clamp01(strength);
  return {
    color: strength > 0.5 ? spec.highlight : spec.base,
    scale: 1 + 0.18 * strength,
  };
}

/**
 * Draws one subtitle line onto the export canvas.
 *
 * Word-level animations are laid out manually rather than via measureText on
 * the whole string, because each word can be scaled independently and the
 * advance width has to account for that.
 */
export function drawSubtitleOnCanvas(
  ctx: CanvasRenderingContext2D,
  line: SubtitleLine,
  clipTime: number,
  style: SubtitleStyleType,
  canvasW: number,
  canvasH: number,
  position: 'bottom' | 'center' | 'top' = 'bottom',
  animation: SubtitleAnimationType = 'none'
) {
  const text = line.text?.trim();
  if (!text) return;

  const spec = getSubtitleStyle(style);
  const elapsedMs = Math.max(0, (clipTime - line.startTime) * 1000);

  const fontSize = Math.round(canvasW * spec.sizeRatio);
  const display = spec.uppercase ? text.toUpperCase() : text;

  const entrance = lineEntrance(animation, elapsedMs);
  if (entrance.alpha <= 0.01) return;

  // Same margin fraction the ASS renderer uses, so both engines place the text
  // at the same height.
  let baseY = canvasH * (1 - spec.marginRatio);
  if (position === 'center') baseY = canvasH * 0.5;
  if (position === 'top') baseY = canvasH * spec.marginRatio;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = entrance.alpha;
  ctx.font = `${spec.cssWeight} ${fontSize}px ${spec.cssFont}`;

  const maxTextW = canvasW * 0.88 - (spec.box ? spec.box.padX * 2 : 0);
  const rows = wrapText(ctx, display, maxTextW);
  const lineHeight = fontSize * 1.25;
  const startY = baseY - ((rows.length - 1) * lineHeight) / 2 + entrance.offsetY;

  // Scale the whole line about its centre for the pop entrance.
  ctx.translate(canvasW / 2, baseY);
  ctx.scale(entrance.scale, entrance.scale);
  ctx.translate(-canvasW / 2, -baseY);

  const perWord = animation === 'karaoke' || animation === 'word-pop';
  const words = perWord ? wordsForLine(line) : [];
  let wordCursor = 0;

  rows.forEach((row, rowIndex) => {
    const rowY = startY + rowIndex * lineHeight;
    const rowWidth = ctx.measureText(row).width;

    if (spec.box) {
      const boxW = Math.min(canvasW * 0.94, rowWidth + spec.box.padX * 2);
      const boxH = fontSize * 1.5;
      ctx.fillStyle = spec.box.fill;
      ctx.beginPath();
      ctx.roundRect(canvasW / 2 - boxW / 2, rowY - boxH / 2, boxW, boxH, spec.box.radius);
      ctx.fill();
      if (spec.box.border) {
        ctx.lineWidth = Math.max(2, fontSize * 0.05);
        ctx.strokeStyle = spec.box.border;
        ctx.stroke();
      }
    }

    const drawGlyph = (glyph: string, centreX: number, scale: number, color: string) => {
      ctx.save();
      ctx.translate(centreX, rowY);
      if (scale !== 1) ctx.scale(scale, scale);
      if (spec.glow) {
        ctx.shadowColor = spec.glow;
        ctx.shadowBlur = fontSize * 0.25;
      }
      if (spec.stroke) {
        ctx.lineWidth = Math.round(fontSize * spec.stroke.widthRatio);
        ctx.strokeStyle = spec.stroke.color;
        ctx.lineJoin = 'round';
        ctx.strokeText(glyph, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
    };

    if (!perWord) {
      drawGlyph(row, canvasW / 2, 1, spec.base);
      return;
    }

    // Lay the row out word by word so each can carry its own colour and scale.
    const rowWords = row.split(' ').filter(Boolean);
    const spaceWidth = ctx.measureText(' ').width;
    const widths = rowWords.map((word) => ctx.measureText(word).width);
    const totalWidth =
      widths.reduce((sum, w) => sum + w, 0) + spaceWidth * Math.max(0, rowWords.length - 1);

    let cursorX = canvasW / 2 - totalWidth / 2;

    rowWords.forEach((word, index) => {
      const lineDurationMs = Math.max(1, (line.endTime - line.startTime) * 1000);
      const timing = words[wordCursor] ?? { startMs: 0, endMs: lineDurationMs };
      wordCursor += 1;

      const { color, scale } = wordState(animation, spec, timing, elapsedMs);
      drawGlyph(word, cursorX + widths[index] / 2, scale, color);
      cursorX += widths[index] + spaceWidth;
    });
  });

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Export engine
// ---------------------------------------------------------------------------
// Renders the clip to an offscreen canvas while a dedicated <video> plays it,
// and records that canvas with MediaRecorder.
//
// Three things this deliberately does NOT do, because the previous version did
// them and they produced broken files:
//   1. It never labels the blob as MP4 unless MediaRecorder actually produced
//      MP4. The extension always matches the real container.
//   2. It never falls back to drawing a gradient placeholder. If the video
//      cannot be decoded it throws, so the user gets an error instead of a
//      large file containing nothing but a blue gradient.
//   3. It does not rely on requestAnimationFrame alone, which browsers freeze
//      in background tabs, silently truncating the export.

export interface ExportResult {
  container: 'mp4' | 'webm';
  hasAudio: boolean;
  fileName: string;
  durationSeconds: number;
}

interface RecorderFormat {
  mime: string;
  ext: 'mp4' | 'webm';
}

// Ordered best-first. Chrome 126+ can record real MP4/H.264; everything else
// gets WebM, which we then name honestly.
const RECORDER_FORMATS: RecorderFormat[] = [
  { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mime: 'video/mp4;codecs=avc1,mp4a', ext: 'mp4' },
  { mime: 'video/mp4', ext: 'mp4' },
  { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mime: 'video/webm', ext: 'webm' },
];

function pickRecorderFormat(): RecorderFormat | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const format of RECORDER_FORMATS) {
    if (MediaRecorder.isTypeSupported(format.mime)) return format;
  }
  return null;
}

function resolveSourceUrl(videoSource: ExportVideoOptions['videoSource']): string {
  if (typeof videoSource === 'string') return videoSource;
  if (videoSource instanceof HTMLVideoElement) {
    return videoSource.currentSrc || videoSource.src || '';
  }
  return '';
}

// Waits for a media event, rejecting on error or timeout instead of silently
// continuing with a video that never loaded.
function waitForEvent(
  el: HTMLVideoElement,
  events: string[],
  timeoutMs: number,
  description: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      events.forEach((name) => el.removeEventListener(name, onSuccess));
      el.removeEventListener('error', onError);
      window.clearTimeout(timer);
    };

    const onSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(description + ': el navegador no pudo cargar el video.'));
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(description + ': se agotó el tiempo de espera.'));
    }, timeoutMs);

    events.forEach((name) => el.addEventListener(name, onSuccess));
    el.addEventListener('error', onError);
  });
}

// Routes the element's audio through WebAudio into the recorded stream.
//
// The previous code called captureStream() on a muted element, which in Chrome
// yields zero audio tracks - that is why exports came out silent. A
// MediaStreamAudioDestinationNode works regardless of mute state, and because
// we never connect it to audioCtx.destination the user hears nothing while the
// export runs.
async function attachAudioTrack(
  video: HTMLVideoElement,
  target: MediaStream
): Promise<{ ok: boolean; audioCtx: AudioContext | null }> {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return { ok: false, audioCtx: null };

    const audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }

    const sourceNode = audioCtx.createMediaElementSource(video);
    const destination = audioCtx.createMediaStreamDestination();
    sourceNode.connect(destination);

    const tracks = destination.stream.getAudioTracks();
    tracks.forEach((track) => target.addTrack(track));
    return { ok: tracks.length > 0, audioCtx };
  } catch (err) {
    console.warn('No se pudo enrutar el audio del clip:', err);
    return { ok: false, audioCtx: null };
  }
}

// Composites one frame: background treatment, then the video itself.
function composeFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
  aspectRatio: AspectRatioType,
  framingMode: FramingMode
) {
  const vW = video.videoWidth;
  const vH = video.videoHeight;
  if (!vW || !vH) return;

  const isVerticalOrSquare = aspectRatio === '9:16' || aspectRatio === '1:1';

  if (!isVerticalOrSquare) {
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    return;
  }

  if (framingMode === 'zoom-crop') {
    const scale = Math.max(targetWidth / vW, targetHeight / vH);
    const w = vW * scale;
    const h = vH * scale;
    ctx.drawImage(video, (targetWidth - w) / 2, (targetHeight - h) / 2, w, h);
    return;
  }

  if (framingMode === 'fit') {
    const grad = ctx.createLinearGradient(0, 0, 0, targetHeight);
    grad.addColorStop(0, '#090D16');
    grad.addColorStop(0.5, '#0F172A');
    grad.addColorStop(1, '#090D16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    const scale = Math.min(targetWidth / vW, targetHeight / vH);
    const w = vW * scale;
    const h = vH * scale;
    ctx.drawImage(video, (targetWidth - w) / 2, (targetHeight - h) / 2, w, h);
    return;
  }

  // 'blur-fill': enlarged blurred copy behind, sharp centred copy in front.
  ctx.save();
  const bgScale = Math.max(targetWidth / vW, targetHeight / vH);
  const bgW = vW * bgScale;
  const bgH = vH * bgScale;
  ctx.filter = 'blur(28px) brightness(0.40)';
  ctx.drawImage(video, (targetWidth - bgW) / 2, (targetHeight - bgH) / 2, bgW, bgH);
  ctx.restore();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  const fgScale = Math.min(targetWidth / vW, targetHeight / vH);
  const fgW = vW * fgScale;
  const fgH = vH * fgScale;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 24;
  ctx.drawImage(video, (targetWidth - fgW) / 2, (targetHeight - fgH) / 2, fgW, fgH);
  ctx.restore();
}

export async function renderAndExportVideo(options: ExportVideoOptions): Promise<ExportResult> {
  const {
    videoSource,
    clipTitle,
    startTime,
    endTime,
    aspectRatio,
    framingMode = 'blur-fill',
    subtitleStyle,
    subtitles,
    burnSubtitles = true,
    subtitlePosition = 'bottom',
    subtitleAnimation = 'none',
    onProgress,
  } = options;

  const duration = Math.max(0.5, endTime - startTime);

  const format = pickRecorderFormat();
  if (!format) {
    throw new Error(
      'Este navegador no puede grabar video (MediaRecorder no disponible). Usa Chrome, Edge o Firefox actualizados.'
    );
  }

  const sourceUrl = resolveSourceUrl(videoSource);
  if (!sourceUrl) {
    throw new Error('No hay una fuente de video utilizable para exportar este clip.');
  }
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(sourceUrl)) {
    throw new Error(
      'No se puede exportar desde una página de YouTube. Descarga el video y súbelo como archivo local.'
    );
  }

  let targetWidth = 1080;
  let targetHeight = 1920;
  if (aspectRatio === '1:1') {
    targetHeight = 1080;
  } else if (aspectRatio === '16:9') {
    targetWidth = 1920;
    targetHeight = 1080;
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('No se pudo inicializar el motor gráfico Canvas 2D.');

  // Always a dedicated element: calling createMediaElementSource on the on-page
  // player would permanently reroute its audio away from the speakers.
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'auto';
  video.volume = 1;

  // Offscreen but attached, so the browser decodes frames without throttling.
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText =
    'position:fixed;top:0;left:0;width:320px;height:180px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden;';
  stage.appendChild(video);
  document.body.appendChild(stage);

  let audioCtx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  const timers: number[] = [];

  const cleanup = () => {
    timers.forEach((id) => window.clearInterval(id));
    try {
      video.pause();
    } catch {
      /* element already detached */
    }
    video.removeAttribute('src');
    video.load();
    if (stage.parentNode) stage.parentNode.removeChild(stage);
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  };

  try {
    onProgress(0.05, 'Cargando el video para exportar...');
    video.src = sourceUrl;
    await waitForEvent(video, ['loadeddata', 'canplay'], 30000, 'Carga del video');

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('El video se cargó pero no tiene una pista de imagen decodificable.');
    }

    onProgress(0.12, 'Preparando la pista de audio...');
    const canvasStream = canvas.captureStream(30);
    const audioResult = await attachAudioTrack(video, canvasStream);
    audioCtx = audioResult.audioCtx;
    const hasAudio = audioResult.ok;

    onProgress(0.18, 'Posicionando el inicio del corte...');
    video.currentTime = startTime;
    await waitForEvent(video, ['seeked'], 15000, 'Posicionamiento del corte');

    recorder = new MediaRecorder(canvasStream, {
      mimeType: format.mime,
      videoBitsPerSecond: 8000000,
      audioBitsPerSecond: 128000,
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    const activeRecorder = recorder;
    const recordingFinished = new Promise<void>((resolve, reject) => {
      activeRecorder.onstop = () => resolve();
      activeRecorder.onerror = () => reject(new Error('El grabador de video falló durante la exportación.'));
    });

    activeRecorder.start(100);

    try {
      await video.play();
    } catch {
      throw new Error(
        'El navegador bloqueó la reproducción necesaria para exportar. Vuelve a pulsar "Exportar" sin cambiar de pestaña.'
      );
    }

    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      timers.forEach((id) => window.clearInterval(id));
      video.pause();
      if (activeRecorder.state !== 'inactive') activeRecorder.stop();
    };

    const drawFrame = () => {
      if (stopped) return;
      const clipTime = Math.max(0, video.currentTime - startTime);

      composeFrame(ctx, video, targetWidth, targetHeight, aspectRatio, framingMode);

      if (burnSubtitles && subtitles && subtitles.length > 0) {
        // A short tail past endTime lets the per-word accent settle instead of
        // vanishing mid-animation.
        const activeSub = subtitles.find(
          (s) => clipTime >= s.startTime && clipTime <= s.endTime + 0.1
        );
        if (activeSub && activeSub.text) {
          drawSubtitleOnCanvas(
            ctx,
            activeSub,
            clipTime,
            subtitleStyle,
            targetWidth,
            targetHeight,
            subtitlePosition,
            subtitleAnimation
          );
        }
      }
    };

    // Primary loop, synced to actually presented frames where supported.
    const scheduleNextFrame = () => {
      if (stopped) return;
      const withRvfc = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof withRvfc.requestVideoFrameCallback === 'function') {
        withRvfc.requestVideoFrameCallback(() => {
          drawFrame();
          scheduleNextFrame();
        });
      } else {
        requestAnimationFrame(() => {
          drawFrame();
          scheduleNextFrame();
        });
      }
    };
    scheduleNextFrame();

    // Backstop: rAF and rVFC are frozen in background tabs, setInterval is only
    // throttled. Without this the canvas stops updating and the export truncates
    // the moment the user switches tabs.
    timers.push(window.setInterval(drawFrame, 200));

    // Completion and progress run on their own timer, so a starved draw loop can
    // never leave the recording running forever.
    const hardDeadline = performance.now() + duration * 1000 + 20000;
    timers.push(
      window.setInterval(() => {
        if (stopped) return;
        const clipTime = Math.max(0, video.currentTime - startTime);
        onProgress(
          Math.min(0.95, 0.18 + (clipTime / duration) * 0.77),
          'Renderizando ' + clipTime.toFixed(1) + 's de ' + duration.toFixed(1) + 's...'
        );
        if (video.currentTime >= endTime - 0.02 || video.ended || performance.now() > hardDeadline) {
          finish();
        }
      }, 100)
    );

    await recordingFinished;

    onProgress(0.98, 'Empaquetando el archivo...');
    const blob = new Blob(chunks, { type: format.mime });
    if (blob.size === 0) {
      throw new Error('La grabación quedó vacía. Revisa que el video se reproduzca y reintenta.');
    }

    const fileName =
      sanitizeFilename(clipTitle) + '_' + aspectRatio.replace(':', 'x') + '.' + format.ext;
    triggerDownload(blob, fileName);

    onProgress(1, hasAudio ? '¡Exportación completada!' : 'Exportado, pero sin pista de audio.');

    return {
      container: format.ext,
      hasAudio,
      fileName,
      durationSeconds: duration,
    };
  } finally {
    cleanup();
  }
}
