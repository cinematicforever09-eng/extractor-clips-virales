import type { WatermarkSettings } from './types';

/**
 * Thin wrapper over fetch for the /api routes.
 *
 * There is no API key and no account: transcription runs through whisper.cpp
 * and the copywriting through Ollama, both on this machine.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Set when the failure is a missing local tool rather than a bad request. */
  readonly missingTool?: string;

  constructor(message: string, status: number, missingTool?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.missingTool = missingTool;
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('No se pudo conectar con el servidor. Revisa tu conexión.', 0);
  }

  if (response.status === 413) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || 'El contenido enviado es demasiado grande.', 413);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const missing = data.whisperMissing
      ? 'whisper'
      : data.ollamaMissing
        ? 'ollama'
        : data.ffmpegMissing
          ? 'ffmpeg'
          : data.ytDlpMissing
            ? 'yt-dlp'
            : undefined;
    throw new ApiError(data.error || `Error del servidor (${response.status}).`, response.status, missing);
  }

  return (await response.json()) as T;
}

export interface HealthInfo {
  status: string;
  ffmpegAvailable: boolean;
  /** 'ffmpeg' when the server can render; 'browser' when it must fall back. */
  exportEngine: 'ffmpeg' | 'browser';
  /** Si yt-dlp está disponible para traer videos por enlace. */
  linksEnabled: boolean;
  whisperAvailable: boolean;
  whisperModel: string | null;
  whisperBackend: 'gpu' | 'cpu' | null;
  /** Voice activity detection, which stops whisper transcribing silence. */
  whisperVad?: boolean;
  /**
   * How many seconds of audio this machine transcribes per second of wall
   * clock. Measured after the first real run; before that it is a
   * conservative default for the backend in use.
   */
  whisperSpeed?: number;
  whisperSpeedMeasured?: boolean;
  ollamaAvailable: boolean;
  ollamaModel: string | null;
  /** Tokens per second the local model is actually managing right now. */
  ollamaSpeed?: number | null;
}

export interface AnalysisProgress {
  stage: string;
  progress: number;
}

/**
 * Runs the analysis as a polled background job.
 *
 * Transcribing half an hour of audio takes minutes on CPU, far longer than a
 * held-open request survives, so the server returns a job id and this polls it.
 */
export class AnalysisCancelled extends Error {}

