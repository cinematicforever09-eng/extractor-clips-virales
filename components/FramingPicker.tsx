import React from 'react';
import type { FramingMode } from '../types';
import { FRAMING_MODES } from '../constants';

/**
 * Picks how the wide source becomes a vertical clip.
 *
 * Each option carries a diagram of the resulting layout. The names alone were
 * not enough: "Fondo desenfocado dinámico" and "Ajustar con bordes limpios"
 * describe the same thing to someone who has not seen both, and the only way
 * to find out used to be exporting one of each. A 9:16 rectangle showing where
 * the picture, the face and the game end up answers it before any rendering.
 */

interface FramingPickerProps {
  value: FramingMode;
  onChange: (mode: FramingMode) => void;
  /** Dims the options that need marked regions when none exist yet. */
  markedRegions: number;
}

/** Colours shared by every diagram, so the parts mean the same thing in all of them. */
const PICTURE = '#6366f1';
const FACE = '#34d399';
const GAME = '#f59e0b';
const EMPTY = '#1e293b';

/**
 * A 9:16 diagram of what each mode produces.
 *
 * Drawn rather than rendered from the real video on purpose: a thumbnail of
 * one frame of one clip says what that clip looks like, while the diagram says
 * what the mode does - which is the thing being chosen.
 */
const Diagram: React.FC<{ mode: FramingMode }> = ({ mode }) => {
  const frame = { x: 0, y: 0, width: 36, height: 64 };

  const content = () => {
    switch (mode) {
      case 'focus':
        return <rect x={0} y={0} width={36} height={64} fill={FACE} opacity={0.85} />;

      case 'split':
        return (
          <>
            <rect x={0} y={0} width={36} height={31} fill={FACE} opacity={0.85} />
            <rect x={0} y={33} width={36} height={31} fill={FACE} opacity={0.5} />
          </>
        );

      case 'auto-fill':
        return (
          <>
            <rect x={0} y={0} width={36} height={64} fill={FACE} opacity={0.85} />
            {/* The arrow is the whole point of this mode: the crop moves. */}
            <path
              d="M11 32 h14 M21 28 l4 4 l-4 4"
              stroke="#0f172a"
              strokeWidth={2.2}
              fill="none"
              strokeLinecap="round"
            />
          </>
        );

      case 'gameplay':
        return (
          <>
            <rect x={0} y={0} width={36} height={40} fill={EMPTY} />
            <rect x={0} y={11} width={36} height={18} fill={GAME} opacity={0.9} />
            <rect x={0} y={40} width={36} height={24} fill={FACE} opacity={0.85} />
          </>
        );

      case 'zoom-crop':
        return <rect x={0} y={0} width={36} height={64} fill={PICTURE} opacity={0.85} />;

      case 'fit':
        return (
          <>
            <rect x={0} y={0} width={36} height={64} fill={EMPTY} />
            <rect x={0} y={22} width={36} height={20} fill={PICTURE} opacity={0.85} />
          </>
        );

      default:
        // blur-fill: the same picture, blurred, behind a sharp centred copy.
        return (
          <>
            <rect x={0} y={0} width={36} height={64} fill={PICTURE} opacity={0.22} />
            <rect x={0} y={22} width={36} height={20} fill={PICTURE} opacity={0.9} />
          </>
        );
    }
  };

  return (
    <svg viewBox="0 0 36 64" className="w-9 h-16 shrink-0 rounded-[3px] overflow-hidden" aria-hidden="true">
      <rect {...frame} fill="#0b1220" />
      {content()}
      <rect {...frame} fill="none" stroke="#334155" strokeWidth={1.5} rx={2} />
    </svg>
  );
};

/** Modes that cannot do their job until the user has marked something. */
const NEEDS_REGIONS: Partial<Record<FramingMode, number>> = {
  focus: 1,
  split: 2,
  'auto-fill': 2,
  gameplay: 1,
};

export const FramingPicker: React.FC<FramingPickerProps> = ({
  value,
  onChange,
  markedRegions,
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {FRAMING_MODES.map((mode) => {
      const selected = value === mode.id;
      const needed = NEEDS_REGIONS[mode.id] ?? 0;
      const missing = Math.max(0, needed - markedRegions);

      return (
        <button
          key={mode.id}
          type="button"
          onClick={() => onChange(mode.id)}
          aria-pressed={selected}
          className={`flex items-start gap-2.5 p-2.5 rounded-xl border text-left transition-colors ${
            selected
              ? 'bg-indigo-950/60 border-indigo-500 ring-1 ring-indigo-500'
              : 'bg-slate-900/70 border-slate-800 hover:border-slate-600'
          }`}
        >
          <Diagram mode={mode.id} />

          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-bold text-indigo-300">{mode.badge}</span>
            <span className="block text-xs font-bold text-white leading-tight">{mode.name}</span>
            <span className="block text-[10px] text-slate-400 leading-snug mt-0.5">
              {mode.description}
            </span>

            {/* Said on the option itself, not after choosing it: otherwise the
                requirement only surfaces once the mode is already selected. */}
            {selected && missing > 0 && (
              <span className="block text-[10px] text-amber-300 mt-1 font-semibold">
                {missing === needed
                  ? `Marca ${needed === 1 ? 'la zona' : 'las 2 zonas'} abajo.`
                  : `Falta marcar ${missing} zona${missing === 1 ? '' : 's'}.`}
              </span>
            )}
          </span>
        </button>
      );
    })}
  </div>
);
