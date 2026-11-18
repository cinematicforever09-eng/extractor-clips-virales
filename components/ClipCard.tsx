import React from 'react';
import { Play, Pause, Flame, Sparkles, Download, FileText, Share2 } from 'lucide-react';
import { ClipIdea } from '../types';

interface ClipCardProps {
  clip: ClipIdea;
  isSelected: boolean;
  isPlaying?: boolean;
  onSelect: () => void;
  onPreview?: () => void;
  onOpenViralStrategy: (clip: ClipIdea) => void;
  onOpenSubtitleEditor: (clip: ClipIdea) => void;
  onOpenExportModal: (clip: ClipIdea) => void;
  onDownloadSrt: (clip: ClipIdea) => void;
}

export const ClipCard: React.FC<ClipCardProps> = ({
  clip,
  isSelected,
  isPlaying = false,
  onSelect,
  onPreview,
  onOpenViralStrategy,
  onOpenSubtitleEditor,
  onOpenExportModal,
  onDownloadSrt,
}) => {
  const duration = Math.round(clip.endTimeSeconds - clip.startTimeSeconds);
  const isActivelyPlaying = isSelected && isPlaying;

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const getViralityColor = (score: number) => {
    if (score >= 85) return 'from-emerald-500 to-teal-600 text-emerald-300 border-emerald-500/30 bg-emerald-500/10';
    if (score >= 70) return 'from-amber-500 to-yellow-600 text-amber-300 border-amber-500/30 bg-amber-500/10';
    return 'from-slate-500 to-slate-600 text-slate-300 border-slate-500/30 bg-slate-500/10';
  };

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onPreview) {
      onPreview();
    } else {
      onSelect();
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`rounded-2xl p-5 transition-all border cursor-pointer relative overflow-hidden ${
        isSelected
          ? 'bg-slate-900 border-indigo-500 ring-2 ring-indigo-500/30 shadow-xl shadow-indigo-950/40 scale-[1.01]'
          : 'bg-slate-900/70 border-slate-800 hover:border-slate-700 hover:bg-slate-900/90'
      }`}
    >
      {/* Playing state top glow strip */}
      {isActivelyPlaying && (
        <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-indigo-500 animate-pulse" />
      )}

      {/* Header: Title, Duration and Virality Score */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center space-x-2 mb-1 flex-wrap gap-y-1">
            <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
              {formatTime(clip.startTimeSeconds)} - {formatTime(clip.endTimeSeconds)} ({duration}s)
            </span>
            {isActivelyPlaying && (
              <span className="px-2 py-0.5 rounded-md text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex items-center space-x-1 animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>Reproduciendo...</span>
              </span>
            )}
            <div className="flex gap-1">
              {clip.targetPlatforms.map((p) => (
                <span
                  key={p}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-800/80 text-slate-400"
                >
                  {p}
                </span>
              ))}
            </div>
          </div>
          <h3 className="text-base font-bold text-white tracking-tight leading-snug line-clamp-1">
            {clip.title}
          </h3>
        </div>

        {/* Virality Score Badge */}
        <div
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border font-bold text-sm shrink-0 ${getViralityColor(
            clip.viralityScore
          )}`}
        >
          <Flame className="w-4 h-4 text-amber-400" />
          <span>{clip.viralityScore}/100</span>
        </div>
      </div>

      {/* Opening Hook Highlight */}
      <div className="bg-slate-950/70 rounded-xl p-3 border border-slate-800/80 mb-3 space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center space-x-1">
          <Sparkles className="w-3 h-3" />
          <span>Gancho Inicial (0-3s):</span>
        </div>
        <p className="text-xs font-semibold text-slate-200 italic">
          "{clip.hook || clip.title}"
        </p>
      </div>

      {/* Description & Justification */}
      <p className="text-xs text-slate-400 mb-3 line-clamp-2 leading-relaxed">
        {clip.description}
      </p>

      {/* Metrics Mini-Grid */}
      {clip.viralityMetrics && (
        <div className="grid grid-cols-3 gap-2 mb-4 text-center">
          <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
            <span className="block text-[10px] text-slate-400 font-medium">Impacto Gancho</span>
            <span className="text-xs font-bold text-emerald-400">{clip.viralityMetrics.hookImpact}%</span>
          </div>
          <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
            <span className="block text-[10px] text-slate-400 font-medium">Retención</span>
            <span className="text-xs font-bold text-indigo-400">{clip.viralityMetrics.retentionPotential}%</span>
          </div>
          <div className="bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
            <span className="block text-[10px] text-slate-400 font-medium">Emoción</span>
            <span className="text-[11px] font-bold text-amber-300 truncate block">
              {clip.viralityMetrics.emotionalTrigger || 'Curiosidad'}
            </span>
          </div>
        </div>
      )}

      {/* Action Buttons Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={handlePreviewClick}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center space-x-1.5 ${
              isActivelyPlaying
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white'
            }`}
            title={isActivelyPlaying ? 'Pausar previsualización' : 'Previsualizar clip en el reproductor'}
          >
            {isActivelyPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 text-emerald-400" />
                <span>Pausar</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-emerald-400" />
                <span>Previsualizar</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenViralStrategy(clip);
            }}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1.5"
            title="Ver estrategia, ganchos y copy de publicación"
          >
            <Share2 className="w-3.5 h-3.5 text-indigo-400" />
            <span>Estrategia Viral</span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSubtitleEditor(clip);
            }}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition-colors flex items-center space-x-1.5"
            title="Editar subtítulos y tiempos"
          >
            <FileText className="w-3.5 h-3.5 text-amber-400" />
            <span>Subtítulos ({clip.suggestedSubtitles?.length || 0})</span>
          </button>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenExportModal(clip);
          }}
          className="px-3.5 py-1.5 bg-gradient-to-r from-indigo-600 to-rose-600 hover:from-indigo-500 hover:to-rose-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-indigo-600/20 flex items-center space-x-1.5"
          title="Descargar clip recortado con subtítulos"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Exportar Video</span>
        </button>
      </div>
    </div>
  );
};
