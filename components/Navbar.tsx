import React from 'react';
import { Sparkles, Flame, RefreshCw } from 'lucide-react';

interface NavbarProps {
  onReset: () => void;
  hasVideo: boolean;
  isAnalyzing: boolean;
  /** Real engine state; the badge used to be green no matter what. */
  engine?: { gpu: boolean; model: string | null } | null;
}

export const Navbar: React.FC<NavbarProps> = ({ onReset, hasVideo, isAnalyzing, engine }) => {
  return (
    <header className="w-full border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 via-rose-500 to-indigo-600 p-0.5 flex items-center justify-center shadow-lg shadow-rose-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <Flame className="w-5 h-5 text-amber-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg text-white tracking-tight">ViralClip AI</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <Sparkles className="w-3 h-3 mr-1" /> 100% local
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">Extractor y Editor de Clips Virales para TikTok, Reels y Shorts</p>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          {hasVideo && (
            <button
              id="reset-video-btn"
              onClick={onReset}
              disabled={isAnalyzing}
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Cambiar Video
            </button>
          )}

{/* The old badge read "Motor IA Activo" and was green even with nothing
             installed. This reports what is actually loaded. */}
          {engine && (
            <div className="hidden sm:flex items-center space-x-2 text-xs bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg">
              <span
                className={`w-2 h-2 rounded-full ${engine.model ? 'bg-emerald-400' : 'bg-amber-400'}`}
              />
              <span className="font-medium text-slate-300">
                {engine.gpu ? 'GPU' : 'CPU'}
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{engine.model || 'sin modelo'}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
