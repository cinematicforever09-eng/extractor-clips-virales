import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Play, Pause, RotateCcw, Smartphone, Square, Monitor, Volume2, VolumeX, Scissors, Repeat, SquarePlay, ExternalLink } from 'lucide-react';
import {
  SubtitleLine,
  ClipIdea,
  SubtitleStyleType,
  AspectRatioType,
  SubtitleAnimationType,
} from '../types';
import { SUBTITLE_STYLES } from '../constants';
import { AnimatedSubtitle } from './AnimatedSubtitle';

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  isYouTube?: boolean;
  youtubeId?: string | null;
  subtitles: SubtitleLine[];
  currentSubtitleStyle: SubtitleStyleType;
  subtitleAnimation?: SubtitleAnimationType;
  selectedClip: ClipIdea | null;
  aspectRatio: AspectRatioType;
  onAspectRatioChange: (aspect: AspectRatioType) => void;
  onLoadedMetadata?: (event: React.SyntheticEvent<HTMLVideoElement, Event>) => void;
  onVideoError?: (event: React.SyntheticEvent<HTMLVideoElement, Event>) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onAdjustClipTimes?: (newStart: number, newEnd: number) => void;
  initialDuration?: number;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
  previewTimestampTrigger?: number;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  videoRef,
  src,
  isYouTube = false,
  youtubeId = null,
  subtitles,
  currentSubtitleStyle,
  subtitleAnimation = 'word-pop',
  selectedClip,
  aspectRatio,
  onAspectRatioChange,
  onLoadedMetadata,
  onVideoError,
  onTimeUpdate,
  onAdjustClipTimes,
  initialDuration = 0,
  onPlaybackStateChange,
  previewTimestampTrigger = 0,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(initialDuration || 0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [loopClip, setLoopClip] = useState<boolean>(true);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState<number>(-1);
  /**
   * How wide the video is actually drawn, so the caption can be sized as the
   * same fraction of it that the export uses. Measured rather than assumed:
   * object-contain means the painted width is not the container's width
   * whenever the clip is taller than the box.
   */
  const [frameWidth, setFrameWidth] = useState<number>(0);

  // Remeasured on resize, because the painted width changes with the window
  // and a caption sized against a stale width wraps differently from the export.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof ResizeObserver === 'undefined') return;

    const measure = () => {
      const box = video.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;

      // object-contain letterboxes, so the picture is only as wide as its own
      // aspect allows inside the box.
      const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 0;
      const painted = ratio > 0 ? Math.min(box.width, box.height * ratio) : box.width;
      setFrameWidth(Math.round(painted));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener('loadedmetadata', measure);

    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', measure);
    };
  }, [src]);
  
  // YouTube IFrame Player instance
  const ytPlayerRef = useRef<any>(null);
  const ytIntervalRef = useRef<number | null>(null);
  const isYtReadyRef = useRef<boolean>(false);
  const selectedClipRef = useRef<ClipIdea | null>(selectedClip);

  useEffect(() => {
    selectedClipRef.current = selectedClip;
  }, [selectedClip]);

  useEffect(() => {
    if (onPlaybackStateChange) {
      onPlaybackStateChange(isPlaying);
    }
  }, [isPlaying, onPlaybackStateChange]);

  const formatSeconds = (sec: number): string => {
    if (isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Play a specific clip immediately
  const playClip = useCallback((clip: ClipIdea) => {
    if (isYouTube) {
      if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
        try {
          ytPlayerRef.current.seekTo(clip.startTimeSeconds, true);
          ytPlayerRef.current.playVideo();
          setIsPlaying(true);
        } catch (err) {
          console.warn('YouTube play clip error:', err);
        }
      }
    } else {
      const video = videoRef.current;
      if (video) {
        video.currentTime = clip.startTimeSeconds;
        video
          .play()
          .then(() => setIsPlaying(true))
          .catch((err) => console.warn('HTML5 video play clip error:', err));
      }
    }
  }, [isYouTube, videoRef]);

  // When selected clip changes or preview trigger fires, automatically start playing that clip
  useEffect(() => {
    if (!selectedClip) return;
    playClip(selectedClip);
  }, [selectedClip?.clipId, previewTimestampTrigger, playClip]);

  // 1. YouTube Player Initialization
  useEffect(() => {
    if (!isYouTube || !youtubeId) return;

    let isSubscribed = true;
    isYtReadyRef.current = false;

    const initYT = () => {
      if (!window.YT || !window.YT.Player) return;

      if (ytPlayerRef.current) {
        try {
          ytPlayerRef.current.destroy();
        } catch (_) {}
      }

      ytPlayerRef.current = new window.YT.Player('yt-embedded-player', {
        videoId: youtubeId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          origin: window.location.origin,
          playsinline: 1,
        },
        events: {
          onReady: (event: any) => {
            if (!isSubscribed) return;
            isYtReadyRef.current = true;
            const dur = event.target.getDuration();
            if (dur > 0) setDuration(dur);

            // If a clip was already selected before YT player was ready, seek and play
            if (selectedClipRef.current) {
              try {
                event.target.seekTo(selectedClipRef.current.startTimeSeconds, true);
                event.target.playVideo();
                setIsPlaying(true);
              } catch (_) {}
            }
          },
          onStateChange: (event: any) => {
            if (!isSubscribed) return;
            // 1: PLAYING, 2: PAUSED, 0: ENDED
            if (event.data === 1) {
              setIsPlaying(true);
            } else if (event.data === 2 || event.data === 0) {
              setIsPlaying(false);
            }
          },
        },
      });
    };

    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag?.parentNode?.insertBefore(tag, firstScriptTag);
      window.onYouTubeIframeAPIReady = () => {
        initYT();
      };
    } else {
      initYT();
    }

    return () => {
      isSubscribed = false;
      isYtReadyRef.current = false;
      if (ytIntervalRef.current) {
        window.clearInterval(ytIntervalRef.current);
      }
      if (ytPlayerRef.current) {
        try {
          ytPlayerRef.current.destroy();
        } catch (_) {}
      }
    };
  }, [isYouTube, youtubeId]);

  // 2. Time Tracker & Subtitle Synchronizer
  useEffect(() => {
    // If YouTube mode, run polling interval
    if (isYouTube) {
      if (ytIntervalRef.current) window.clearInterval(ytIntervalRef.current);

      ytIntervalRef.current = window.setInterval(() => {
        if (!ytPlayerRef.current || typeof ytPlayerRef.current.getCurrentTime !== 'function') return;

        try {
          const time = ytPlayerRef.current.getCurrentTime() || 0;
          setCurrentTime(time);
          if (onTimeUpdate) onTimeUpdate(time);

          const dur = ytPlayerRef.current.getDuration() || 0;
          if (dur > 0 && dur !== duration) setDuration(dur);

          // Subtitle and loop synchronization
          if (selectedClip) {
            const clipStart = selectedClip.startTimeSeconds;
            const clipEnd = selectedClip.endTimeSeconds;
            const relativeTime = Math.max(0, time - clipStart);

            // Find matching subtitle with slight smoothing tolerance
            const activeIdx = subtitles.findIndex(
              (sub) => relativeTime >= sub.startTime - 0.05 && relativeTime <= sub.endTime + 0.15
            );
            setActiveSubtitleIndex(activeIdx);

            // Loop clip if enabled
            if (loopClip && time >= clipEnd) {
              ytPlayerRef.current.seekTo(clipStart, true);
              ytPlayerRef.current.playVideo();
            }
          } else if (subtitles && subtitles.length > 0) {
            // Full video subtitle display
            const activeIdx = subtitles.findIndex(
              (sub) => time >= sub.startTime - 0.05 && time <= sub.endTime + 0.15
            );
            setActiveSubtitleIndex(activeIdx);
          } else {
            setActiveSubtitleIndex(-1);
          }
        } catch (_) {}
      }, 100);

      return () => {
        if (ytIntervalRef.current) window.clearInterval(ytIntervalRef.current);
      };
    }

    // HTML5 Video mode event listeners
    const video = videoRef.current;
    if (!video) return;

    const handleTime = () => {
      const time = video.currentTime;
      setCurrentTime(time);
      if (onTimeUpdate) onTimeUpdate(time);

      if (selectedClip) {
        const clipStart = selectedClip.startTimeSeconds;
        const clipEnd = selectedClip.endTimeSeconds;
        const relativeTime = Math.max(0, time - clipStart);

        const activeIdx = subtitles.findIndex(
              (sub) => relativeTime >= sub.startTime - 0.05 && relativeTime <= sub.endTime + 0.15
            );
            setActiveSubtitleIndex(activeIdx);

        if (loopClip && time >= clipEnd) {
          video.currentTime = clipStart;
          video.play().catch(() => {});
        }
      } else if (subtitles && subtitles.length > 0) {
        const activeIdx = subtitles.findIndex(
              (sub) => time >= sub.startTime - 0.05 && time <= sub.endTime + 0.15
            );
            setActiveSubtitleIndex(activeIdx);
      } else {
        setActiveSubtitleIndex(-1);
      }
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleMeta = () => {
      if (video.duration) setDuration(video.duration);
    };

    video.addEventListener('timeupdate', handleTime);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('loadedmetadata', handleMeta);

    return () => {
      video.removeEventListener('timeupdate', handleTime);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('loadedmetadata', handleMeta);
    };
  }, [isYouTube, subtitles, selectedClip, loopClip, onTimeUpdate, duration, videoRef]);

  // Handle Play/Pause
  const togglePlay = () => {
    if (isYouTube && ytPlayerRef.current) {
      try {
        if (isPlaying) {
          ytPlayerRef.current.pauseVideo();
        } else {
          if (selectedClip && (currentTime >= selectedClip.endTimeSeconds || currentTime < selectedClip.startTimeSeconds)) {
            ytPlayerRef.current.seekTo(selectedClip.startTimeSeconds, true);
          }
          ytPlayerRef.current.playVideo();
        }
      } catch (_) {}
      return;
    }

    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (selectedClip && (video.currentTime >= selectedClip.endTimeSeconds || video.currentTime < selectedClip.startTimeSeconds)) {
        video.currentTime = selectedClip.startTimeSeconds;
      }
      video.play().catch((e) => console.warn('Play error:', e));
    } else {
      video.pause();
    }
  };

  const jumpToClipStart = () => {
    if (selectedClip) {
      if (isYouTube && ytPlayerRef.current) {
        try {
          ytPlayerRef.current.seekTo(selectedClip.startTimeSeconds, true);
          ytPlayerRef.current.playVideo();
        } catch (_) {}
      } else if (videoRef.current) {
        videoRef.current.currentTime = selectedClip.startTimeSeconds;
        videoRef.current.play().catch(() => {});
      }
    }
  };

  const toggleMute = () => {
    if (isYouTube && ytPlayerRef.current) {
      try {
        if (isMuted) {
          ytPlayerRef.current.unMute();
          setIsMuted(false);
        } else {
          ytPlayerRef.current.mute();
          setIsMuted(true);
        }
      } catch (_) {}
      return;
    }

    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsMuted(videoRef.current.muted);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    setCurrentTime(newTime);

    if (isYouTube && ytPlayerRef.current) {
      try {
        ytPlayerRef.current.seekTo(newTime, true);
      } catch (_) {}
      return;
    }

    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
    }
  };

  const activeStyle = SUBTITLE_STYLES.find((s) => s.id === currentSubtitleStyle) || SUBTITLE_STYLES[0];

  const activeSubtitle =
    activeSubtitleIndex >= 0 && activeSubtitleIndex < subtitles.length
      ? subtitles[activeSubtitleIndex]
      : null;

  return (
    <div id="main-video-player-component" className="space-y-4">
      {/* Aspect Ratio & Preview Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800">
        <div className="flex items-center space-x-1.5">
          <span className="text-xs font-semibold text-slate-400 mr-1 hidden sm:inline">Formato:</span>
          <button
            type="button"
            id="aspect-9-16-btn"
            onClick={() => onAspectRatioChange('9:16')}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition-colors ${
              aspectRatio === '9:16'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>9:16 (Shorts/Reels)</span>
          </button>

          <button
            type="button"
            id="aspect-1-1-btn"
            onClick={() => onAspectRatioChange('1:1')}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition-colors ${
              aspectRatio === '1:1'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Square className="w-3.5 h-3.5" />
            <span>1:1 (Cuadrado)</span>
          </button>

          <button
            type="button"
            id="aspect-16-9-btn"
            onClick={() => onAspectRatioChange('16:9')}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition-colors ${
              aspectRatio === '16:9' || aspectRatio === 'original'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>16:9 (Original)</span>
          </button>
        </div>

        {/* Current Active Subtitle Style Indicator */}
        <div className="flex items-center space-x-2 text-xs text-slate-300">
          <span className="text-slate-400">Subtítulos:</span>
          <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/20 font-medium">
            {activeStyle.name}
          </span>
        </div>
      </div>

      {/* Video Container Frame */}
      <div className="flex justify-center items-center bg-slate-950/90 rounded-2xl border border-slate-800 p-4 overflow-hidden relative min-h-[340px]">
        {/* Frame Mockup for 9:16 or 1:1 preview */}
        <div
          className={`relative overflow-hidden transition-all duration-300 flex items-center justify-center bg-black shadow-2xl ${
            aspectRatio === '9:16'
              ? 'w-[280px] sm:w-[320px] aspect-[9/16] rounded-3xl border-4 border-slate-800 ring-1 ring-slate-700'
              : aspectRatio === '1:1'
              ? 'w-[320px] sm:w-[400px] aspect-square rounded-2xl border-2 border-slate-800'
              : 'w-full max-w-2xl aspect-video rounded-xl border border-slate-800'
          }`}
        >
          {isYouTube ? (
            /* YouTube Iframe Player Container */
            <div className="w-full h-full relative flex items-center justify-center">
              <div id="yt-embedded-player" className="w-full h-full" />
            </div>
          ) : (
            /* HTML5 Video Element */
            <video
              ref={videoRef}
              src={src}
              className="w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onLoadedMetadata={onLoadedMetadata}
              onError={onVideoError}
              playsInline
              crossOrigin="anonymous"
            />
          )}

          {/* Real-time Subtitle Overlay on Video */}
          <div className="absolute inset-x-0 bottom-12 flex justify-center items-center pointer-events-none z-20">
            <AnimatedSubtitle
              line={activeSubtitle}
              style={currentSubtitleStyle}
              animation={subtitleAnimation}
              frameWidth={frameWidth}
            />
          </div>

          {/* Selected Clip Indicator badge */}
          {selectedClip && (
            <div className="absolute top-3 left-3 bg-indigo-600/90 backdrop-blur-md text-white text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center space-x-1 shadow-md z-20">
              <Scissors className="w-3 h-3" />
              <span>Clip: {selectedClip.title.substring(0, 24)}...</span>
            </div>
          )}
        </div>
      </div>

      {/* Interactive Controls Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
        {/* Scrubber & Clip Range Indicator */}
        <div className="space-y-1">
          <div className="relative flex items-center">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              id="timeline-scrubber"
            />
            {/* Visual highlight on scrubber for the selected clip interval */}
            {selectedClip && duration > 0 && (
              <div
                className="absolute h-2 bg-amber-400/40 rounded-sm pointer-events-none"
                style={{
                  left: `${(selectedClip.startTimeSeconds / duration) * 100}%`,
                  width: `${((selectedClip.endTimeSeconds - selectedClip.startTimeSeconds) / duration) * 100}%`,
                }}
              />
            )}
          </div>

          <div className="flex justify-between items-center text-xs text-slate-400">
            <span className="font-mono">{formatSeconds(currentTime)}</span>
            {selectedClip && (
              <span className="text-amber-400 font-medium">
                Segmento: {formatSeconds(selectedClip.startTimeSeconds)} - {formatSeconds(selectedClip.endTimeSeconds)} ({Math.round(selectedClip.endTimeSeconds - selectedClip.startTimeSeconds)}s)
              </span>
            )}
            <span className="font-mono">{formatSeconds(duration)}</span>
          </div>
        </div>

        {/* Buttons Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              id="play-pause-btn"
              onClick={togglePlay}
              className="w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white flex items-center justify-center transition-all shadow-md shadow-indigo-600/20"
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
            </button>

            {selectedClip && (
              <>
                <button
                  type="button"
                  id="jump-clip-start-btn"
                  onClick={jumpToClipStart}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors flex items-center space-x-1"
                  title="Ir al inicio del clip"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Inicio Clip</span>
                </button>

                <button
                  type="button"
                  id="loop-clip-btn"
                  onClick={() => setLoopClip(!loopClip)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1 ${
                    loopClip
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                  title="Repetir clip en bucle"
                >
                  <Repeat className="w-3.5 h-3.5" />
                  <span>Bucle</span>
                </button>
              </>
            )}

            <button
              type="button"
              onClick={toggleMute}
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              title={isMuted ? 'Activar sonido' : 'Silenciar'}
            >
              {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {isYouTube && youtubeId && (
              <a
                href={`https://www.youtube.com/watch?v=${youtubeId}${selectedClip ? `&t=${Math.floor(selectedClip.startTimeSeconds)}` : ''}`}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1"
                title="Abrir en YouTube en nueva pestaña"
              >
                <SquarePlay className="w-3.5 h-3.5 text-rose-500" />
                <span className="hidden sm:inline">Ver en YouTube</span>
                <ExternalLink className="w-3 h-3 text-slate-400" />
              </a>
            )}
          </div>

          {/* Quick Trimming Adjusters for current selected clip */}
          {selectedClip && onAdjustClipTimes && (
            <div className="flex items-center space-x-2 text-xs bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
              <span className="text-slate-400">Ajuste fino:</span>
              <button
                type="button"
                onClick={() => onAdjustClipTimes(Math.max(0, selectedClip.startTimeSeconds - 1), selectedClip.endTimeSeconds)}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                title="Ampliar inicio 1s"
              >
                -1s Inicio
              </button>
              <button
                type="button"
                onClick={() => onAdjustClipTimes(selectedClip.startTimeSeconds, Math.min(duration, selectedClip.endTimeSeconds + 1))}
                className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                title="Ampliar fin 1s"
              >
                +1s Fin
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