export async function analyzeVideoJob<T>(
  body: unknown,
  onProgress?: (progress: AnalysisProgress) => void,
  signal?: AbortSignal
): Promise<T> {
  const { jobId } = await postJson<{ jobId: string }>('/api/analyze-video', body);

  // Aborting has to reach the server: the work is a whisper process there, and
  // simply stopping the polling would leave it running to completion.
  const onAbort = () => {
    void fetch(`/api/analyze-video/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 800));

    const res = await fetch(`/api/analyze-video/${jobId}`);
    if (!res.ok) throw new ApiError('Se perdió el seguimiento del análisis.', res.status);

    const job = (await res.json()) as {
      stage: string;
      progress: number;
      done: boolean;
      cancelled?: boolean;
      result?: T;
      error?: string;
    };

    onProgress?.({ stage: job.stage, progress: job.progress });

    if (job.done) {
      if (job.cancelled) throw new AnalysisCancelled('Análisis cancelado.');
      if (job.error) throw new ApiError(job.error, 500);
      if (!job.result) throw new ApiError('El análisis terminó sin resultados.', 500);
      return job.result;
    }
  }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Streams the chosen video to the server once, so FFmpeg has a real file to
 * work from. Every clip exported from that video reuses the same upload.
 */
export async function uploadSource(
  file: File,
  onProgress?: (fraction: number) => void
): Promise<{ sourceId: string; duration: number | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/source/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));

    // fetch() cannot report upload progress, and these files are large enough
    // that a silent multi-second wait reads as a hang.
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new ApiError('El servidor devolvió una respuesta ilegible.', xhr.status));
        }
      } else {
        let message = `Error al subir el video (${xhr.status}).`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {
          /* keep the generic message */
        }
        reject(new ApiError(message, xhr.status));
      }
    };

    xhr.onerror = () => reject(new ApiError('Se perdió la conexión al subir el video.', 0));
    xhr.send(file);
  });
}

export interface ServerExportParams {
  sourceId: string;
  clipTitle: string;
  startSeconds: number;
  durationSeconds: number;
  aspectRatio: string;
  framingMode: string;
  subtitles: Array<{
    text: string;
    startTime: number;
    endTime: number;
    words?: Array<{ text: string; start: number; end: number; emoji?: string }>;
  }>;
  subtitleStyle: string;
  subtitlePosition: string;
  subtitleAnimation: string;
  burnSubtitles: boolean;
  /** Marked regions for the focus and split framings. */
  speakers?: Array<{ x: number; y: number; width: number; height: number; markedAt?: number }>;
  /** 'gameplay' only: webcam on top or below, and how much height it takes. */
  gameplayLayout?: { camPosition: 'top' | 'bottom'; camShare: number; fitCam?: boolean };
  /** The user's PNG logo and where it goes; only the FFmpeg export draws it. */
  watermark?: WatermarkSettings | null;
  /** Cut pauses and fillers before rendering. */
  speechCleanup?: boolean;
  removeFillers?: boolean;
  subtitleOverrides?: {
    scale?: number;
    base?: string;
    highlight?: string;
    marginRatio?: number;
    /** Caption dragged to a specific spot, as fractions of the frame. */
    anchor?: { x: number; y: number };
  };
  /**
   * Every emoji the captions use, drawn by the browser as a base64 PNG and
   * keyed by the emoji itself. FFmpeg composites these over the frame, because
   * libass can only draw an emoji font's monochrome layer.
   */
  emojiImages?: Record<string, string>;
}

export class FfmpegUnavailable extends Error {}

/**
 * Renders the clip with FFmpeg on the local server and downloads the MP4.
 * Throws FfmpegUnavailable when the machine has no ffmpeg, so the caller can
 * fall back to the in-browser recorder.
 */
export async function exportClipOnServer(params: ServerExportParams): Promise<string> {
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (response.status === 501) {
    throw new FfmpegUnavailable('FFmpeg no está instalado en este equipo.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || `Error al exportar (${response.status}).`, response.status);
  }

  const blob = await response.blob();

  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const fileName = match ? match[1] : 'clip_viral.mp4';

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 3000);

  return fileName;
}

/**
 * Downloads and muxes a linked video locally, whatever the site.
 *
 * The download step is not optional: YouTube and most other sites no longer
 * serve progressive streams, so there is no URL a <video> element or FFmpeg
 * can consume directly. Once downloaded it behaves like an uploaded file.
 */
export async function prepareSourceVideo(
  url: string,
  onProgress?: (fraction: number) => void
): Promise<{ sourceId: string; duration: number | null }> {
  const { jobId } = await postJson<{ jobId: string }>('/api/source/prepare', { url });

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 600));

    const res = await fetch(`/api/source/prepare/${jobId}`);
    if (!res.ok) throw new ApiError('Se perdió el seguimiento de la descarga.', res.status);

    const job = (await res.json()) as {
      progress: number;
      done: boolean;
      sourceId?: string;
      duration?: number | null;
      error?: string;
    };

    onProgress?.(job.progress);

    if (job.done) {
      if (job.error) throw new ApiError(job.error, 502);
      if (!job.sourceId) throw new ApiError('La descarga terminó sin producir un archivo.', 502);
      return { sourceId: job.sourceId, duration: job.duration ?? null };
    }
  }
}

export async function fetchHealth(): Promise<HealthInfo | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}

/**
 * Asks the server for the exact webcam rectangle around a click.
 * Null when it found nothing convincing - the caller keeps its own box.
 */
export async function findWebcamBox(
  sourceId: string,
  time: number,
  x: number,
  y: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const response = await fetch('/api/webcam-box', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, time, x, y }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.box ?? null;
  } catch {
    return null;
  }
}
