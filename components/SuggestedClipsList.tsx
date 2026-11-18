import React, { useState } from 'react';
import { Sparkles, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import {
  ClipIdea,
  SubtitleStyleType,
  SubtitleAnimationType,
  AspectRatioType,
  type FramingMode,
  type SpeakerRegion,
  type GameplayLayout,
  type WatermarkSettings,
} from '../types';
import { ClipCard } from './ClipCard';
import { BatchExportPanel } from './BatchExportPanel';
import { downloadSrtFile } from '../video-export';

interface SuggestedClipsListProps {
  clips: ClipIdea[];
  summary?: string;
  selectedClipId: string | null;
  isPlaying?: boolean;
  onSelectClip: (clip: ClipIdea) => void;
  onPreviewClip?: (clip: ClipIdea) => void;
  onOpenViralStrategy: (clip: ClipIdea) => void;
  onOpenSubtitleEditor: (clip: ClipIdea) => void;
  onOpenExportModal: (clip: ClipIdea) => void;
  sourceId?: string | null;
  exportEngine?: 'ffmpeg' | 'browser';
  subtitleStyle?: SubtitleStyleType;
  subtitleAnimation?: SubtitleAnimationType;
  aspectRatio?: AspectRatioType;
  /** Framing, marks and streamer layout chosen under the player, for the batch. */
  framingMode?: FramingMode;
  speakers?: SpeakerRegion[];
  gameplayLayout?: GameplayLayout;
  watermark?: WatermarkSettings | null;
}

export const SuggestedClipsList: React.FC<SuggestedClipsListProps> = ({
  clips,
  summary,
  selectedClipId,
  isPlaying = false,
  onSelectClip,
  onPreviewClip,
  onOpenViralStrategy,
  onOpenSubtitleEditor,
  onOpenExportModal,
  sourceId = null,
  exportEngine = 'browser',
  subtitleStyle = SubtitleStyleType.PILL,
  subtitleAnimation = 'word-pop',
  aspectRatio = '9:16',
  framingMode,
  speakers,
  gameplayLayout,
  watermark,
}) => {
  const [platformFilter, setPlatformFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'virality' | 'time' | 'duration'>('virality');

  if (!clips || clips.length === 0) {
    return (
      <div className="p-8 text-center bg-slate-900/40 rounded-2xl border border-slate-800">
        <Sparkles className="w-8 h-8 text-slate-600 mx-auto mb-2 animate-pulse" />
        <p className="text-slate-400 text-sm font-medium">Aún no hay clips generados.</p>
        <p className="text-slate-500 text-xs mt-1">Sube un video y haz clic en "Analizar Video" para comenzar.</p>
      </div>
    );
  }

  // Filter clips
  let filtered = [...clips];
  if (platformFilter !== 'all') {
    filtered = filtered.filter((c) =>
      c.targetPlatforms.some((p) => p.toLowerCase().includes(platformFilter.toLowerCase()))
    );
  }

  // Sort clips
  if (sortBy === 'virality') {
    filtered.sort((a, b) => b.viralityScore - a.viralityScore);
  } else if (sortBy === 'time') {
    filtered.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  } else if (sortBy === 'duration') {
    filtered.sort(
      (a, b) =>
        a.endTimeSeconds - a.startTimeSeconds - (b.endTimeSeconds - b.startTimeSeconds)
    );
  }

  const handleDownloadSrt = (clip: ClipIdea) => {
    downloadSrtFile(clip.suggestedSubtitles || [], `subtitulos_${clip.title}`);
  };

  return (
    <div className="space-y-4">
      {/* Analysis summary */}
      {summary && (
        <div className="bg-gradient-to-r from-indigo-950/40 to-slate-900/90 border border-indigo-500/20 rounded-2xl p-4 space-y-1.5">
          <div className="flex items-center space-x-2 text-indigo-400 font-semibold text-xs uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Resumen del análisis</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">{summary}</p>
        </div>
      )}

      {/* Filter and Sort Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/60 p-3 rounded-xl border border-slate-800 text-xs">
        <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 sm:pb-0">
          <span className="text-slate-400 font-medium mr-1 flex items-center">
            <SlidersHorizontal className="w-3 h-3 mr-1" /> Filtro:
          </span>
          {['all', 'TikTok', 'Reels', 'Shorts'].map((platform) => (
            <button
              key={platform}
              type="button"
              onClick={() => setPlatformFilter(platform)}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors ${
                platformFilter === platform
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {platform === 'all' ? 'Todos' : platform}
            </button>
          ))}
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-medium flex items-center">
            <ArrowUpDown className="w-3 h-3 mr-1" /> Ordenar:
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1 text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="virality">Mayor Viralidad</option>
            <option value="time">Cronológico</option>
            <option value="duration">Más Cortos</option>
          </select>
        </div>
      </div>

      {/* Batch export */}
      <BatchExportPanel
        clips={filtered}
        sourceId={sourceId}
        exportEngine={exportEngine}
        defaultStyle={subtitleStyle}
        defaultAnimation={subtitleAnimation}
        defaultAspectRatio={aspectRatio}
        defaultFramingMode={framingMode}
        speakers={speakers}
        gameplayLayout={gameplayLayout}
        watermark={watermark}
      />

      {/* Clips Cards List */}
      <div className="space-y-3.5">
        {filtered.map((clip) => (
          <ClipCard
            key={clip.clipId}
            clip={clip}
            isSelected={clip.clipId === selectedClipId}
            isPlaying={isPlaying && clip.clipId === selectedClipId}
            onSelect={() => onSelectClip(clip)}
            onPreview={() => (onPreviewClip ? onPreviewClip(clip) : onSelectClip(clip))}
            onOpenViralStrategy={onOpenViralStrategy}
            onOpenSubtitleEditor={onOpenSubtitleEditor}
            onOpenExportModal={onOpenExportModal}
            onDownloadSrt={handleDownloadSrt}
          />
        ))}
      </div>
    </div>
  );
};
