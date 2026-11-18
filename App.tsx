import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  ClipIdea,
  SubtitleLine,
  SubtitleStyleType,
  AspectRatioType,
  AnalysisResponse,
  SourceVideoInfo,
  TranscriptSegment,
  SubtitleAnimationType,
  TranscriptionModeType,
  type FramingMode,
  type SpeakerRegion,
  type GameplayLayout,
  DEFAULT_GAMEPLAY_LAYOUT,
  type WatermarkSettings,
} from './types';
import { Navbar } from './components/Navbar';
import { VideoInput } from './components/VideoInput';
import { VideoPlayer } from './components/VideoPlayer';
import { SuggestedClipsList } from './components/SuggestedClipsList';
import { SubtitleEditor } from './components/SubtitleEditor';
import { ViralStrategyPanel } from './components/ViralStrategyPanel';
import { ExportModal } from './components/ExportModal';
import { FramingPicker } from './components/FramingPicker';
import { SpeakerPicker } from './components/SpeakerPicker';
import { GameplayLayoutPicker } from './components/GameplayLayoutPicker';
import { WatermarkPicker } from './components/WatermarkPicker';
import { EngineStatus } from './components/EngineStatus';
import { Sparkles, Film, FileText, Share2, AlertCircle, Loader2, PlayCircle, SquarePlay, CheckCircle2 } from 'lucide-react';
import {
  analyzeVideoJob,
  uploadSource,
  fetchHealth,
  AnalysisCancelled,
  type HealthInfo,
} from './api-client';

