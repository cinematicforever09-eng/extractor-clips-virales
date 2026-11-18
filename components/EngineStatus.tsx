import React from 'react';
import { Cpu, Zap, Mic, Sparkles, Film, Link2, AlertTriangle } from 'lucide-react';
import type { HealthInfo } from '../api-client';

interface EngineStatusProps {
  health: HealthInfo | null;
}

/**
 * Shows what the machine can actually do right now.
 *
 * This app degrades silently when a piece is missing: without Ollama the copy
 * is a template, without the CUDA build transcription is eight times slower,
 * without yt-dlp links do not work at all. None of that was visible anywhere,
 * so a half-equipped setup looked identical to a complete one until the
 * results came back worse.
 */

interface Chip {
  icon: React.ReactNode;
  label: string;
  detail: string;
  tone: 'good' | 'warn';
  /** What to do about it, shown only when something is missing. */
  fix?: string;
}

function buildChips(health: HealthInfo): Chip[] {
  const chips: Chip[] = [];

  const gpu = health.whisperBackend === 'gpu';
  chips.push(
    health.whisperAvailable
      ? {
          icon: gpu ? <Zap className="w-3 h-3" /> : <Cpu className="w-3 h-3" />,
          label: gpu ? 'Whisper por GPU' : 'Whisper por CPU',
          detail: `${
            (health.whisperModel || '').replace(/^ggml-|\.bin$/g, '') || 'modelo desconocido'
          }${health.whisperVad ? ' · VAD' : ''}`,
          tone: gpu ? 'good' : 'warn',
          // Two separate things can be wrong here, so the hint names whichever
          // one actually applies instead of only ever mentioning the GPU.
          fix: !gpu
            ? 'Transcribe unas 8 veces más lento. Pon la compilación CUDA de whisper.cpp en bin/whisper.'
            : health.whisperVad === false
              ? 'Sin detector de voz (VAD), Whisper inventa frases sobre el silencio y salen clips donde nadie habla. Falta ggml-silero-v5.1.2.bin en bin/whisper.'
              : undefined,
        }
      : {
          icon: <Mic className="w-3 h-3" />,
          label: 'Sin Whisper',
          detail: 'no se puede transcribir',
          tone: 'warn',
          fix: 'Es el primer paso del análisis. Coloca whisper-cli.exe y un modelo en bin/whisper.',
        }
  );

  chips.push(
    health.ollamaAvailable
      ? (() => {
          /**
           * Below this the model cannot finish a batch before the request
           * gives up, and the app silently writes template copy instead.
           * Measured on an idle RTX 3080 this model does tens of tokens a
           * second; with a game running it managed 0.1.
           */
          const speed = health.ollamaSpeed;
          const crawling = typeof speed === 'number' && speed < 3;

          return {
            icon: <Sparkles className="w-3 h-3" />,
            label: crawling ? 'Modelo local saturado' : 'Modelo local',
            detail: crawling
              ? `${health.ollamaModel || ''} · ${speed.toFixed(1)} tok/s`
              : health.ollamaModel || '',
            tone: crawling ? ('warn' as const) : ('good' as const),
            fix: crawling
              ? 'Algo más está usando la tarjeta gráfica (un juego, el navegador) y el modelo no cabe en la VRAM. Ciérralos antes de analizar, o los títulos saldrán de plantilla.'
              : undefined,
          };
        })()
      : {
          icon: <Sparkles className="w-3 h-3" />,
          label: 'Sin modelo de lenguaje',
          detail: 'cortes por señales',
          tone: 'warn',
          fix: 'Los títulos y el copy salen de plantillas. Instala Ollama y ejecuta: ollama pull qwen2.5:7b',
        }
  );

  chips.push(
    health.ffmpegAvailable
      ? { icon: <Film className="w-3 h-3" />, label: 'FFmpeg', detail: 'MP4 rápido', tone: 'good' }
      : {
          icon: <Film className="w-3 h-3" />,
          label: 'Sin FFmpeg',
          detail: 'exporta el navegador',
          tone: 'warn',
          fix: 'Exportar irá en tiempo real y en WebM. Instálalo con: winget install Gyan.FFmpeg',
        }
  );

  chips.push(
    health.linksEnabled
      ? { icon: <Link2 className="w-3 h-3" />, label: 'Enlaces', detail: '+1700 sitios', tone: 'good' }
      : {
          icon: <Link2 className="w-3 h-3" />,
          label: 'Sin enlaces',
          detail: 'solo archivos',
          tone: 'warn',
          fix: 'Falta yt-dlp en bin/. Mientras tanto puedes subir el archivo directamente.',
        }
  );

  return chips;
}

export const EngineStatus: React.FC<EngineStatusProps> = ({ health }) => {
  if (!health) {
    return (
      <div className="flex items-center space-x-2 text-[11px] text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-600 animate-pulse" />
        <span>Comprobando el equipo...</span>
      </div>
    );
  }

  const chips = buildChips(health);
  const problems = chips.filter((chip) => chip.tone === 'warn');

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.label}
            title={chip.fix}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] ${
              chip.tone === 'good'
                ? 'bg-slate-900 border-slate-800 text-slate-300'
                : 'bg-amber-950/40 border-amber-900/60 text-amber-200'
            }`}
          >
            <span className={chip.tone === 'good' ? 'text-emerald-400' : 'text-amber-400'}>
              {chip.icon}
            </span>
            <span className="font-semibold">{chip.label}</span>
            {chip.detail && <span className="text-slate-500">· {chip.detail}</span>}
          </span>
        ))}
      </div>

      {problems.length > 0 && (
        <details className="text-[11px] text-slate-400">
          <summary className="cursor-pointer hover:text-slate-200 inline-flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            <span>
              {problems.length === 1
                ? 'Falta una pieza, la app funciona peor'
                : `Faltan ${problems.length} piezas, la app funciona peor`}
            </span>
          </summary>
          <ul className="mt-2 space-y-1.5 pl-4">
            {problems.map((problem) => (
              <li key={problem.label} className="list-disc leading-relaxed">
                <span className="text-amber-200 font-semibold">{problem.label}:</span>{' '}
                {problem.fix}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
