import React, { useEffect, useRef, useState } from 'react';
import {
  Layers,
  Play,
  Square,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Smartphone,
  Info,
} from 'lucide-react';
import {
  ClipIdea,
  SubtitleStyleType,
  AspectRatioType,
  SubtitleAnimationType,
  FramingMode,
  type SpeakerRegion,
  type GameplayLayout,
  type WatermarkSettings,
} from '../types';
import { SUBTITLE_STYLES, SUBTITLE_ANIMATIONS, FRAMING_MODES } from '../constants';
import { exportClipOnServer, FfmpegUnavailable } from '../api-client';

interface BatchExportPanelProps {
  clips: ClipIdea[];
  sourceId: string | null;
  exportEngine: 'ffmpeg' | 'browser';
  defaultStyle: SubtitleStyleType;
  defaultAnimation: SubtitleAnimationType;
  defaultAspectRatio: AspectRatioType;
  /** What was chosen under the player; the batch starts from it. */
  defaultFramingMode?: FramingMode;
  /**
   * Regions marked under the player. Without them the batch used to send no
   * marks at all, so 'Streamer + juego' guessed the webcam was bottom-right
   * and focus/split cropped the centre - silently, on every clip.
   */
  speakers?: SpeakerRegion[];
  gameplayLayout?: GameplayLayout;
  /** The logo set under the player; every clip in the batch gets it. */
  watermark?: WatermarkSettings | null;
}

/** Marks each framing needs before its crop means anything. */
const REGIONS_NEEDED: Partial<Record<FramingMode, number>> = {
  focus: 1,
  split: 2,
  'auto-fill': 2,
  gameplay: 1,
};

type ClipStatus = 'pending' | 'running' | 'done' | 'error';

interface ClipResult {
  status: ClipStatus;
  message?: string;
}

/**
 * Exports every selected clip in one go.
 *
 * Sequential on purpose: FFmpeg saturates the CPU on a single clip, so running
 * several at once makes the whole batch slower and starves the preview. At
 * roughly four times real time, a dozen thirty-second clips still finish in
 * about two minutes.
 *
 * Only offered when the server can render. The browser fallback records in real
 * time and fires a download per clip, which for a dozen clips means a dozen
 * save prompts spread over ten minutes - worse than doing them by hand.
 */
