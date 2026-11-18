import React, { useState, useMemo } from 'react';
import { SubtitleLine, ClipIdea, SubtitleStyleType, SubtitleWordTiming } from '../types';
import { WordEmojiPicker } from './WordEmojiPicker';
import { SUBTITLE_STYLES } from '../constants';
import { Plus, Trash2, Clock, Download, ArrowLeft, Sparkles, Check, Play, Mic, Loader2, Volume2, RefreshCw, CheckCircle2, AlertCircle, Smile } from 'lucide-react';
import { downloadSrtFile, downloadVttFile } from '../video-export';
import { postJson } from '../api-client';

interface SubtitleEditorProps {
  clip: ClipIdea;
  subtitles: SubtitleLine[];
  currentStyle: SubtitleStyleType;
  onStyleChange: (style: SubtitleStyleType) => void;
  onSubtitlesChange: (newSubtitles: SubtitleLine[]) => void;
  onBack: () => void;
  onPreviewAtTime?: (relativeSeconds: number) => void;
  videoFile?: File | null;
  videoSrc?: string | null;
  isYouTube?: boolean;
  /** Handle for the prepared file on the server, needed to re-transcribe. */
  sourceId?: string | null;
}

const REACTION_PRESETS = [
  { label: '[Risas 😂]', tag: '[Risas 😂]' },
  { label: '¡Jajaja!', tag: '¡Jajaja!' },
  { label: '[Sorpresa 😲]', tag: '[Sorpresa 😲]' },
  { label: '[Aplausos 👏]', tag: '[Aplausos 👏]' },
  { label: '¡Guau! 🔥', tag: '¡Guau! 🔥' },
  { label: '[Suspiro 😮‍💨]', tag: '[Suspiro 😮‍💨]' },
  { label: '[Música 🎵]', tag: '[Música 🎵]' },
];

