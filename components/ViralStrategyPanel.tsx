import React, { useState } from 'react';
import { ClipIdea, GeneratedHook } from '../types';
import { Sparkles, Copy, Check, Flame, ArrowLeft, Download, RefreshCw, Tag, Send, AlertCircle } from 'lucide-react';
import { downloadSocialKit } from '../video-export';
import { postJson } from '../api-client';

interface ViralStrategyPanelProps {
  clip: ClipIdea;
  onBack: () => void;
}

export const ViralStrategyPanel: React.FC<ViralStrategyPanelProps> = ({ clip, onBack }) => {
  const [copiedCaption, setCopiedCaption] = useState<boolean>(false);
  const [copiedHashtags, setCopiedHashtags] = useState<boolean>(false);
  const [copiedHook, setCopiedHook] = useState<string | null>(null);
  const [hooksError, setHooksError] = useState<string | null>(null);
  const [isGeneratingHooks, setIsGeneratingHooks] = useState<boolean>(false);
  const [generatedHooks, setGeneratedHooks] = useState<GeneratedHook[]>([]);

  const copyToClipboard = (text: string, type: 'caption' | 'hashtags' | 'hook', hookId?: string) => {
    navigator.clipboard.writeText(text);
    if (type === 'caption') {
      setCopiedCaption(true);
      setTimeout(() => setCopiedCaption(false), 2000);
    } else if (type === 'hashtags') {
      setCopiedHashtags(true);
      setTimeout(() => setCopiedHashtags(false), 2000);
    } else if (type === 'hook' && hookId) {
      setCopiedHook(hookId);
      setTimeout(() => setCopiedHook(null), 2000);
    }
  };

  const handleGenerateAlternativeHooks = async () => {
    setIsGeneratingHooks(true);
    setHooksError(null);
    try {
      const data = await postJson<{ hooks?: GeneratedHook[] }>('/api/generate-hooks', {
        title: clip.title,
        description: clip.description,
        soundBite: clip.soundBiteQuote || clip.hook,
      });
      if (data.hooks && data.hooks.length > 0) {
        setGeneratedHooks(data.hooks);
      } else {
        setHooksError('La IA no devolvió ganchos alternativos. Inténtalo de nuevo.');
      }
    } catch (err) {
      // The previous version only logged this, so a failed request looked
      // identical to a successful one that returned nothing.
      setHooksError(err instanceof Error ? err.message : 'Error al generar ganchos.');
    } finally {
      setIsGeneratingHooks(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
          Volver a Clips
        </button>
        <button
          type="button"
          onClick={() => downloadSocialKit(clip)}
          className="inline-flex items-center text-xs font-semibold text-indigo-300 hover:text-white bg-indigo-950/60 border border-indigo-500/30 hover:bg-indigo-900/60 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Descargar Kit Estratégico (.TXT)
        </button>
      </div>

      {/* Virality Overview Card */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950/50 rounded-2xl border border-indigo-500/20 p-5 space-y-4 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">
              Estrategia de Viralidad
            </span>
            <h3 className="text-base font-bold text-white mt-0.5">{clip.title}</h3>
          </div>
          <div className="flex items-center space-x-1.5 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-xl font-bold text-amber-300 text-sm">
            <Flame className="w-4 h-4 text-amber-400" />
            <span>{clip.viralityScore}/100</span>
          </div>
        </div>

        {/* 4 Score Metrics */}
        {clip.viralityMetrics && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[11px] text-slate-400 font-medium block mb-1">Impacto de Gancho</span>
              <span className="text-lg font-black text-emerald-400">{clip.viralityMetrics.hookImpact}%</span>
            </div>
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[11px] text-slate-400 font-medium block mb-1">Retención Estimada</span>
              <span className="text-lg font-black text-indigo-400">{clip.viralityMetrics.retentionPotential}%</span>
            </div>
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[11px] text-slate-400 font-medium block mb-1">Compartibilidad</span>
              <span className="text-lg font-black text-amber-400">{clip.viralityMetrics.shareability}%</span>
            </div>
            <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 text-center">
              <span className="text-[11px] text-slate-400 font-medium block mb-1">Detonante</span>
              <span className="text-xs font-bold text-slate-200 truncate block mt-1">
                {clip.viralityMetrics.emotionalTrigger}
              </span>
            </div>
          </div>
        )}

        <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/80">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
            ¿Por qué funcionará?
          </span>
          <p className="text-xs text-slate-300 leading-relaxed">{clip.viralityJustification}</p>
        </div>
      </div>

      {/* Alternative Hooks Generator */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h4 className="text-sm font-bold text-white">Generador de Ganchos Alternativos (Hooks A/B)</h4>
          </div>
          <button
            type="button"
            onClick={handleGenerateAlternativeHooks}
            disabled={isGeneratingHooks}
            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold transition-colors flex items-center space-x-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isGeneratingHooks ? 'animate-spin' : ''}`} />
            <span>{isGeneratingHooks ? 'Generando...' : 'Generar 5 Hooks'}</span>
          </button>
        </div>

        {/* Primary Hook */}
        <div className="bg-slate-950 rounded-xl p-3.5 border border-slate-800 flex items-center justify-between gap-3">
          <div>
            <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider block">
              Gancho Principal Sugerido
            </span>
            <p className="text-xs font-bold text-white mt-0.5 italic">"{clip.hook}"</p>
          </div>
          <button
            type="button"
            onClick={() => copyToClipboard(clip.hook, 'hook', 'main')}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg shrink-0 transition-colors"
            title="Copiar gancho"
          >
            {copiedHook === 'main' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        {/* Generated hooks list */}
        {hooksError && (
          <div className="p-3 bg-rose-950/70 border border-rose-800 rounded-xl text-xs text-rose-200 flex items-start space-x-2">
            <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
            <span>{hooksError}</span>
          </div>
        )}

        {generatedHooks.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-slate-800">
            <span className="text-[11px] font-semibold text-slate-400">Variantes para Pruebas A/B:</span>
            {generatedHooks.map((h, i) => (
              <div
                key={i}
                className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 flex items-start justify-between gap-3"
              >
                <div className="space-y-0.5 flex-1">
                  <span className="inline-block text-[10px] font-bold text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded">
                    {h.style}
                  </span>
                  <p className="text-xs font-bold text-slate-100 italic">"{h.hookText}"</p>
                  <p className="text-[11px] text-slate-500">{h.explanation}</p>
                </div>
                <button
                  type="button"
                  onClick={() => copyToClipboard(h.hookText, 'hook', `hook_${i}`)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg shrink-0 transition-colors"
                  title="Copiar este gancho"
                >
                  {copiedHook === `hook_${i}` ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Social Post Copy & Hashtags */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Send className="w-4 h-4 text-indigo-400" />
            <h4 className="text-sm font-bold text-white">Copy Listo para Publicar</h4>
          </div>
          <button
            type="button"
            onClick={() => copyToClipboard(clip.socialPost?.caption || '', 'caption')}
            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center space-x-1"
          >
            {copiedCaption ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedCaption ? '¡Copiado!' : 'Copiar Texto'}</span>
          </button>
        </div>

        {/* Caption */}
        <div className="bg-slate-950 rounded-xl p-3.5 border border-slate-800">
          <p className="text-xs text-slate-200 whitespace-pre-line leading-relaxed font-sans">
            {clip.socialPost?.caption || 'Sin texto generado'}
          </p>
        </div>

        {/* Hashtags */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-400 flex items-center">
              <Tag className="w-3 h-3 mr-1 text-slate-500" />
              Hashtags Optimizados para Algoritmo:
            </span>
            <button
              type="button"
              onClick={() => copyToClipboard((clip.socialPost?.hashtags || []).join(' '), 'hashtags')}
              className="text-[11px] text-indigo-400 hover:underline flex items-center space-x-1"
            >
              {copiedHashtags ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              <span>{copiedHashtags ? 'Copiados' : 'Copiar Hashtags'}</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(clip.socialPost?.hashtags || ['#viral', '#shorts', '#reels']).map((tag, i) => (
              <span
                key={i}
                className="px-2.5 py-1 rounded-lg bg-slate-950 text-indigo-300 border border-slate-800 text-xs font-mono font-medium"
              >
                {tag.startsWith('#') ? tag : `#${tag}`}
              </span>
            ))}
          </div>
        </div>

        {/* Call to Action */}
        <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 flex items-center justify-between text-xs">
          <span className="text-slate-400">Llamada a la Acción (CTA):</span>
          <span className="font-semibold text-amber-300">{clip.socialPost?.callToAction || 'Comenta abajo 👇'}</span>
        </div>
      </div>
    </div>
  );
};