export const BatchExportPanel: React.FC<BatchExportPanelProps> = ({
  clips,
  sourceId,
  exportEngine,
  defaultStyle,
  defaultAnimation,
  defaultAspectRatio,
  defaultFramingMode,
  speakers = [],
  gameplayLayout,
  watermark,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(clips.map((c) => c.clipId)));
  const [results, setResults] = useState<Record<string, ClipResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  // A ref, not state: the loop below runs to completion in one tick of the
  // event loop and would only ever see the state value captured at its start.
  const cancelRef = useRef(false);
  const [currentTitle, setCurrentTitle] = useState<string>('');

  // A fresh analysis replaces the whole clip list, so the selection has to be
  // rebuilt rather than left pointing at ids that no longer exist.
  useEffect(() => {
    setSelected(new Set(clips.map((c) => c.clipId)));
    setResults({});
  }, [clips]);

  const [style, setStyle] = useState<SubtitleStyleType>(defaultStyle);
  const [animation, setAnimation] = useState<SubtitleAnimationType>(defaultAnimation);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioType>(defaultAspectRatio);
  const [framingMode, setFramingMode] = useState<FramingMode>(defaultFramingMode ?? 'blur-fill');

  // Follow the choice under the player: picking "Streamer + juego" there and
  // then exporting the batch in blur-fill would be the opposite of what was meant.
  useEffect(() => {
    if (defaultFramingMode) setFramingMode(defaultFramingMode);
  }, [defaultFramingMode]);

  const regionsNeeded = REGIONS_NEEDED[framingMode] ?? 0;
  const missingRegions = Math.max(0, regionsNeeded - speakers.length);

  const available = exportEngine === 'ffmpeg' && Boolean(sourceId);
  const selectedClips = clips.filter((c) => selected.has(c.clipId));
  const doneCount = Object.values(results).filter((r) => r.status === 'done').length;
  const errorCount = Object.values(results).filter((r) => r.status === 'error').length;

  const toggle = (clipId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === clips.length ? new Set() : new Set(clips.map((c) => c.clipId))));
  };

  const runBatch = async () => {
    if (!sourceId || selectedClips.length === 0) return;

    setIsRunning(true);
    setCancelRequested(false);
    cancelRef.current = false;
    setResults({});

    for (const clip of selectedClips) {
      if (cancelRef.current) break;

      setCurrentTitle(clip.title);
      setResults((prev) => ({ ...prev, [clip.clipId]: { status: 'running' } }));

      try {
        await exportClipOnServer({
          sourceId,
          clipTitle: clip.title,
          startSeconds: clip.startTimeSeconds,
          durationSeconds: Math.max(0.5, clip.endTimeSeconds - clip.startTimeSeconds),
          aspectRatio,
          framingMode,
          speakers: regionsNeeded > 0 ? speakers : undefined,
          gameplayLayout: framingMode === 'gameplay' ? gameplayLayout : undefined,
          watermark,
          subtitles: clip.suggestedSubtitles || [],
          subtitleStyle: style,
          subtitlePosition: 'bottom',
          subtitleAnimation: animation,
          burnSubtitles: true,
        });
        setResults((prev) => ({ ...prev, [clip.clipId]: { status: 'done' } }));
      } catch (err) {
        const message =
          err instanceof FfmpegUnavailable
            ? 'FFmpeg dejó de estar disponible.'
            : err instanceof Error
              ? err.message
              : 'Error desconocido.';
        setResults((prev) => ({ ...prev, [clip.clipId]: { status: 'error', message } }));
        // A missing binary will fail for every remaining clip too.
        if (err instanceof FfmpegUnavailable) break;
      }

      // Give the browser a moment between downloads; Chrome throttles bursts.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    setCurrentTitle('');
    setIsRunning(false);
  };

  if (!available) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex items-start space-x-2 text-[11px] text-slate-400">
        <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
        <span className="leading-relaxed">
          {!sourceId
            ? 'La exportación en lote estará disponible en cuanto el video termine de prepararse.'
            : 'La exportación en lote necesita FFmpeg. Sin él, el navegador graba en tiempo real y abriría una descarga por clip.'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between p-3 hover:bg-slate-900 transition-colors"
      >
        <span className="flex items-center space-x-2 text-xs font-bold text-white">
          <Layers className="w-4 h-4 text-emerald-400" />
          <span>Exportar varios clips de una vez</span>
        </span>
        <span className="text-[11px] text-slate-400">
          {isOpen ? 'Ocultar' : `${clips.length} disponibles`}
        </span>
      </button>

      {isOpen && (
        <div className="p-3 pt-0 space-y-3">
          {/* Shared settings for the whole batch */}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-slate-400 space-y-1">
              <span className="block font-semibold">Formato</span>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as AspectRatioType)}
                disabled={isRunning}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 disabled:opacity-50"
              >
                <option value="9:16">9:16 Vertical</option>
                <option value="1:1">1:1 Cuadrado</option>
                <option value="16:9">16:9 Horizontal</option>
              </select>
            </label>

            <label className="text-[11px] text-slate-400 space-y-1">
              <span className="block font-semibold">Encuadre</span>
              <select
                value={framingMode}
                onChange={(e) => setFramingMode(e.target.value as FramingMode)}
                disabled={isRunning}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 disabled:opacity-50"
              >
                {FRAMING_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.name}
                  </option>
                ))}
              </select>
            </label>

            {missingRegions > 0 && (
              <p className="sm:col-span-full text-[11px] text-amber-300 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {framingMode === 'gameplay'
                  ? 'Marca la cámara del streamer bajo el reproductor antes de exportar en lote; si no, se adivina una esquina para todos los clips.'
                  : `Faltan ${missingRegions} marca${missingRegions > 1 ? 's' : ''} bajo el reproductor; sin ellas el lote recorta el centro.`}
              </p>
            )}

            <label className="text-[11px] text-slate-400 space-y-1">
              <span className="block font-semibold">Estilo</span>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value as SubtitleStyleType)}
                disabled={isRunning}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 disabled:opacity-50"
              >
                {SUBTITLE_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[11px] text-slate-400 space-y-1">
              <span className="block font-semibold">Animación</span>
              <select
                value={animation}
                onChange={(e) => setAnimation(e.target.value as SubtitleAnimationType)}
                disabled={isRunning}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200 disabled:opacity-50"
              >
                {SUBTITLE_ANIMATIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Clip picker */}
          <div className="border border-slate-800 rounded-lg divide-y divide-slate-800/70 max-h-52 overflow-y-auto">
            <button
              type="button"
              onClick={toggleAll}
              disabled={isRunning}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-semibold text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
            >
              {selected.size === clips.length ? 'Quitar todos' : 'Seleccionar todos'}
            </button>

            {clips.map((clip) => {
              const result = results[clip.clipId];
              return (
                <label
                  key={clip.clipId}
                  className="flex items-center space-x-2 px-2.5 py-1.5 text-[11px] cursor-pointer hover:bg-slate-950/50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(clip.clipId)}
                    onChange={() => toggle(clip.clipId)}
                    disabled={isRunning}
                    className="accent-indigo-500"
                  />
                  <span className="flex-1 truncate text-slate-300">{clip.title}</span>
                  <span className="text-slate-500 font-mono shrink-0">
                    {Math.round(clip.endTimeSeconds - clip.startTimeSeconds)}s
                  </span>
                  {result?.status === 'running' && (
                    <Loader2 className="w-3 h-3 text-indigo-400 animate-spin shrink-0" />
                  )}
                  {result?.status === 'done' && (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  )}
                  {result?.status === 'error' && (
                    <AlertCircle className="w-3 h-3 text-rose-400 shrink-0" />
                  )}
                </label>
              );
            })}
          </div>

          {isRunning && (
            <div className="text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-2.5">
              <div className="flex items-center space-x-1.5">
                <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                <span className="truncate">
                  Exportando {doneCount + errorCount + 1} de {selectedClips.length}: {currentTitle}
                </span>
              </div>
              {cancelRequested && (
                <p className="text-amber-300 mt-1">
                  Se detendrá al terminar el clip en curso.
                </p>
              )}
            </div>
          )}

          {!isRunning && doneCount + errorCount > 0 && (
            <div className="text-[11px] bg-slate-950 border border-slate-800 rounded-lg p-2.5 space-y-1">
              <p className="text-emerald-300 font-semibold">
                {doneCount} clip{doneCount === 1 ? '' : 's'} exportado
                {doneCount === 1 ? '' : 's'} a tu carpeta de descargas.
              </p>
              {errorCount > 0 && (
                <p className="text-rose-300">
                  {errorCount} fallaron. Pasa el ratón por el icono rojo para ver el motivo.
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500 flex items-center space-x-1">
              <Smartphone className="w-3 h-3" />
              <span>
                {selectedClips.length} seleccionado{selectedClips.length === 1 ? '' : 's'}
              </span>
            </span>

            {isRunning ? (
              <button
                type="button"
                onClick={() => {
                  cancelRef.current = true;
                  setCancelRequested(true);
                }}
                disabled={cancelRequested}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center space-x-1.5 disabled:opacity-50"
              >
                <Square className="w-3 h-3" />
                <span>Detener</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={runBatch}
                disabled={selectedClips.length === 0}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold flex items-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Play className="w-3 h-3" />
                <span>Exportar {selectedClips.length}</span>
              </button>
            )}
          </div>

          <p className="text-[10px] text-slate-500 leading-relaxed">
            El navegador puede pedirte permiso para descargar varios archivos seguidos. Acéptalo
            una vez y el resto bajan solos.
          </p>
        </div>
      )}
    </div>
  );
};