export const SubtitleEditor: React.FC<SubtitleEditorProps> = ({
  clip,
  subtitles,
  currentStyle,
  onStyleChange,
  onSubtitlesChange,
  onBack,
  onPreviewAtTime,
  videoFile,
  videoSrc,
  isYouTube,
  sourceId = null,
}) => {
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [isAligning, setIsAligning] = useState<boolean>(false);
  const [transcribeMessage, setTranscribeMessage] = useState<string>('');
  const [transcribeSuccess, setTranscribeSuccess] = useState<boolean>(false);
  const [activeLineIdx, setActiveLineIdx] = useState<number | null>(null);

  const clipDuration = Math.max(1, Math.round((clip.endTimeSeconds - clip.startTimeSeconds) * 10) / 10);

  // Calculate coverage stats
  const { coveragePercent, maxEndTime, isComplete } = useMemo(() => {
    if (!subtitles || subtitles.length === 0) {
      return { coveragePercent: 0, maxEndTime: 0, isComplete: false };
    }
    const maxEnd = Math.max(...subtitles.map((s) => s.endTime || 0));
    const percent = Math.min(100, Math.round((maxEnd / clipDuration) * 100));
    return {
      coveragePercent: percent,
      maxEndTime: Math.round(maxEnd * 10) / 10,
      isComplete: percent >= 92,
    };
  }, [subtitles, clipDuration]);

  const handleTranscribeAudio = async () => {
    if (!sourceId) {
      alert('El video todavía se está preparando en el servidor.');
      return;
    }

    setIsTranscribing(true);
    setTranscribeMessage('Transcribiendo este fragmento con Whisper...');
    setTranscribeSuccess(false);

    try {
      const data = await postJson<{ subtitles?: SubtitleLine[] }>('/api/transcribe-clip', {
        sourceId,
        startSeconds: clip.startTimeSeconds,
        durationSeconds: clipDuration,
      });

      if (data.subtitles && data.subtitles.length > 0) {
        onSubtitlesChange(data.subtitles);
        setTranscribeSuccess(true);
        setTimeout(() => setTranscribeSuccess(false), 4000);
      } else {
        throw new Error('No se detectó voz en este fragmento.');
      }
    } catch (err: any) {
      console.error('Error transcribiendo:', err);
      alert(err.message || 'Error al transcribir este fragmento.');
    } finally {
      setIsTranscribing(false);
      setTranscribeMessage('');
    }
  };

  // Smooth and distribute the real existing subtitle lines smoothly across the clip duration without inventing text
  const handleSmoothTimes = () => {
    if (!subtitles || subtitles.length === 0) return;
    setIsAligning(true);
    const count = subtitles.length;
    const step = clipDuration / count;
    const smoothed = subtitles.map((sub, i) => ({
      ...sub,
      startTime: Math.round(i * step * 10) / 10,
      endTime: i === count - 1 ? clipDuration : Math.round((i + 1) * step * 10) / 10,
    }));
    onSubtitlesChange(smoothed);
    setTimeout(() => setIsAligning(false), 600);
  };

  const handleTextChange = (index: number, newText: string) => {
    const updated = [...subtitles];
    updated[index] = { ...updated[index], text: newText };
    onSubtitlesChange(updated);
  };

  const handleWordsChange = (index: number, words: SubtitleWordTiming[]) => {
    const updated = [...subtitles];
    updated[index] = { ...updated[index], words };
    onSubtitlesChange(updated);
  };

  const handleInsertReaction = (reactionTag: string) => {
    if (activeLineIdx !== null && subtitles[activeLineIdx]) {
      // Append to the active line
      const current = subtitles[activeLineIdx].text;
      const newText = current.trim() ? `${current} ${reactionTag}` : reactionTag;
      handleTextChange(activeLineIdx, newText);
    } else {
      // Add as a new reaction subtitle line
      const lastLine = subtitles[subtitles.length - 1];
      const newStart = lastLine ? lastLine.endTime : 0;
      const newEnd = Math.min(clipDuration, Math.round((newStart + 1.8) * 10) / 10);
      const newLine: SubtitleLine = {
        text: reactionTag,
        startTime: Math.round(newStart * 10) / 10,
        endTime: Math.max(newStart + 0.6, Math.round(newEnd * 10) / 10),
      };
      onSubtitlesChange([...subtitles, newLine]);
    }
  };

  const handleTimeChange = (index: number, field: 'startTime' | 'endTime', delta: number) => {
    const updated = [...subtitles];
    const currentVal = updated[index][field];
    const newVal = Math.max(0, Math.round((currentVal + delta) * 10) / 10);
    updated[index] = { ...updated[index], [field]: newVal };
    onSubtitlesChange(updated);
  };

  const handleAddLine = () => {
    const lastLine = subtitles[subtitles.length - 1];
    const newStart = lastLine ? lastLine.endTime : 0;
    const newEnd = Math.min(clipDuration, Math.round((newStart + 2.2) * 10) / 10);
    const newLine: SubtitleLine = {
      text: 'Nuevo subtítulo...',
      startTime: Math.round(newStart * 10) / 10,
      endTime: Math.max(newStart + 0.8, Math.round(newEnd * 10) / 10),
    };
    onSubtitlesChange([...subtitles, newLine]);
  };

  const handleDeleteLine = (index: number) => {
    const updated = subtitles.filter((_, i) => i !== index);
    onSubtitlesChange(updated);
  };

  const handleExportSrt = () => {
    downloadSrtFile(subtitles, `subtitulos_${clip.title}`);
  };

  const handleExportVtt = () => {
    downloadVttFile(subtitles, `subtitulos_${clip.title}`);
  };

  return (
    <div className="space-y-5">
      {/* Header with Back Button */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
          Volver a Clips
        </button>
        <div className="text-right">
          <h3 className="text-sm font-bold text-white truncate max-w-[200px] sm:max-w-xs">{clip.title}</h3>
          <p className="text-[11px] text-slate-400">
            Duración: <span className="text-amber-400 font-mono font-semibold">{clipDuration}s</span> · {subtitles.length} bloques
          </p>
        </div>
      </div>

      {/* Coverage & Timeline Status */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center space-x-1.5 font-semibold">
            {isComplete ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            )}
            <span className={isComplete ? 'text-emerald-300' : 'text-amber-300'}>
              {isComplete
                ? `Cobertura de Audio Completa (${clipDuration}s)`
                : `Línea de Tiempo: ${maxEndTime}s de ${clipDuration}s (${coveragePercent}%)`}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 font-mono">
            {maxEndTime}s / {clipDuration}s
          </span>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
          <div
            className={`h-full transition-all duration-300 ${
              isComplete ? 'bg-gradient-to-r from-emerald-500 to-teal-400' : 'bg-gradient-to-r from-amber-500 to-indigo-500'
            }`}
            style={{ width: `${coveragePercent}%` }}
          />
        </div>
      </div>

      {/* AI Audio Transcription Banner */}
      <div className="bg-gradient-to-r from-indigo-950/70 via-purple-950/50 to-slate-950 border border-indigo-500/30 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center space-x-2.5">
          <div className="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center flex-shrink-0 border border-indigo-500/30">
            <Volume2 className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs font-bold text-white flex items-center space-x-1.5">
              <span>Transcripción de Audio Fiel + Reacciones y Risas</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-semibold">IA Fidedigna</span>
            </p>
            <p className="text-[11px] text-indigo-200/80">
              {transcribeMessage || 'Transcribe con exactitud literal lo que se dice, incluyendo risas, reacciones y emociones reales.'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 ml-auto">
          <button
            type="button"
            disabled={isTranscribing}
            onClick={handleTranscribeAudio}
            className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-all flex items-center space-x-1.5 shadow-md shadow-indigo-600/30"
          >
            {isTranscribing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Transcribiendo...</span>
              </>
            ) : transcribeSuccess ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>¡Audio Transcrito con Risas!</span>
              </>
            ) : (
              <>
                <Mic className="w-3.5 h-3.5" />
                <span>{isYouTube ? 'Alinear Subtítulos' : 'Transcribir Audio Real'}</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Quick Insert Reactions & Laughter Toolbar */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-300 flex items-center">
            <Smile className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
            Insertar Reacciones, Risas y Sonidos
          </span>
          <span className="text-[10px] text-slate-400">Clic para añadir a la línea activa</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {REACTION_PRESETS.map((preset, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => handleInsertReaction(preset.tag)}
              className="px-2.5 py-1 rounded-lg bg-slate-950 hover:bg-amber-500/20 border border-slate-800 hover:border-amber-500/40 text-xs font-medium text-amber-300 hover:text-amber-200 transition-all"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Subtitle Style Picker */}
      <div className="space-y-2">
        <label className="text-xs font-semibold text-slate-300 flex items-center">
          <Sparkles className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
          Estilo Visual de Subtítulos Animados
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SUBTITLE_STYLES.map((style) => {
            const isSelected = style.id === currentStyle;
            return (
              <button
                key={style.id}
                type="button"
                onClick={() => onStyleChange(style.id)}
                className={`p-3 rounded-xl border text-left transition-all ${
                  isSelected
                    ? 'bg-slate-900 border-amber-500 ring-2 ring-amber-500/20 shadow-md'
                    : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-xs text-white">{style.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 font-medium">
                    {style.badge}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 line-clamp-1 mb-2">{style.description}</p>
                <div className="bg-slate-950 p-2 rounded-lg text-center overflow-hidden">
                  <span className={`text-xs inline-block ${style.previewClass}`}>
                    PALABRA CLAVE
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Subtitle Lines List */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-300 flex items-center">
            <Clock className="w-3.5 h-3.5 mr-1.5 text-indigo-400" />
            Líneas de Subtítulos ({subtitles.length} bloques)
          </span>

          <div className="flex items-center space-x-1.5">
            <button
              type="button"
              disabled={isAligning}
              onClick={handleSmoothTimes}
              title="Alinear tiempos de forma continua y proporcional sin alterar las palabras"
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-colors flex items-center space-x-1 border border-slate-700"
            >
              <RefreshCw className={`w-3 h-3 text-indigo-400 ${isAligning ? 'animate-spin' : ''}`} />
              <span>Alinear Tiempos</span>
            </button>

            <button
              type="button"
              onClick={handleAddLine}
              className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center space-x-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Añadir Línea</span>
            </button>
          </div>
        </div>

        <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
          {subtitles.map((sub, idx) => {
            const isActive = activeLineIdx === idx;
            return (
              <div
                key={idx}
                onClick={() => setActiveLineIdx(idx)}
                className={`border rounded-xl p-3 space-y-2 transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-slate-900 border-indigo-500/80 ring-1 ring-indigo-500/40'
                    : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center space-x-2 text-xs text-slate-400">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                      isActive ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'
                    }`}>
                      {idx + 1}
                    </span>
                    {onPreviewAtTime && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreviewAtTime(sub.startTime);
                        }}
                        className="text-[11px] text-emerald-400 hover:underline flex items-center space-x-0.5"
                      >
                        <Play className="w-2.5 h-2.5" />
                        <span>Ir a {sub.startTime.toFixed(1)}s</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                    {/* Start time adjuster */}
                    <div className="flex items-center space-x-1 bg-slate-950 px-2 py-0.5 rounded-lg border border-slate-800 text-[11px]">
                      <span className="text-slate-500">In:</span>
                      <span className="font-mono text-white">{sub.startTime.toFixed(1)}s</span>
                      <button
                        type="button"
                        onClick={() => handleTimeChange(idx, 'startTime', -0.2)}
                        className="px-1 text-slate-400 hover:text-white"
                      >
                        -
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeChange(idx, 'startTime', 0.2)}
                        className="px-1 text-slate-400 hover:text-white"
                      >
                        +
                      </button>
                    </div>

                    {/* End time adjuster */}
                    <div className="flex items-center space-x-1 bg-slate-950 px-2 py-0.5 rounded-lg border border-slate-800 text-[11px]">
                      <span className="text-slate-500">Out:</span>
                      <span className="font-mono text-white">{sub.endTime.toFixed(1)}s</span>
                      <button
                        type="button"
                        onClick={() => handleTimeChange(idx, 'endTime', -0.2)}
                        className="px-1 text-slate-400 hover:text-white"
                      >
                        -
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTimeChange(idx, 'endTime', 0.2)}
                        className="px-1 text-slate-400 hover:text-white"
                      >
                        +
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteLine(idx)}
                      className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                      title="Eliminar línea"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Subtitle text input */}
                <input
                  type="text"
                  value={sub.text}
                  onFocus={() => setActiveLineIdx(idx)}
                  onChange={(e) => handleTextChange(idx, e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-amber-400 font-medium"
                />

                {/* Only on the open line: a palette under every line at once
                    would bury the timings this panel exists for. */}
                {isActive && (
                  <div className="pt-1.5 border-t border-slate-800">
                    <WordEmojiPicker
                      line={sub}
                      onChange={(words) => handleWordsChange(idx, words)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Export Subtitle Files */}
      <div className="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-400">Exportar archivo de subtítulos:</span>
        <div className="flex space-x-2">
          <button
            type="button"
            onClick={handleExportSrt}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Descargar .SRT</span>
          </button>
          <button
            type="button"
            onClick={handleExportVtt}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Descargar .VTT</span>
          </button>
        </div>
      </div>
    </div>
  );
};
