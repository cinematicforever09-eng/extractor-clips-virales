import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Download,
  Smartphone,
  Square,
  Monitor,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileText,
  Copy,
  Play,
  Pause,
  RotateCcw,
  Scissors,
  Layers,
  Move,
  SquarePlay,
  Maximize2,
  Eye,
  Wand2,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import {
  ClipIdea,
  SubtitleLine,
  SubtitleStyleType,
  AspectRatioType,
  FramingMode,
  SubtitleAnimationType,
  SpeakerRegion,
  GameplayLayout,
  WatermarkSettings,
} from '../types';
import { SpeakerPicker } from './SpeakerPicker';
import { GameplayLayoutPicker } from './GameplayLayoutPicker';
import { WatermarkPicker } from './WatermarkPicker';
import { FramingPicker } from './FramingPicker';
import { SUBTITLE_STYLES, SUBTITLE_ANIMATIONS } from '../constants';
import { renderAndExportVideo, downloadSrtFile, downloadVttFile, downloadSocialKit } from '../video-export';
import type { ExportResult } from '../video-export';
import { exportClipOnServer, FfmpegUnavailable } from '../api-client';
import { rasteriseEmojiFor } from '../lib/emoji-raster';
import { captionMetrics, clampAnchor } from '../lib/ass';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  clip: ClipIdea;
  videoSrc?: string | null;
  videoElement?: HTMLVideoElement | null;
  currentSubtitleStyle: SubtitleStyleType;
  subtitles: SubtitleLine[];
  isYouTube?: boolean;
  youtubeId?: string | null;
  totalVideoDuration?: number;
  /** Server-side handle for the uploaded video; null while it is still uploading. */
  sourceId?: string | null;
  /** What the backend reported it can do. */
  exportEngine?: 'ffmpeg' | 'browser';
  currentAnimation?: SubtitleAnimationType;
  onAnimationChange?: (animation: SubtitleAnimationType) => void;
  /**
   * Framing chosen in the main view, before opening this dialog.
   *
   * It lives there rather than here because it is a creative decision about
   * the clip, not an export setting - and because buried in this dialog
   * nobody found it. Owned by the parent so the choice survives closing the
   * dialog and is the same one the preview showed.
   */
  framingMode: FramingMode;
  onFramingModeChange: (mode: FramingMode) => void;
  speakers: SpeakerRegion[];
  onSpeakersChange: (regions: SpeakerRegion[]) => void;
  gameplayLayout: GameplayLayout;
  onGameplayLayoutChange: (layout: GameplayLayout) => void;
  watermark: WatermarkSettings | null;
  onWatermarkChange: (value: WatermarkSettings | null) => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  clip,
  videoSrc = null,
  videoElement = null,
  currentSubtitleStyle: initialSubtitleStyle,
  subtitles: initialSubtitles,
  isYouTube = false,
  youtubeId = null,
  totalVideoDuration = 0,
  sourceId = null,
  exportEngine = 'browser',
  currentAnimation = 'word-pop',
  onAnimationChange,
  framingMode,
  onFramingModeChange,
  speakers,
  onSpeakersChange,
  gameplayLayout,
  onGameplayLayoutChange,
  watermark,
  onWatermarkChange,
}) => {
  // Trimming State
  const [startTime, setStartTime] = useState<number>(clip.startTimeSeconds);
  const [endTime, setEndTime] = useState<number>(clip.endTimeSeconds);

  // Formatting & Reframing State
  const [activeTab, setActiveTab] = useState<'settings' | 'subtitles'>('settings');
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<AspectRatioType>('9:16');


  const [speechCleanup, setSpeechCleanup] = useState<boolean>(false);
  const [removeFillers, setRemoveFillers] = useState<boolean>(true);
  const [subScale, setSubScale] = useState<number>(1);
  const [subBase, setSubBase] = useState<string>('');
  const [subHighlight, setSubHighlight] = useState<string>('');
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleType>(initialSubtitleStyle || SubtitleStyleType.PILL);
  const [subtitlePosition, setSubtitlePosition] = useState<'bottom' | 'center' | 'top'>('bottom');
  /**
   * Where the caption was dragged to, as fractions of the frame, or null while
   * it still follows the top/centre/bottom preset. Normalised rather than in
   * pixels so the small on-screen preview and the 1080-wide export agree.
   */
  const [subAnchor, setSubAnchor] = useState<{ x: number; y: number } | null>(null);
  const [draggingCaption, setDraggingCaption] = useState<boolean>(false);
  const [subtitleAnimation, setSubtitleAnimation] = useState<SubtitleAnimationType>(currentAnimation);
  const [burnSubtitles, setBurnSubtitles] = useState<boolean>(true);
  const [activeSubtitles, setActiveSubtitles] = useState<SubtitleLine[]>(
    initialSubtitles && initialSubtitles.length > 0
      ? initialSubtitles
      : clip.suggestedSubtitles || []
  );

  // Preview Playback State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(clip.startTimeSeconds);
  const [currentSubText, setCurrentSubText] = useState<string>('');
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewBgVideoRef = useRef<HTMLVideoElement>(null);
  const previewFrameRef = useRef<HTMLDivElement>(null);

  // Export Progress State
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [exportComplete, setExportComplete] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [usedEngine, setUsedEngine] = useState<'ffmpeg' | 'browser' | null>(null);
  const [copiedCaption, setCopiedCaption] = useState<boolean>(false);

  // Reset or Sync on clip change
  useEffect(() => {
    setStartTime(clip.startTimeSeconds);
    setEndTime(clip.endTimeSeconds);
    setCurrentTime(clip.startTimeSeconds);
    setActiveSubtitles(
      initialSubtitles && initialSubtitles.length > 0
        ? initialSubtitles
        : clip.suggestedSubtitles || []
    );
    setExportComplete(false);
    setExportError(null);
    setIsExporting(false);
  }, [clip, initialSubtitles]);

  // Handle Video Time Update in Preview
  const handleTimeUpdate = useCallback(() => {
    if (!previewVideoRef.current) return;
    const cur = previewVideoRef.current.currentTime;
    setCurrentTime(cur);

    // Sync background video if present
    if (previewBgVideoRef.current && Math.abs(previewBgVideoRef.current.currentTime - cur) > 0.3) {
      previewBgVideoRef.current.currentTime = cur;
    }

    // Loop clip in preview
    if (cur >= endTime) {
      previewVideoRef.current.currentTime = startTime;
      if (previewBgVideoRef.current) previewBgVideoRef.current.currentTime = startTime;
      previewVideoRef.current.play().catch(() => {});
      return;
    }

    // Determine current subtitle text relative to clip start
    const relTime = cur - startTime;
    const foundSub = activeSubtitles.find(
      (s) => relTime >= s.startTime && relTime <= s.endTime
    );
    setCurrentSubText(foundSub ? foundSub.text : '');
  }, [startTime, endTime, activeSubtitles]);

  /**
   * Turns a pointer position into a normalised anchor inside the preview frame.
   *
   * Clamped to the same 5%-95% band the ASS writer enforces, so the caption
   * cannot be dragged somewhere the export would then quietly pull it back from.
   */
  const moveCaptionTo = useCallback(
    (clientX: number, clientY: number) => {
      const frame = previewFrameRef.current;
      if (!frame) return;

      const rect = frame.getBoundingClientRect();

      // Clamped with the export's own numbers, not the preview's: the caption
      // has to stop where the burned-in one would, or the user drags it
      // somewhere the render then quietly pulls it back from.
      const outWidth = selectedAspectRatio === '16:9' ? 1920 : 1080;
      const outHeight = selectedAspectRatio === '16:9' ? 1080 : selectedAspectRatio === '1:1' ? 1080 : 1920;
      const { fontSize } = captionMetrics(subtitleStyle, outWidth, outHeight, { scale: subScale });

      setSubAnchor(
        clampAnchor(
          { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height },
          activeSubtitles.reduce(
            (widest, line) => (line.text.length > widest.length ? line.text : widest),
            ''
          ),
          outWidth,
          fontSize,
          Math.round(60 * (outWidth / 1080))
        )
      );
    },
    [selectedAspectRatio, subtitleStyle, subScale, activeSubtitles]
  );

  // Listeners live on the window, not the caption: the pointer routinely runs
  // ahead of a dragged element, and a mouseup outside it would strand the drag.
  useEffect(() => {
    if (!draggingCaption) return;

    const move = (event: MouseEvent) => moveCaptionTo(event.clientX, event.clientY);
    const stop = () => setDraggingCaption(false);

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop, { once: true });
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [draggingCaption, moveCaptionTo]);

  // Toggle Preview Play / Pause
  const togglePlay = () => {
    if (!previewVideoRef.current) return;
    if (isPlaying) {
      previewVideoRef.current.pause();
      if (previewBgVideoRef.current) previewBgVideoRef.current.pause();
      setIsPlaying(false);
    } else {
      if (previewVideoRef.current.currentTime >= endTime || previewVideoRef.current.currentTime < startTime) {
        previewVideoRef.current.currentTime = startTime;
        if (previewBgVideoRef.current) previewBgVideoRef.current.currentTime = startTime;
      }
      previewVideoRef.current.play().then(() => {
        setIsPlaying(true);
        if (previewBgVideoRef.current) previewBgVideoRef.current.play().catch(() => {});
      }).catch(() => {});
    }
  };

  const handleSeek = (newTime: number) => {
    setCurrentTime(newTime);
    if (previewVideoRef.current) {
      previewVideoRef.current.currentTime = newTime;
    }
    if (previewBgVideoRef.current) {
      previewBgVideoRef.current.currentTime = newTime;
    }
  };

  // Adjust trim start
  const handleStartChange = (val: number) => {
    const clamped = Math.max(0, Math.min(val, endTime - 0.5));
    setStartTime(clamped);
    handleSeek(clamped);
  };

  // Adjust trim end
  const handleEndChange = (val: number) => {
    const maxDur = totalVideoDuration > 0 ? totalVideoDuration : 9999;
    const clamped = Math.min(maxDur, Math.max(val, startTime + 0.5));
    setEndTime(clamped);
  };

  // Subtitle Line Editing Handlers
  const handleEditSubtitleText = (index: number, newText: string) => {
    setActiveSubtitles((prev) =>
      prev.map((sub, i) => (i === index ? { ...sub, text: newText } : sub))
    );
  };

  const handleEditSubtitleTimes = (index: number, start: number, end: number) => {
    setActiveSubtitles((prev) =>
      prev.map((sub, i) => (i === index ? { ...sub, startTime: start, endTime: end } : sub))
    );
  };

  const handleAddSubtitleLine = () => {
    const lastSub = activeSubtitles[activeSubtitles.length - 1];
    const newStart = lastSub ? Math.round((lastSub.endTime + 0.2) * 10) / 10 : 0;
    const newEnd = Math.round((newStart + 2.5) * 10) / 10;
    setActiveSubtitles((prev) => [
      ...prev,
      { text: 'Nueva frase de subtítulo', startTime: newStart, endTime: newEnd },
    ]);
  };

  const handleDeleteSubtitleLine = (index: number) => {
    setActiveSubtitles((prev) => prev.filter((_, i) => i !== index));
  };

  const duration = Math.max(0.5, endTime - startTime);

  // START EXPORT & DOWNLOAD PROCESS
  const handleStartExport = async () => {
    setIsExporting(true);
    setExportError(null);
    setExportComplete(false);
    setExportResult(null);
    setUsedEngine(null);
    setProgress(0.05);
    setStatusMessage('Configurando motor de renderizado y reencuadre...');

    try {
      // Prefer FFmpeg on the local server: it produces a real MP4 with audio,
      // faster than real time, and is unaffected by the tab losing focus. The
      // browser recorder stays as the fallback for machines without FFmpeg.
      if (exportEngine === 'ffmpeg' && sourceId) {
        try {
          setStatusMessage('Renderizando con FFmpeg...');
          setProgress(0.25);

          const fileName = await exportClipOnServer({
            sourceId,
            clipTitle: clip.title,
            startSeconds: startTime,
            durationSeconds: duration,
            aspectRatio: selectedAspectRatio,
            framingMode,
            subtitles: activeSubtitles,
            subtitleStyle,
            subtitlePosition,
            subtitleAnimation,
            burnSubtitles,
            speakers,
            gameplayLayout,
            watermark,
            speechCleanup,
            removeFillers,
            subtitleOverrides: {
              scale: subScale,
              ...(subBase ? { base: subBase } : {}),
              ...(subHighlight ? { highlight: subHighlight } : {}),
              ...(subAnchor ? { anchor: subAnchor } : {}),
            },
            // Drawn here, in the browser, because no caption font carries
            // colour emoji - see lib/emoji-raster.ts. Only the emoji actually
            // used are rasterised, so a clip with none sends nothing.
            emojiImages: burnSubtitles ? rasteriseEmojiFor(activeSubtitles) : undefined,
          });

          setProgress(1);
          setStatusMessage('¡Exportación completada!');
          setUsedEngine('ffmpeg');
          setExportResult({
            container: 'mp4',
            hasAudio: true,
            fileName,
            durationSeconds: duration,
          });
          setExportComplete(true);
          try {
            confetti({ particleCount: 100, spread: 80, origin: { y: 0.6 } });
          } catch {
            /* decorative only */
          }
          return;
        } catch (serverErr) {
          if (!(serverErr instanceof FfmpegUnavailable)) throw serverErr;
          // Fall through to the browser engine.
          setStatusMessage('FFmpeg no disponible, grabando desde el navegador...');
        }
      }

      const targetVideoSource = videoSrc || previewVideoRef.current || videoElement;

      const result = await renderAndExportVideo({
        videoSource: targetVideoSource,
        clipTitle: clip.title,
        startTime,
        endTime,
        aspectRatio: selectedAspectRatio,
        framingMode,
        subtitleStyle,
        subtitles: activeSubtitles,
        burnSubtitles,
        subtitlePosition,
        subtitleAnimation,
        onProgress: (prog, msg) => {
          setProgress(prog);
          setStatusMessage(msg);
        },
      });

      setUsedEngine('browser');
      setExportResult(result);
      setExportComplete(true);
      try {
        confetti({
          particleCount: 100,
          spread: 80,
          origin: { y: 0.6 },
        });
      } catch (_) {}

    } catch (err: any) {
      console.error('Error during video export:', err);
      setExportError(err.message || 'Error inesperado durante la exportación del video.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadSrt = () => {
    downloadSrtFile(activeSubtitles, `subtitulos_${clip.title}`);
  };

  const handleDownloadVtt = () => {
    downloadVttFile(activeSubtitles, `subtitulos_${clip.title}`);
  };

  const handleDownloadSocialKit = () => {
    downloadSocialKit({
      ...clip,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      suggestedSubtitles: activeSubtitles,
    });
  };

  const copyPostToClipboard = () => {
    const text = `${clip.hook}\n\n${clip.description}\n\n${(clip.socialPost?.hashtags || []).join(' ')}`;
    navigator.clipboard.writeText(text);
    setCopiedCaption(true);
    setTimeout(() => setCopiedCaption(false), 2500);
  };

  const activeStyleConfig = SUBTITLE_STYLES.find((s) => s.id === subtitleStyle) || SUBTITLE_STYLES[0];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/85 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-5xl overflow-hidden shadow-2xl my-auto relative flex flex-col max-h-[92vh]">
        
        {/* MODAL HEADER */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/80 shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-rose-500 flex items-center justify-center text-white shadow-md">
              <Download className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <span>Estudio de Recorte, Reencuadre & Exportación</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold border border-indigo-500/30">
                  {clip.viralityScore}/100 Viral
                </span>
              </h2>
              <p className="text-xs text-slate-400 truncate max-w-md sm:max-w-xl">
                {clip.title}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* MODAL BODY */}
        <div className="p-4 sm:p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* LEFT COLUMN: LIVE REFRAMED PREVIEW & VIDEO SCRUBBER */}
          <div className="lg:col-span-5 flex flex-col items-center space-y-3.5 bg-slate-950/70 p-4 rounded-2xl border border-slate-800/80">
            <div className="w-full flex items-center justify-between">
              <span className="text-xs font-bold text-white flex items-center space-x-1.5">
                <Eye className="w-3.5 h-3.5 text-indigo-400" />
                <span>Previsualización en Vivo ({selectedAspectRatio})</span>
              </span>
              <span className="text-[11px] font-mono font-semibold text-emerald-400 bg-emerald-950/60 px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                {duration.toFixed(1)}s duración
              </span>
            </div>

            {/* PREVIEW FRAME (Responsive Aspect Ratio Simulation with Reframing) */}
            <div
              ref={previewFrameRef}
              className={`relative bg-black rounded-2xl overflow-hidden shadow-2xl border border-slate-700/80 flex items-center justify-center transition-all ${
                selectedAspectRatio === '9:16'
                  ? 'w-[240px] sm:w-[270px] h-[426px] sm:h-[480px]'
                  : selectedAspectRatio === '1:1'
                  ? 'w-[280px] sm:w-[320px] h-[280px] sm:h-[320px]'
                  : 'w-full max-w-[420px] h-[236px]'
              }`}
            >
              {/* HTML5 Video Player for Local / Direct files */}
              {videoSrc ? (
                <div className="w-full h-full relative overflow-hidden flex items-center justify-center">
                  
                  {/* Dynamic Blurred Background Layer when in 9:16 or 1:1 with blur-fill */}
                  {(selectedAspectRatio === '9:16' || selectedAspectRatio === '1:1') && framingMode === 'blur-fill' && (
                    <video
                      ref={previewBgVideoRef}
                      src={videoSrc}
                      className="absolute inset-0 w-full h-full object-cover scale-150 filter blur-xl opacity-45 pointer-events-none"
                      muted
                      playsInline
                    />
                  )}

                  {/* Main Sharp Video Layer */}
                  <video
                    ref={previewVideoRef}
                    src={videoSrc}
                    className={`relative z-10 ${
                      (selectedAspectRatio === '9:16' || selectedAspectRatio === '1:1') && framingMode === 'zoom-crop'
                        ? 'w-full h-full object-cover'
                        : selectedAspectRatio === '16:9'
                        ? 'w-full h-full object-cover'
                        : 'max-w-full max-h-full object-contain shadow-2xl'
                    }`}
                    playsInline
                    muted={false}
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={() => {
                      setIsPlaying(false);
                      if (previewVideoRef.current) previewVideoRef.current.currentTime = startTime;
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  />
                </div>
              ) : isYouTube && youtubeId ? (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 p-4 text-center space-y-2">
                  <SquarePlay className="w-10 h-10 text-rose-500 mx-auto" />
                  <p className="text-xs font-bold text-white">Video de YouTube</p>
                  <p className="text-[11px] text-slate-400 line-clamp-2">{clip.title}</p>
                  <div className="px-2 py-1 rounded bg-rose-500/10 text-rose-300 text-[10px] font-mono border border-rose-500/20">
                    t={Math.floor(startTime)}s - {Math.floor(endTime)}s
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-400">Sin video cargado</div>
              )}

              {/* LIVE DYNAMIC SUBTITLE OVERLAY ON PREVIEW
                  Draggable: once dragged, the caption is placed by an anchor
                  and the top/centre/bottom preset no longer applies - the same
                  rule the ASS file follows, where alignment and \pos are
                  alternatives rather than a combination. */}
              {burnSubtitles && (
                <div
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setDraggingCaption(true);
                    moveCaptionTo(event.clientX, event.clientY);
                  }}
                  title="Arrastra para mover los subtítulos"
                  className={`absolute flex justify-center text-center z-20 cursor-grab active:cursor-grabbing ${
                    draggingCaption ? '' : 'transition-all'
                  } ${
                    subAnchor
                      ? '-translate-x-1/2 -translate-y-1/2'
                      : `inset-x-3 ${
                          subtitlePosition === 'top'
                            ? 'top-8'
                            : subtitlePosition === 'center'
                            ? 'top-1/2 -translate-y-1/2'
                            : 'bottom-8'
                        }`
                  }`}
                  style={
                    subAnchor
                      ? {
                          left: `${subAnchor.x * 100}%`,
                          top: `${subAnchor.y * 100}%`,
                          width: 'max-content',
                          maxWidth: '90%',
                        }
                      : undefined
                  }
                >
                  <div className="max-w-full animate-in fade-in duration-100 pointer-events-none">
                    {currentSubText ? (
                      <span className={`inline-block px-3 py-1 text-sm sm:text-base leading-snug rounded-xl select-none ${activeStyleConfig.previewClass}`}>
                        {currentSubText}
                      </span>
                    ) : (
                      <span className="text-[10px] text-white/50 bg-black/40 px-2 py-0.5 rounded-md italic">
                        [Subtítulos activos]
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* FLOATING PLAY CONTROLS OVER PREVIEW */}
              {videoSrc && (
                <button
                  type="button"
                  onClick={togglePlay}
                  className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-indigo-600/80 hover:bg-indigo-600 text-white flex items-center justify-center backdrop-blur-sm shadow-xl transition-transform hover:scale-110 opacity-0 hover:opacity-100 focus:opacity-100 z-30"
                >
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                </button>
              )}
            </div>

            {/* PREVIEW SCRUBBER & CONTROLS */}
            <div className="w-full max-w-[320px] bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between text-xs space-x-2">
              <button
                type="button"
                onClick={togglePlay}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition-colors"
                title={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-emerald-400" />}
              </button>

              <button
                type="button"
                onClick={() => handleSeek(startTime)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title="Reiniciar al inicio del corte"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <span className="text-slate-400 font-mono text-[11px] truncate">
                {(currentTime - startTime).toFixed(1)}s / {duration.toFixed(1)}s
              </span>

              <button
                type="button"
                onClick={() => setBurnSubtitles(!burnSubtitles)}
                className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                  burnSubtitles
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                Subtítulos: {burnSubtitles ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          {/* RIGHT COLUMN: TRIMMING, REFRAMING, SUBTITLE STYLES & EXPORT CONTROLS */}
          <div className="lg:col-span-7 space-y-4">
            
            {/* TAB SELECTOR: AJUSTES & REENCUADRE vs EDITOR DE SUBTÍTULOS */}
            <div className="flex border-b border-slate-800 pb-1 space-x-2">
              <button
                type="button"
                onClick={() => setActiveTab('settings')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  activeTab === 'settings'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                ⚙️ Recorte & Reencuadre
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('subtitles')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors flex items-center space-x-1.5 ${
                  activeTab === 'subtitles'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <span>💬 Editor de Subtítulos</span>
                <span className="px-1.5 py-0.2 bg-slate-900 text-indigo-300 text-[10px] rounded-full font-mono border border-indigo-500/30">
                  {activeSubtitles.length}
                </span>
              </button>
            </div>

            {activeTab === 'settings' ? (
              <div className="space-y-4 animate-in fade-in duration-150">
                {/* 1. TRIMMING CONTROLS (RECORTAR INICIO Y FIN) */}
                <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center space-x-1.5">
                      <Scissors className="w-3.5 h-3.5 text-rose-400" />
                      <span>Ajuste y Recorte Preciso (Trim)</span>
                    </span>
                    <span className="text-[11px] font-semibold text-slate-400">
                      Corte: {startTime.toFixed(1)}s - {endTime.toFixed(1)}s
                    </span>
                  </div>

                  {/* Start & End Sliders / Inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5 bg-slate-900/90 p-3 rounded-xl border border-slate-800">
                      <div className="flex justify-between text-xs">
                        <label className="text-slate-300 font-medium">Inicio del Clip:</label>
                        <span className="font-mono text-indigo-400 font-bold">{startTime.toFixed(1)}s</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={() => handleStartChange(startTime - 0.5)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-xs font-bold"
                        >
                          -0.5s
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={endTime - 0.5}
                          step={0.1}
                          value={startTime}
                          onChange={(e) => handleStartChange(parseFloat(e.target.value))}
                          className="flex-1 accent-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleStartChange(startTime + 0.5)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-xs font-bold"
                        >
                          +0.5s
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5 bg-slate-900/90 p-3 rounded-xl border border-slate-800">
                      <div className="flex justify-between text-xs">
                        <label className="text-slate-300 font-medium">Fin del Clip:</label>
                        <span className="font-mono text-rose-400 font-bold">{endTime.toFixed(1)}s</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={() => handleEndChange(endTime - 0.5)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-xs font-bold"
                        >
                          -0.5s
                        </button>
                        <input
                          type="range"
                          min={startTime + 0.5}
                          max={totalVideoDuration > 0 ? totalVideoDuration : 600}
                          step={0.1}
                          value={endTime}
                          onChange={(e) => handleEndChange(parseFloat(e.target.value))}
                          className="flex-1 accent-rose-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleEndChange(endTime + 0.5)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-300 text-xs font-bold"
                        >
                          +0.5s
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between items-center text-[11px] text-slate-400 pt-1">
                    <span>Duración final recortada: <strong className="text-emerald-400">{duration.toFixed(1)} segundos</strong></span>
                    <button
                      type="button"
                      onClick={() => {
                        setStartTime(clip.startTimeSeconds);
                        setEndTime(clip.endTimeSeconds);
                        handleSeek(clip.startTimeSeconds);
                      }}
                      className="text-indigo-400 hover:underline"
                    >
                      Restablecer corte original
                    </button>
                  </div>
                </div>

                {/* 2. ASPECT RATIO SELECTOR */}
                <div>
                  <label className="text-xs font-bold text-slate-200 block mb-2">
                    1. Formato de Salida (Aspect Ratio):
                  </label>
                  <div className="grid grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setSelectedAspectRatio('9:16')}
                      className={`p-2.5 sm:p-3 rounded-xl border text-center transition-all ${
                        selectedAspectRatio === '9:16'
                          ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500'
                          : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <Smartphone className="w-4 h-4 sm:w-5 sm:h-5 mx-auto mb-1 text-indigo-400" />
                      <span className="block text-xs font-bold">9:16 Vertical</span>
                      <span className="text-[10px] text-slate-400">TikTok / Reels / Shorts</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSelectedAspectRatio('1:1')}
                      className={`p-2.5 sm:p-3 rounded-xl border text-center transition-all ${
                        selectedAspectRatio === '1:1'
                          ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500'
                          : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <Square className="w-4 h-4 sm:w-5 sm:h-5 mx-auto mb-1 text-indigo-400" />
                      <span className="block text-xs font-bold">1:1 Cuadrado</span>
                      <span className="text-[10px] text-slate-400">Feed / LinkedIn</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSelectedAspectRatio('16:9')}
                      className={`p-2.5 sm:p-3 rounded-xl border text-center transition-all ${
                        selectedAspectRatio === '16:9'
                          ? 'bg-indigo-600/20 border-indigo-500 text-white ring-1 ring-indigo-500'
                          : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <Monitor className="w-4 h-4 sm:w-5 sm:h-5 mx-auto mb-1 text-indigo-400" />
                      <span className="block text-xs font-bold">16:9 Horizontal</span>
                      <span className="text-[10px] text-slate-400">YouTube Estándar</span>
                    </button>
                  </div>
                </div>

                {/* 3. AUTO-REFRAMING MODE SELECTOR (PARA FORMATO VERTICAL 9:16 Y 1:1) */}
                {(selectedAspectRatio === '9:16' || selectedAspectRatio === '1:1') && (
                  <div className="bg-slate-950 p-4 rounded-2xl border border-indigo-500/30 space-y-2.5 animate-in fade-in">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-bold text-white flex items-center space-x-1.5">
                        <Maximize2 className="w-3.5 h-3.5 text-indigo-400" />
                        <span>2. Reencuadre Automático (Sin Franjas Negras)</span>
                      </label>
                      <span className="text-[10px] px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-300 font-semibold border border-indigo-500/20">
                        Auto-Reframing
                      </span>
                    </div>

                    <div className="pt-1">
                      <FramingPicker
                        value={framingMode}
                        onChange={onFramingModeChange}
                        markedRegions={speakers.length}
                      />
                    </div>

                    {(framingMode === 'focus' ||
                      framingMode === 'split' ||
                      framingMode === 'auto-fill' ||
                      framingMode === 'gameplay') && (
                      <div className="mt-3 p-3 bg-slate-950 border border-slate-800 rounded-xl">
                        <SpeakerPicker
                          videoSrc={videoSrc}
                          previewTime={startTime + Math.min(2, duration / 4)}
                          mode={framingMode}
                          regions={speakers}
                          onChange={onSpeakersChange}
                          sourceId={sourceId}
                        />
                        {framingMode === 'gameplay' && (
                          <div className="pt-3">
                            <GameplayLayoutPicker
                              value={gameplayLayout}
                              onChange={onGameplayLayoutChange}
                            />
                          </div>
                        )}
                      </div>
                    )}

                  </div>
                )}

                {/* Watermark: same state as under the player, so it is set once. */}
                <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
                  <label className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                    <Layers className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Marca de agua</span>
                  </label>
                  <WatermarkPicker value={watermark} onChange={onWatermarkChange} />
                  {watermark && exportEngine !== 'ffmpeg' && (
                    <p className="text-[11px] text-amber-300">
                      La marca de agua solo se aplica cuando exporta FFmpeg; el motor del navegador no la dibuja.
                    </p>
                  )}
                </div>

                {/* 4. SUBTITLE STYLES & POSITION */}
                <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                      <Layers className="w-3.5 h-3.5 text-amber-400" />
                      <span>3. Tipografía y Estilo de Subtítulos</span>
                    </label>
                    
                    {/* Position picker */}
                    <div className="flex items-center space-x-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                      <span className="text-[10px] text-slate-400 px-1">Posición:</span>
                      {(['bottom', 'center', 'top'] as const).map((pos) => (
                        <button
                          key={pos}
                          type="button"
                          // Choosing a preset drops the dragged position: the
                          // two are alternatives, and leaving the anchor set
                          // would make these buttons look broken.
                          onClick={() => {
                            setSubtitlePosition(pos);
                            setSubAnchor(null);
                          }}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                            subtitlePosition === pos && !subAnchor
                              ? 'bg-indigo-600 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {pos === 'bottom' ? 'Abajo' : pos === 'center' ? 'Centro' : 'Arriba'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 flex items-center space-x-1.5">
                    <Move className="w-3 h-3 shrink-0 text-indigo-400" />
                    {subAnchor ? (
                      <span>
                        Subtítulos colocados a mano en {Math.round(subAnchor.x * 100)}% ·{' '}
                        {Math.round(subAnchor.y * 100)}%.{' '}
                        <button
                          type="button"
                          onClick={() => setSubAnchor(null)}
                          className="underline hover:text-white"
                        >
                          Volver a la posición automática
                        </button>
                      </span>
                    ) : (
                      <span>
                        También puedes arrastrar los subtítulos sobre la vista previa para
                        ponerlos donde quieras.
                      </span>
                    )}
                  </p>

                  {/* Subtitle Style Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {SUBTITLE_STYLES.map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setSubtitleStyle(st.id)}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                          subtitleStyle === st.id
                            ? 'bg-indigo-950/40 border-indigo-500 ring-1 ring-indigo-500'
                            : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="text-[10px] font-bold text-amber-400 mb-1">{st.badge}</div>
                        <div className="text-xs font-bold text-white truncate">{st.name}</div>
                      </button>
                    ))}
                  </div>

                  {/* 4. SUBTITLE ANIMATION */}
                  <div className="pt-3 border-t border-slate-800/80 space-y-2">
                    <label className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                      <Wand2 className="w-3.5 h-3.5 text-fuchsia-400" />
                      <span>4. Animación de los Subtítulos</span>
                    </label>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {SUBTITLE_ANIMATIONS.map((anim) => (
                        <button
                          key={anim.id}
                          type="button"
                          onClick={() => {
                            setSubtitleAnimation(anim.id);
                            onAnimationChange?.(anim.id);
                          }}
                          className={`p-2.5 rounded-xl border text-left transition-all ${
                            subtitleAnimation === anim.id
                              ? 'bg-fuchsia-950/40 border-fuchsia-500 ring-1 ring-fuchsia-500'
                              : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div className="text-[10px] font-bold text-fuchsia-300 mb-1">
                            {anim.badge}
                          </div>
                          <div className="text-xs font-bold text-white truncate">{anim.name}</div>
                        </button>
                      ))}
                    </div>

                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      {SUBTITLE_ANIMATIONS.find((a) => a.id === subtitleAnimation)?.description}
                    </p>

                    {/* Size and colour on top of the preset. The presets
                        encode a whole look; this is for the one clip that
                        needs the text a bit bigger or a different accent. */}
                    <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-semibold text-slate-300">
                          Tamaño del texto
                        </label>
                        <span className="text-[11px] text-slate-500 font-mono">
                          {Math.round(subScale * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={60}
                        max={160}
                        step={5}
                        value={Math.round(subScale * 100)}
                        onChange={(e) => setSubScale(Number(e.target.value) / 100)}
                        className="w-full accent-indigo-500"
                      />

                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-[11px] text-slate-400 flex items-center gap-2">
                          <input
                            type="color"
                            value={subBase || activeStyleConfig.textColor}
                            onChange={(e) => setSubBase(e.target.value)}
                            className="w-7 h-7 rounded border border-slate-700 bg-slate-950 cursor-pointer"
                          />
                          <span>Color del texto</span>
                        </label>

                        <label className="text-[11px] text-slate-400 flex items-center gap-2">
                          <input
                            type="color"
                            value={subHighlight || '#22C55E'}
                            onChange={(e) => setSubHighlight(e.target.value)}
                            className="w-7 h-7 rounded border border-slate-700 bg-slate-950 cursor-pointer"
                          />
                          <span>Palabra activa</span>
                        </label>
                      </div>

                      {(subBase || subHighlight || subScale !== 1) && (
                        <button
                          type="button"
                          onClick={() => {
                            setSubScale(1);
                            setSubBase('');
                            setSubHighlight('');
                          }}
                          className="text-[11px] text-slate-400 hover:text-indigo-300"
                        >
                          Volver a los colores del estilo
                        </button>
                      )}
                    </div>

                    {/* Speech cleanup. Only possible because Whisper gives
                        per-word timings: without them there is no way to know
                        where a pause starts. */}
                    <div className="pt-3 border-t border-slate-800/80 space-y-2">
                      <label className="flex items-start space-x-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={speechCleanup}
                          onChange={(e) => setSpeechCleanup(e.target.checked)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <span>
                          <span className="block text-xs font-bold text-white">
                            Apretar el clip (quitar silencios)
                          </span>
                          <span className="block text-[11px] text-slate-400 leading-relaxed">
                            Corta las pausas muertas y vuelve a unir el video. Los subtítulos se
                            recolocan solos.
                          </span>
                        </span>
                      </label>

                      {speechCleanup && (
                        <label className="flex items-start space-x-2 cursor-pointer pl-6">
                          <input
                            type="checkbox"
                            checked={removeFillers}
                            onChange={(e) => setRemoveFillers(e.target.checked)}
                            className="mt-0.5 accent-emerald-500"
                          />
                          <span className="text-[11px] text-slate-300 leading-relaxed">
                            Quitar también muletillas (<em>eh</em>, <em>mmm</em>, <em>o sea</em>).
                            Solo las que no significan nada; <em>bueno</em> o <em>pues</em> se
                            respetan porque a veces abren frase.
                          </span>
                        </label>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* SUBTITLE LINE-BY-LINE INTERACTIVE EDITOR */
              <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                      <span>Editor Línea por Línea de Subtítulos</span>
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Edita el texto o los tiempos de cada frase hablada para el video exportado.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddSubtitleLine}
                    className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-colors shadow"
                  >
                    + Añadir Frase
                  </button>
                </div>

                {activeSubtitles.length === 0 ? (
                  <div className="p-6 text-center text-slate-400 text-xs bg-slate-900 rounded-xl">
                    No hay subtítulos configurados para este clip.{' '}
                    <button
                      type="button"
                      onClick={handleAddSubtitleLine}
                      className="text-indigo-400 underline font-semibold ml-1"
                    >
                      Añadir el primero
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                    {activeSubtitles.map((sub, idx) => (
                      <div
                        key={idx}
                        className="bg-slate-900/90 p-2.5 rounded-xl border border-slate-800 flex items-center space-x-2 text-xs hover:border-slate-700 transition-colors"
                      >
                        <div className="w-16 shrink-0 flex flex-col space-y-1">
                          <input
                            type="number"
                            step="0.1"
                            value={sub.startTime}
                            onChange={(e) =>
                              handleEditSubtitleTimes(idx, parseFloat(e.target.value) || 0, sub.endTime)
                            }
                            className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-[11px] font-mono text-indigo-300 text-center"
                            title="Inicio (segundos)"
                          />
                          <input
                            type="number"
                            step="0.1"
                            value={sub.endTime}
                            onChange={(e) =>
                              handleEditSubtitleTimes(idx, sub.startTime, parseFloat(e.target.value) || 0)
                            }
                            className="bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-[11px] font-mono text-rose-300 text-center"
                            title="Fin (segundos)"
                          />
                        </div>

                        <input
                          type="text"
                          value={sub.text}
                          onChange={(e) => handleEditSubtitleText(idx, e.target.value)}
                          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
                          placeholder="Texto del subtítulo..."
                        />

                        <button
                          type="button"
                          onClick={() => handleDeleteSubtitleLine(idx)}
                          className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition-colors"
                          title="Eliminar frase"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 5. COMPANION DOWNLOADS (SRT, VTT, SOCIAL POST KIT) */}
            <div className="bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 flex flex-wrap gap-2 items-center justify-between text-xs">
              <span className="text-slate-400 font-medium">Exportación complementaria:</span>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={handleDownloadSrt}
                  className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 font-medium flex items-center space-x-1"
                  title="Descargar archivo de subtítulos para Premiere / CapCut / DaVinci"
                >
                  <FileText className="w-3.5 h-3.5 text-indigo-400" />
                  <span>.SRT</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadVtt}
                  className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 font-medium flex items-center space-x-1"
                >
                  <FileText className="w-3.5 h-3.5 text-emerald-400" />
                  <span>.VTT</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadSocialKit}
                  className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 font-medium flex items-center space-x-1"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Kit Publicación (.TXT)</span>
                </button>

                <button
                  type="button"
                  onClick={copyPostToClipboard}
                  className="px-2.5 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-300 font-medium flex items-center space-x-1"
                >
                  <Copy className="w-3.5 h-3.5 text-purple-400" />
                  <span>{copiedCaption ? '¡Copiado!' : 'Copy'}</span>
                </button>
              </div>
            </div>

            {/* EXPORT PROGRESS BAR */}
            {isExporting && (
              <div className="bg-slate-950 p-5 rounded-2xl border border-indigo-500/30 space-y-3 animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-white flex items-center space-x-2">
                    <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                    <span>{statusMessage || 'Procesando video...'}</span>
                  </span>
                  <span className="font-mono font-bold text-indigo-400 text-sm">
                    {Math.round(progress * 100)}%
                  </span>
                </div>

                <div className="w-full bg-slate-900 h-3 rounded-full overflow-hidden p-0.5 border border-slate-800">
                  <div
                    className="bg-gradient-to-r from-indigo-500 via-purple-500 to-rose-500 h-full rounded-full transition-all duration-200"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {/* SUCCESS BANNER */}
            {exportComplete && (
              <div className="bg-emerald-950/60 border border-emerald-500/40 p-4 rounded-2xl flex items-center space-x-3 animate-in zoom-in-95">
                <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                <div className="text-xs">
                  <strong className="text-emerald-300 block font-bold">
                    {exportResult?.fileName || 'Video exportado'} ({duration.toFixed(1)}s)
                  </strong>
                  <span className="text-slate-300">
                    Guardado en tu carpeta de descargas
                    {usedEngine === 'ffmpeg'
                      ? ', renderizado con FFmpeg (MP4 H.264 + AAC).'
                      : exportResult?.container === 'webm'
                        ? '. Tu navegador no puede grabar MP4, así que el archivo es WebM: Instagram y TikTok lo aceptan al subirlo.'
                        : '.'}
                  </span>
                  {exportResult && !exportResult.hasAudio && (
                    <span className="block mt-1.5 text-amber-300 font-semibold">
                      Atención: el clip salió sin audio. Comprueba que el video original tenga pista de sonido.
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* ERROR BANNER */}
            {exportError && (
              <div className="bg-rose-950/80 border border-rose-800 p-3.5 rounded-2xl flex items-start space-x-2 text-xs text-rose-200">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{exportError}</span>
              </div>
            )}

            {/* MASTER EXPORT ACTION BUTTON */}
            <div className="pt-2 flex items-center justify-end space-x-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isExporting}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
              >
                Cerrar
              </button>

              <button
                type="button"
                onClick={handleStartExport}
                disabled={isExporting}
                className="px-6 py-2.5 bg-gradient-to-r from-indigo-600 via-purple-600 to-rose-600 hover:from-indigo-500 hover:to-rose-500 text-white rounded-xl text-xs sm:text-sm font-bold transition-all shadow-lg shadow-indigo-600/30 flex items-center space-x-2 disabled:opacity-50"
              >
                {isExporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Incrustando Subtítulos y Reencuadrando...</span>
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    <span>Exportar y Descargar Clip ({duration.toFixed(1)}s MP4)</span>
                  </>
                )}
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
};
