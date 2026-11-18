import React, { useState, useRef } from 'react';
import { Upload, Link as LinkIcon, Sparkles, Play, FileVideo, AlertCircle, SquarePlay, Loader2, Compass, Radio } from 'lucide-react';
import { SAMPLE_VIDEOS } from '../constants';

import { SourceVideoInfo, type WatermarkSettings } from '../types';
import { LivePanel } from './LivePanel';
import { prepareSourceVideo } from '../api-client';

interface VideoInputProps {
  onVideoLoad: (src: string, file?: File, notes?: string) => void;
  onLinkLoad: (ytInfo: SourceVideoInfo, notes?: string) => void;
  disabled?: boolean;
  /**
   * Reported by the server, not decided at build time: YouTube needs yt-dlp
   * installed on this machine, which the browser cannot know on its own.
   */
  linksEnabled?: boolean;
  /** Logo for live clips; the same one the studio view uses. */
  watermark?: WatermarkSettings | null;
  onWatermarkChange?: (value: WatermarkSettings | null) => void;
}

export const VideoInput: React.FC<VideoInputProps> = ({
  onVideoLoad,
  onLinkLoad,
  disabled,
  linksEnabled = false,
  watermark = null,
  onWatermarkChange = () => {},
}) => {
  const [activeInputTab, setActiveInputTab] = useState<'youtube' | 'upload' | 'samples' | 'live'>(linksEnabled ? 'youtube' : 'upload');
  const [youtubeUrl, setYoutubeUrl] = useState<string>('');
  const [directUrl, setDirectUrl] = useState<string>('');
  const [contextNotes, setContextNotes] = useState<string>('');
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [isLoadingYoutube, setIsLoadingYoutube] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFetchYouTube = async (urlToFetch?: string) => {
    const targetUrl = (urlToFetch || youtubeUrl).trim();
    if (!targetUrl) return;

    setIsLoadingYoutube(true);
    setErrorMessage(null);
    setStatusMessage('Consultando el enlace...');

    try {
      const res = await fetch('/api/source/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Error (${res.status}) al procesar el enlace.`);
      }

      const data: SourceVideoInfo = await res.json();

      // Metadata alone is not enough to play or export: fetch the actual video.
      setStatusMessage('Descargando el video...');
      const { sourceId, duration } = await prepareSourceVideo(targetUrl, (fraction) =>
        setStatusMessage(`Descargando el video... ${Math.round(fraction * 100)}%`)
      );

      setStatusMessage('');
      onLinkLoad(
        {
          ...data,
          sourceId,
          streamUrl: `/api/source/${sourceId}/stream`,
          duration: duration || data.duration,
        },
        contextNotes
      );
    } catch (err: any) {
      console.error('Error fetching YouTube video:', err);
      setErrorMessage(err.message || 'No se pudo cargar ese enlace.');
    } finally {
      setIsLoadingYoutube(false);
    }
  };

  const handleDirectUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!directUrl) return;

    if (directUrl.includes('youtube.com') || directUrl.includes('youtu.be')) {
      if (!linksEnabled) {
        setErrorMessage(
          'Los enlaces no están disponibles: falta yt-dlp. Sube el archivo directamente.'
        );
        return;
      }
      setActiveInputTab('youtube');
      setYoutubeUrl(directUrl);
      handleFetchYouTube(directUrl);
      return;
    }

    onVideoLoad(directUrl, undefined, contextNotes);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const processFile = (file: File) => {
    if (!file.type.startsWith('video/')) {
      setErrorMessage('Por favor selecciona un archivo de video válido (MP4, WebM, MOV, etc.).');
      return;
    }
    setErrorMessage(null);
    const videoSrc = URL.createObjectURL(file);
    onVideoLoad(videoSrc, file, contextNotes);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const loadSampleLocal = (sampleUrl: string) => {
    setErrorMessage(null);
    onVideoLoad(sampleUrl, undefined, contextNotes);
  };


  return (
    <div className="space-y-5">
      {/* Source Selector Tabs */}
      <div className="flex bg-slate-950 p-1.5 rounded-2xl border border-slate-800 gap-1">
        {linksEnabled && (
        <button
          type="button"
          id="tab-source-youtube-btn"
          onClick={() => {
            setActiveInputTab('youtube');
            setErrorMessage(null);
          }}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center space-x-2 ${
            activeInputTab === 'youtube'
              ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg shadow-red-600/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <SquarePlay className="w-4 h-4 text-red-300" />
          <span>Pegar enlace</span>
        </button>
        )}

        <button
          type="button"
          id="tab-source-upload-btn"
          onClick={() => {
            setActiveInputTab('upload');
            setErrorMessage(null);
          }}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center space-x-2 ${
            activeInputTab === 'upload'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <Upload className="w-4 h-4" />
          <span>Subir Archivo de Video</span>
        </button>

        {linksEnabled && (
          <button
            type="button"
            id="tab-source-live-btn"
            onClick={() => {
              setActiveInputTab('live');
              setErrorMessage(null);
            }}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center space-x-2 ${
              activeInputTab === 'live'
                ? 'bg-gradient-to-r from-red-700 to-red-500 text-white shadow-lg shadow-red-600/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
            }`}
          >
            <Radio className="w-4 h-4 text-red-400" />
            <span>En directo</span>
          </button>
        )}

        <button
          type="button"
          id="tab-source-samples-btn"
          onClick={() => {
            setActiveInputTab('samples');
            setErrorMessage(null);
          }}
          className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center justify-center space-x-2 ${
            activeInputTab === 'samples'
              ? 'bg-slate-800 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
          }`}
        >
          <Compass className="w-4 h-4 text-amber-400" />
          <span>Demos Rápidas</span>
        </button>
      </div>

      {activeInputTab === 'live' && linksEnabled && <LivePanel watermark={watermark} onWatermarkChange={onWatermarkChange} />}

      {/* TAB 1: YOUTUBE LINK INPUT */}
      {activeInputTab === 'youtube' && linksEnabled && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div>
              <label className="text-xs font-bold text-slate-200 mb-1.5 flex items-center">
                <SquarePlay className="w-4 h-4 mr-1.5 text-rose-500" />
                Pega el enlace del video:
              </label>
              <p className="text-[11px] text-slate-400 mb-3">
                YouTube, Kick, Twitch, Vimeo, TikTok y más de 1700 sitios. Si el video trae subtítulos, los aprovecha para analizar al instante.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleFetchYouTube();
                }}
                className="flex flex-col sm:flex-row gap-2"
              >
                <div className="relative flex-1">
                  <input
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=...  ·  https://kick.com/canal/videos/..."
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    disabled={disabled || isLoadingYoutube}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-rose-500"
                    id="youtube-url-input"
                  />
                </div>
                <button
                  type="submit"
                  disabled={disabled || isLoadingYoutube || !youtubeUrl.trim()}
                  className="px-5 py-2.5 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white rounded-xl text-xs sm:text-sm font-bold transition-all shadow-md shadow-rose-600/25 flex items-center justify-center space-x-2 disabled:opacity-50"
                  id="fetch-youtube-btn"
                >
                  {isLoadingYoutube ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Obteniendo...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-amber-300" />
                      <span>Cargar Video</span>
                    </>
                  )}
                </button>
              </form>
            </div>

          </div>
        </div>
      )}

      {/* TAB 2: LOCAL FILE UPLOAD */}
      {activeInputTab === 'upload' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div
            id="video-dropzone"
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => !disabled && fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
              dragActive
                ? 'border-indigo-500 bg-indigo-500/10 scale-[1.01]'
                : 'border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/90'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileChange}
              disabled={disabled}
              className="hidden"
              id="video-file-input"
            />
            <div className="w-14 h-14 mx-auto rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3 shadow-inner">
              <Upload className="w-7 h-7" />
            </div>
            <h3 className="text-base sm:text-lg font-bold text-white mb-1">
              Arrastra tu archivo aquí o <span className="text-indigo-400 underline decoration-indigo-400/40">haz clic para examinar</span>
            </h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Soporta archivos MP4, WebM, MOV de cualquier tamaño. Procesamiento seguro en tu navegador.
            </p>
          </div>

          {/* Direct MP4 URL alternative */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 flex flex-col sm:flex-row items-center gap-2">
            <span className="text-xs text-slate-400 shrink-0 flex items-center">
              <LinkIcon className="w-3.5 h-3.5 mr-1 text-indigo-400" />
              O URL directa MP4:
            </span>
            <input
              type="url"
              placeholder="https://ejemplo.com/video.mp4"
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              disabled={disabled}
              className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              id="direct-mp4-url-input"
            />
            <button
              type="button"
              onClick={handleDirectUrlSubmit}
              disabled={disabled || !directUrl.trim()}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 shrink-0"
            >
              Cargar URL
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: DEMO SAMPLES */}
      {activeInputTab === 'samples' && (
        <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-5 space-y-4 animate-in fade-in duration-200">
          <label className="text-xs font-bold text-slate-200 flex items-center">
            <Play className="w-4 h-4 mr-1.5 text-emerald-400" />
            Videos de Prueba Rápidos (Sin necesidad de subir nada)
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SAMPLE_VIDEOS.map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => loadSampleLocal(sample.url)}
                disabled={disabled}
                className="p-3.5 bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-indigo-500/50 rounded-xl text-left transition-all flex items-start space-x-3 group disabled:opacity-50"
              >
                <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-600 group-hover:text-white transition-colors shrink-0 mt-0.5">
                  <FileVideo className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white group-hover:text-indigo-300 transition-colors">
                    {sample.name}
                  </h4>
                  <p className="text-[11px] text-slate-400 mt-0.5">{sample.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* AI Prompt / Context Hint */}
      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
        <label className="text-xs font-semibold text-slate-300 mb-1.5 flex items-center">
          <Sparkles className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
          Instrucciones personalizadas para la IA (Opcional)
        </label>
        <input
          type="text"
          placeholder="Ej: 'Priorizar momentos cómicos', 'Extraer consejos de finanzas/negocios', 'Buscar debates con opiniones contrarias'"
          value={contextNotes}
          onChange={(e) => setContextNotes(e.target.value)}
          disabled={disabled || isLoadingYoutube}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
          id="custom-instructions-input"
        />
        <p className="text-[11px] text-slate-400 mt-1">
          La selección de clips y la redacción se ajustarán según este objetivo.
        </p>
      </div>

      {/* Loading Status */}
      {isLoadingYoutube && statusMessage && (
        <div className="p-3 bg-indigo-950/50 border border-indigo-500/30 rounded-xl text-indigo-200 text-xs flex items-center space-x-2">
          <Loader2 className="w-4 h-4 text-indigo-400 animate-spin shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {/* Error Alert */}
      {errorMessage && (
        <div className="p-3 bg-rose-950/70 border border-rose-800 rounded-xl text-rose-200 text-xs flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}
    </div>
  );
};