export const App: React.FC = () => {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [contextNotes, setContextNotes] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  // YouTube Specific State
  const [isYouTube, setIsYouTube] = useState<boolean>(false);
  const [youtubeInfo, setYoutubeInfo] = useState<SourceVideoInfo | null>(null);
  const [youtubeTranscript, setYoutubeTranscript] = useState<TranscriptSegment[] | null>(null);

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisStep, setAnalysisStep] = useState<string>('');
  const [clipIdeas, setClipIdeas] = useState<ClipIdea[]>([]);
  const [videoSummary, setVideoSummary] = useState<string>('');
  const [selectedClip, setSelectedClip] = useState<ClipIdea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);

  /**
   * How long Whisper will take on this machine, in words.
   *
   * The old label was a flat `duration x 1.2`, which announced "~76 min" for a
   * one-hour video that this GPU gets through in about two. People were being
   * scared off the good transcription by a number nobody had measured. The
   * server now reports its real throughput, and says whether that figure comes
   * from an actual run here or is still the cautious default.
   */
  const whisperEta = useMemo(() => {
    const speed = health?.whisperSpeed;
    if (!speed || speed <= 0 || videoDuration <= 0) return 'Tiempos exactos';

    const seconds = videoDuration / speed;
    const texto =
      seconds < 90
        ? `~${Math.max(5, Math.round(seconds / 5) * 5)} seg`
        : `~${Math.max(2, Math.round(seconds / 60))} min`;

    // Until a real run has happened the number is a guess, and saying so is
    // cheaper than being wrong twice.
    return health?.whisperSpeedMeasured ? texto : `${texto} aprox.`;
  }, [health?.whisperSpeed, health?.whisperSpeedMeasured, videoDuration]);
  const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionModeType>('whisper');
  /**
   * Spoken language, or 'auto'.
   *
   * Auto now votes on samples taken across the whole file instead of trusting
   * the first 30 seconds, but it is still a guess. A Spanish TV show came back
   * transcribed in Arabic because of the music over its opening titles, and
   * that does not only ruin the captions - the clip finder then matches
   * Spanish hook phrases against the wrong alphabet and the model is asked to
   * judge gibberish. One wrong guess wastes the whole run, so there is a way
   * to say it outright.
   */
  const [language, setLanguage] = useState('auto');
  /** Clips already delivered for the loaded video, from lib/clip-history.ts. */
  const [deliveredCount, setDeliveredCount] = useState<number | null>(null);
  const [allowRepeats, setAllowRepeats] = useState(false);

  // Editor & Player State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [previewTimestampTrigger, setPreviewTimestampTrigger] = useState<number>(0);
  const [currentSubtitles, setCurrentSubtitles] = useState<SubtitleLine[]>([]);
  const [currentSubtitleStyle, setCurrentSubtitleStyle] = useState<SubtitleStyleType>(SubtitleStyleType.PILL);
  const [subtitleAnimation, setSubtitleAnimation] = useState<SubtitleAnimationType>('word-pop');
  const [aspectRatio, setAspectRatio] = useState<AspectRatioType>('9:16');
  const [activeTab, setActiveTab] = useState<'clips' | 'subtitles' | 'strategy'>('clips');

  // Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  /**
   * How the wide source becomes a vertical clip, and the regions it needs.
   *
   * Kept here, not in the export dialog, because it is a decision about the
   * clip rather than about the file being written - and because inside that
   * dialog, under a tab and below the fold, nobody found it. The user asked
   * for the reframing choice "before processing them", which is this screen.
   */
  const [framingMode, setFramingMode] = useState<FramingMode>('blur-fill');
  const [speakers, setSpeakers] = useState<SpeakerRegion[]>([]);
  const [gameplayLayout, setGameplayLayout] = useState<GameplayLayout>(DEFAULT_GAMEPLAY_LAYOUT);

  /**
   * The user's logo, kept in this browser between sessions: it is a brand
   * mark, set once and expected on every clip from then on. Storage can be
   * full or blocked, so reading and writing it never break the app.
   */
  const [watermark, setWatermark] = useState<WatermarkSettings | null>(() => {
    try {
      const saved = localStorage.getItem('extractor.watermark');
      return saved ? (JSON.parse(saved) as WatermarkSettings) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (watermark) localStorage.setItem('extractor.watermark', JSON.stringify(watermark));
      else localStorage.removeItem('extractor.watermark');
    } catch {
      // Too big for storage: it still applies this session, it just will not
      // be remembered next time.
    }
  }, [watermark]);

  // How many clips of this video were already delivered. Re-checked whenever
  // a video is loaded and after each analysis, which adds to the count.
  useEffect(() => {
    if (!sourceId || !videoDuration) {
      setDeliveredCount(null);
      return;
    }
    let cancelled = false;
    fetch('/api/clip-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, duration: videoDuration }),
    })
      .then((r) => r.json())
      .then((data: { delivered?: number }) => {
        if (!cancelled) setDeliveredCount(data.delivered ?? 0);
      })
      .catch(() => {
        if (!cancelled) setDeliveredCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, videoDuration, clipIdeas.length]);

  const forgetDelivered = () => {
    if (!sourceId || !videoDuration) return;
    fetch('/api/clip-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, duration: videoDuration, clear: true }),
    })
      .then(() => setDeliveredCount(0))
      .catch(() => {});
  };

  const [exportingClip, setExportingClip] = useState<ClipIdea | null>(null);

  useEffect(() => {
    fetchHealth().then(setHealth);
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  // Held so the cancel button can abort a transcription that may run for
  // minutes; aborting also tells the server to kill the whisper process.
  const analysisAbortRef = useRef<AbortController | null>(null);

  // Local / Direct Video Loader
  const handleVideoLoad = (src: string, file?: File, notes?: string) => {
    setIsYouTube(false);
    setYoutubeInfo(null);
    setYoutubeTranscript(null);
    setTranscriptionMode('whisper');
    setVideoSrc(src);

    setSourceId(null);

    if (file) {
      setVideoFile(file);
      setFileName(file.name);

      // FFmpeg needs a real file on disk, so hand the server a copy now rather
      // than making the user wait for it at export time.
      setUploadProgress(0);
      uploadSource(file, (fraction) => setUploadProgress(fraction))
        .then((result) => {
          setSourceId(result.sourceId);
          setUploadProgress(null);
        })
        .catch((err) => {
          // Not fatal: the browser export engine still works without this.
          console.warn('No se pudo preparar el video para FFmpeg:', err);
          setUploadProgress(null);
        });
    } else {
      setVideoFile(null);
      setFileName(src.split('/').pop() || 'Video');
    }

    if (notes) setContextNotes(notes);
    setClipIdeas([]);
    setSelectedClip(null);
    setVideoSummary('');
    setError(null);
    setActiveTab('clips');
  };

  // YouTube Video Loader
  const handleLinkLoad = (source: SourceVideoInfo, notes?: string) => {
    // The video has already been downloaded and muxed locally, so it plays
    // through the normal HTML5 path: subtitle overlay, frame-accurate scrubbing
    // and real audio extraction, none of which an embedded player allows. The
    // metadata and any captions are kept for the analysis call.
    setIsYouTube(false);
    setYoutubeInfo(source);
    setYoutubeTranscript(source.transcript || null);
    setTranscriptionMode(source.transcript && source.transcript.length > 0 ? 'captions' : 'whisper');
    setVideoSrc(source.streamUrl || source.url);
    setSourceId((source as SourceVideoInfo & { sourceId?: string }).sourceId || null);
    setVideoFile(null);
    setFileName(source.title || `Video de ${source.site}`);
    if (source.duration) {
      setVideoDuration(source.duration);
    }
    if (notes) setContextNotes(notes);

    setClipIdeas([]);
    setSelectedClip(null);
    setVideoSummary('');
    setError(null);
    setActiveTab('clips');
  };

  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const video = event.currentTarget as HTMLVideoElement;
    if (video.duration && video.duration > 0 && video.duration !== Infinity) {
      setVideoDuration(video.duration);
      setError(null);
    } else {
      setVideoDuration(0);
    }
  };

  const handleVideoError = () => {
    if (!isYouTube) {
      setError('No se pudo reproducir este video. La URL podría tener restricciones CORS o el formato no es compatible. Prueba subiendo el archivo directamente.');
    }
  };

  const handleAnalyzeVideo = async () => {
    if (!videoSrc) {
      setError('Por favor carga un video primero.');
      return;
    }
    if (!sourceId) {
      setError('El video todavía se está preparando. Espera a que termine la barra de progreso.');
      return;
    }

    const duration = youtubeInfo?.duration || videoRef.current?.duration || videoDuration;
    if (!duration || duration <= 0) {
      setError('Esperando los metadatos de duración del video...');
      return;
    }

    const controller = new AbortController();
    analysisAbortRef.current = controller;

    setIsAnalyzing(true);
    setError(null);
    setAnalysisStep('Preparando el análisis...');

    try {
      const data = await analyzeVideoJob<AnalysisResponse>(
        {
          sourceId,
          duration,
          contextNotes,
          transcript: youtubeTranscript,
          transcriptionMode,
          language,
          allowRepeats,
        },
        ({ stage, progress }) =>
          setAnalysisStep(progress > 0 && progress < 1 ? `${stage} ${Math.round(progress * 100)}%` : stage),
        controller.signal
      );

      if (data?.suggestedClips?.length) {
        setClipIdeas(data.suggestedClips);
        setVideoSummary(data.summary || '');
        handleSelectClip(data.suggestedClips[0]);
        setActiveTab('clips');
      } else {
        throw new Error('No se detectaron momentos destacables en este video.');
      }
    } catch (err: any) {
      // A cancellation is the user's own doing, not a failure to report.
      if (!(err instanceof AnalysisCancelled)) {
        console.error('Error analizando el video:', err);
        setError(err.message || 'Error inesperado durante el análisis.');
      }
    } finally {
      analysisAbortRef.current = null;
      setIsAnalyzing(false);
      setAnalysisStep('');
    }
  };

  const handleSelectClip = (clip: ClipIdea) => {
    setSelectedClip(clip);
    setCurrentSubtitles(clip.suggestedSubtitles || []);
    setPreviewTimestampTrigger(Date.now());
  };

  const handlePreviewClip = (clip: ClipIdea) => {
    // If clicking on the currently selected clip and it's already playing, pause it
    if (selectedClip?.clipId === clip.clipId && isPlaying) {
      if (!isYouTube && videoRef.current) {
        videoRef.current.pause();
      }
      setIsPlaying(false);
      return;
    }

    // Select the clip, set subtitles, and trigger immediate playback
    setSelectedClip(clip);
    setCurrentSubtitles(clip.suggestedSubtitles || []);
    setPreviewTimestampTrigger(Date.now());

    // On mobile or smaller viewports, smoothly scroll the video player into view
    const playerEl = document.getElementById('main-video-player-component');
    if (playerEl && window.innerWidth < 1024) {
      playerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const handleAdjustClipTimes = (newStart: number, newEnd: number) => {
    if (!selectedClip) return;

    // Subtitle times are relative to the clip start, so moving the start point
    // has to shift every line by the same delta. Without this, trimming the
    // clip leaves the subtitles running ahead of or behind the speech.
    const startDelta = newStart - selectedClip.startTimeSeconds;
    const newDuration = Math.max(0.5, newEnd - newStart);

    const shiftSubtitles = (lines: SubtitleLine[]): SubtitleLine[] =>
      lines
        .map((line) => ({
          ...line,
          startTime: Math.round((line.startTime - startDelta) * 10) / 10,
          endTime: Math.round((line.endTime - startDelta) * 10) / 10,
        }))
        // Drop lines that the new trim pushed outside the clip entirely.
        .filter((line) => line.endTime > 0 && line.startTime < newDuration)
        .map((line) => ({
          ...line,
          startTime: Math.max(0, line.startTime),
          endTime: Math.min(newDuration, line.endTime),
        }))
        .filter((line) => line.endTime > line.startTime);

    const updated = {
      ...selectedClip,
      startTimeSeconds: newStart,
      endTimeSeconds: newEnd,
      suggestedSubtitles: shiftSubtitles(selectedClip.suggestedSubtitles || []),
    };

    setSelectedClip(updated);
    setCurrentSubtitles((prev) => shiftSubtitles(prev));
    setClipIdeas((prev) => prev.map((c) => (c.clipId === updated.clipId ? updated : c)));
  };

  const handleOpenExportModal = (clip: ClipIdea) => {
    setExportingClip(clip);
    if (!currentSubtitles || currentSubtitles.length === 0 || selectedClip?.clipId !== clip.clipId) {
      setCurrentSubtitles(clip.suggestedSubtitles || []);
    }
    setIsExportModalOpen(true);
  };

  const handleReset = () => {
    setVideoSrc(null);
    setVideoFile(null);
    setIsYouTube(false);
    setYoutubeInfo(null);
    setYoutubeTranscript(null);
    setVideoDuration(0);
    setClipIdeas([]);
    setSelectedClip(null);
    setVideoSummary('');
    setError(null);
    setActiveTab('clips');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      {/* Top Navigation */}
      <Navbar
        onReset={handleReset}
        hasVideo={!!videoSrc}
        isAnalyzing={isAnalyzing}
        engine={
          health
            ? { gpu: health.whisperBackend === 'gpu', model: health.ollamaModel }
            : null
        }
      />

      {/* Main Workspace Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        {!videoSrc ? (
          /* Step 1: Upload / Load Video View */
          <div className="max-w-3xl mx-auto py-4 sm:py-8 space-y-4 animate-in fade-in duration-300">
            {/* What this machine can actually do. Replaces a marketing hero
                that sold the app to the only person who already owns it, and
                surfaces the degradations that were otherwise invisible. */}
            <EngineStatus health={health} />

            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-2xl">
              <VideoInput
                key={health ? 'ready' : 'loading'}
                onVideoLoad={handleVideoLoad}
                onLinkLoad={handleLinkLoad}
                disabled={isAnalyzing}
                linksEnabled={health?.linksEnabled ?? false}
                watermark={watermark}
                onWatermarkChange={setWatermark}
              />
            </div>
          </div>
        ) : (
          /* Step 2: Main Interactive Video Studio (2 Columns) */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-in fade-in duration-300">
            {/* Left Column: Video Player & Control Engine (7 cols) */}
            <div className="lg:col-span-7 space-y-4">
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-2xl space-y-4">
                {/* Header Information for the loaded video */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 truncate pr-2">
                    {isYouTube ? (
                      <SquarePlay className="w-4 h-4 text-rose-500 shrink-0" />
                    ) : (
                      <Film className="w-4 h-4 text-indigo-400 shrink-0" />
                    )}
                    <span className="text-sm font-bold text-white truncate max-w-xs sm:max-w-md">
                      {fileName || 'Video Cargado'}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    {youtubeTranscript && youtubeTranscript.length > 0 && (
                      <span className="text-[11px] text-emerald-400 bg-emerald-950/60 border border-emerald-800 px-2 py-0.5 rounded-md flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Transcripción detectada</span>
                      </span>
                    )}
                    {videoDuration > 0 && (
                      <span className="text-xs text-slate-400 font-mono bg-slate-950 px-2.5 py-1 rounded-md border border-slate-800">
                        {Math.round(videoDuration)}s total
                      </span>
                    )}
                  </div>
                </div>

                {/* Dual Engine Video Player (YouTube or HTML5) */}
                <VideoPlayer
                  videoRef={videoRef}
                  src={videoSrc}
                  isYouTube={isYouTube}
                  subtitles={currentSubtitles}
                  currentSubtitleStyle={currentSubtitleStyle}
                  subtitleAnimation={subtitleAnimation}
                  selectedClip={selectedClip}
                  aspectRatio={aspectRatio}
                  onAspectRatioChange={setAspectRatio}
                  onLoadedMetadata={handleLoadedMetadata}
                  onVideoError={handleVideoError}
                  onAdjustClipTimes={handleAdjustClipTimes}
                  initialDuration={videoDuration}
                  onPlaybackStateChange={setIsPlaying}
                  previewTimestampTrigger={previewTimestampTrigger}
                />

                {/* Reframing, where the user asked for it: before processing,
                    not inside the export dialog. Only once a clip is picked,
                    since that is when there is something to reframe and a
                    frame to mark a face on. */}
                {selectedClip && (
                  <div className="bg-slate-950 border border-indigo-500/30 rounded-xl p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white">
                        Cómo encuadrar el clip en vertical
                      </span>
                      <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 font-semibold border border-indigo-500/20">
                        Se aplica al exportar
                      </span>
                    </div>

                    <FramingPicker
                      value={framingMode}
                      onChange={setFramingMode}
                      markedRegions={speakers.length}
                    />

                    {(framingMode === 'focus' ||
                      framingMode === 'split' ||
                      framingMode === 'auto-fill' ||
                      framingMode === 'gameplay') && (
                      <div className="pt-1">
                        <SpeakerPicker
                          videoSrc={videoSrc}
                          previewTime={selectedClip.startTimeSeconds}
                          mode={framingMode}
                          regions={speakers}
                          onChange={setSpeakers}
                          sourceId={sourceId}
                        />
                        {framingMode === 'gameplay' && (
                          <div className="pt-3">
                            <GameplayLayoutPicker
                              value={gameplayLayout}
                              onChange={setGameplayLayout}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* The logo applies to every clip, so it does not wait for one
                    to be selected. */}
                {clipIdeas.length > 0 && (
                  <div className="bg-slate-950 border border-indigo-500/30 rounded-xl p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-white">Marca de agua</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 font-semibold border border-indigo-500/20">
                        {watermark ? 'Activada en todos los clips' : 'Opcional'}
                      </span>
                    </div>
                    <WatermarkPicker value={watermark} onChange={setWatermark} />
                  </div>
                )}

                {/* Spoken language. Always offered: auto-detection is the
                    thing that failed, so hiding the override behind a
                    condition would hide it exactly when it is needed. */}
                {clipIdeas.length === 0 && (
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex items-center gap-3">
                    <span className="text-xs font-bold text-slate-200 shrink-0">
                      Idioma del audio
                    </span>
                    <select
                      value={language}
                      onChange={(event) => setLanguage(event.target.value)}
                      disabled={isAnalyzing}
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white disabled:opacity-40 focus:border-indigo-500 focus:outline-none"
                    >
                      <option value="auto">Detectar solo</option>
                      <option value="es">Español</option>
                      <option value="en">Inglés</option>
                      <option value="pt">Portugués</option>
                      <option value="fr">Francés</option>
                      <option value="it">Italiano</option>
                      <option value="de">Alemán</option>
                    </select>
                  </div>
                )}

                {/* Clips of this same video handed out before. Each upload
                    skips them, so sending the video again brings new clips
                    instead of the same ten. */}
                {clipIdeas.length === 0 && deliveredCount !== null && deliveredCount > 0 && (
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
                    <p className="text-xs text-slate-300 leading-snug">
                      De este video ya te di <span className="font-bold text-white">{deliveredCount} clips</span>.
                      {allowRepeats
                        ? ' Esta vez pueden volver a salir.'
                        : ' Este análisis te dará otros distintos.'}
                    </p>
                    <div className="flex items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allowRepeats}
                          onChange={(event) => setAllowRepeats(event.target.checked)}
                          disabled={isAnalyzing}
                          className="accent-indigo-500"
                        />
                        Repetir clips ya entregados
                      </label>
                      <button
                        type="button"
                        onClick={forgetDelivered}
                        disabled={isAnalyzing}
                        className="text-[11px] text-slate-400 hover:text-white underline disabled:opacity-40"
                      >
                        Empezar de cero con este video
                      </button>
                    </div>
                  </div>
                )}

                {/* Transcript source, only a real choice when captions exist */}
                {clipIdeas.length === 0 && youtubeTranscript && youtubeTranscript.length > 0 && (
                  <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
                    <span className="text-xs font-bold text-slate-200 block">
                      ¿De dónde saco el texto?
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTranscriptionMode('captions')}
                        disabled={isAnalyzing}
                        className={`p-2.5 rounded-lg border text-left transition-all ${
                          transcriptionMode === 'captions'
                            ? 'bg-indigo-600/20 border-indigo-500 ring-1 ring-indigo-500'
                            : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <span className="block text-xs font-bold text-white">
                          Subtítulos de YouTube
                        </span>
                        <span className="block text-[10px] text-emerald-400 font-semibold">
                          Al instante
                        </span>
                        <span className="block text-[10px] text-slate-400 mt-0.5 leading-snug">
                          Tiempos por frase. Sin marcas de risas.
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setTranscriptionMode('whisper')}
                        disabled={isAnalyzing || !health?.whisperAvailable}
                        className={`p-2.5 rounded-lg border text-left transition-all disabled:opacity-40 ${
                          transcriptionMode === 'whisper'
                            ? 'bg-indigo-600/20 border-indigo-500 ring-1 ring-indigo-500'
                            : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <span className="block text-xs font-bold text-white">
                          Transcribir con Whisper
                        </span>
                        <span className="block text-[10px] text-emerald-400 font-semibold">
                          {whisperEta}
                        </span>
                        <span className="block text-[10px] text-slate-400 mt-0.5 leading-snug">
                          Tiempos por palabra y detecta risas.
                        </span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Main Action Button: run the local analysis */}
                {clipIdeas.length === 0 && (
                  <button
                    type="button"
                    id="analyze-video-btn"
                    onClick={handleAnalyzeVideo}
                    disabled={isAnalyzing || (!isYouTube && videoDuration === 0)}
                    className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-indigo-600 via-purple-600 to-rose-600 hover:from-indigo-500 hover:to-rose-500 text-white font-bold text-sm shadow-xl shadow-indigo-600/25 transition-all flex items-center justify-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span>{analysisStep || 'Analizando con IA...'}</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5 text-amber-300" />
                        <span>Analizar Video y Extraer Clips Virales</span>
                      </>
                    )}
                  </button>
                )}

                {isAnalyzing && (
                  <button
                    type="button"
                    onClick={() => analysisAbortRef.current?.abort()}
                    className="w-full py-2 rounded-xl border border-rose-800 bg-rose-950/50 text-rose-200 text-xs font-semibold hover:bg-rose-950 transition-colors"
                  >
                    Cancelar análisis
                  </button>
                )}

                {/* Uploading the source for FFmpeg */}
                {uploadProgress !== null && (
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-300 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span>Preparando el video para exportar...</span>
                      <span className="font-mono text-slate-400">
                        {Math.round(uploadProgress * 100)}%
                      </span>
                    </div>
                    <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all"
                        style={{ width: `${uploadProgress * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Error Banner */}
                {error && (
                  <div className="p-3.5 bg-rose-950/80 border border-rose-800 rounded-xl text-rose-200 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="flex items-start space-x-2">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{error}</span>
                    </div>
                    <div className="flex items-center space-x-2 shrink-0 self-end sm:self-center">
                      <button
                        type="button"
                        onClick={handleAnalyzeVideo}
                        disabled={isAnalyzing}
                        className="px-3 py-1 bg-rose-850 hover:bg-rose-750 border border-rose-700 text-white font-medium rounded-lg text-xs transition-colors"
                      >
                        Reintentar
                      </button>
                      <button
                        type="button"
                        onClick={() => setError(null)}
                        className="text-rose-400 hover:text-white text-xs px-1.5 py-1"
                      >
                        Cerrar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Column: AI Tabs & Tools (5 cols) */}
            <div className="lg:col-span-5 space-y-4">
              {/* Tab Navigation if clips are generated */}
              {clipIdeas.length > 0 && (
                <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800">
                  <button
                    type="button"
                    id="tab-clips-btn"
                    onClick={() => setActiveTab('clips')}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center space-x-1.5 ${
                      activeTab === 'clips'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Film className="w-3.5 h-3.5" />
                    <span>Clips ({clipIdeas.length})</span>
                  </button>

                  <button
                    type="button"
                    id="tab-strategy-btn"
                    onClick={() => setActiveTab('strategy')}
                    disabled={!selectedClip}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center space-x-1.5 ${
                      activeTab === 'strategy'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 disabled:opacity-40'
                    }`}
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>Estrategia Viral</span>
                  </button>

                  <button
                    type="button"
                    id="tab-subtitles-btn"
                    onClick={() => setActiveTab('subtitles')}
                    disabled={!selectedClip}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center space-x-1.5 ${
                      activeTab === 'subtitles'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200 disabled:opacity-40'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>Subtítulos</span>
                  </button>
                </div>
              )}

              {/* Tab Content Panels */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-2xl">
                {isAnalyzing ? (
                  <div className="py-16 text-center space-y-4">
                    <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                      <Sparkles className="w-7 h-7 animate-spin" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white">Analizando el contenido en tu equipo</h3>
                      <p className="text-xs text-slate-400 mt-1">{analysisStep || 'Procesando narrativa y ganchos de retención...'}</p>
                    </div>
                  </div>
                ) : clipIdeas.length === 0 ? (
                  <div className="py-12 text-center space-y-3">
                    <PlayCircle className="w-12 h-12 text-slate-600 mx-auto" />
                    <h3 className="text-sm font-bold text-slate-300">Listo para Analizar</h3>
                    <p className="text-xs text-slate-400 max-w-xs mx-auto">
                      Haz clic en "Analizar Video" para descubrir los momentos con mayor potencial de retención y viralidad.
                    </p>
                  </div>
                ) : activeTab === 'clips' ? (
                  <SuggestedClipsList
                    clips={clipIdeas}
                    summary={videoSummary}
                    selectedClipId={selectedClip?.clipId || null}
                    isPlaying={isPlaying}
                    onSelectClip={handleSelectClip}
                    onPreviewClip={handlePreviewClip}
                    onOpenViralStrategy={(clip) => {
                      handleSelectClip(clip);
                      setActiveTab('strategy');
                    }}
                    onOpenSubtitleEditor={(clip) => {
                      handleSelectClip(clip);
                      setActiveTab('subtitles');
                    }}
                    onOpenExportModal={handleOpenExportModal}
                    sourceId={sourceId}
                    exportEngine={health?.exportEngine ?? 'browser'}
                    subtitleStyle={currentSubtitleStyle}
                    subtitleAnimation={subtitleAnimation}
                    aspectRatio={aspectRatio}
                    framingMode={framingMode}
                    speakers={speakers}
                    gameplayLayout={gameplayLayout}
                    watermark={watermark}
                  />
                ) : activeTab === 'strategy' && selectedClip ? (
                  <ViralStrategyPanel
                    clip={selectedClip}
                    onBack={() => setActiveTab('clips')}
                  />
                ) : activeTab === 'subtitles' && selectedClip ? (
                  <SubtitleEditor
                    clip={selectedClip}
                    subtitles={currentSubtitles}
                    currentStyle={currentSubtitleStyle}
                    onStyleChange={setCurrentSubtitleStyle}
                    onSubtitlesChange={setCurrentSubtitles}
                    onBack={() => setActiveTab('clips')}
                    videoFile={videoFile}
                    videoSrc={videoSrc}
                    isYouTube={isYouTube}
                    sourceId={sourceId}
                    onPreviewAtTime={(relSec) => {
                      if (!isYouTube && videoRef.current && selectedClip) {
                        videoRef.current.currentTime = selectedClip.startTimeSeconds + relSec;
                        videoRef.current.play().catch(() => {});
                        setIsPlaying(true);
                      }
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        )}
      </main>


      {/* Export & Render Modal */}
      {isExportModalOpen && exportingClip && (
        <ExportModal
          framingMode={framingMode}
          onFramingModeChange={setFramingMode}
          speakers={speakers}
          onSpeakersChange={setSpeakers}
          gameplayLayout={gameplayLayout}
          onGameplayLayoutChange={setGameplayLayout}
          watermark={watermark}
          onWatermarkChange={setWatermark}
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          clip={exportingClip}
          videoSrc={videoSrc}
          videoElement={videoRef.current}
          currentSubtitleStyle={currentSubtitleStyle}
          subtitles={currentSubtitles}
          isYouTube={isYouTube}
          totalVideoDuration={videoDuration}
          sourceId={sourceId}
          exportEngine={health?.exportEngine ?? 'browser'}
          currentAnimation={subtitleAnimation}
          onAnimationChange={setSubtitleAnimation}
        />
      )}
    </div>
  );
};

export default App;
