import React from 'react';
import type { GameplayLayout } from '../types';

interface GameplayLayoutPickerProps {
  value: GameplayLayout;
  onChange: (layout: GameplayLayout) => void;
}

/** The three webcam heights offered. Free numbers would only invite 0.27 vs 0.29. */
const SIZES: Array<{ share: number; label: string }> = [
  { share: 0.3, label: 'Pequeña' },
  { share: 0.38, label: 'Media' },
  { share: 0.5, label: 'Mitad' },
];

/**
 * Where the streamer's face goes in 'Streamer + juego', and how big.
 *
 * Each option is drawn as a tiny 9:16 frame, for the same reason the framing
 * picker draws one per mode: "cámara arriba, mitad" is obvious in a picture
 * and a guess in words.
 */
export const GameplayLayoutPicker: React.FC<GameplayLayoutPickerProps> = ({ value, onChange }) => {
  const Diagram = ({ position, share }: { position: 'top' | 'bottom'; share: number }) => {
    const camH = Math.round(64 * share);
    const gameH = 64 - camH;
    return (
      <svg viewBox="0 0 36 64" className="w-6 h-11 shrink-0 rounded-sm overflow-hidden">
        <rect
          x={0}
          y={position === 'top' ? camH : 0}
          width={36}
          height={gameH}
          fill="#22c55e"
          opacity={0.8}
        />
        <rect
          x={0}
          y={position === 'top' ? 0 : gameH}
          width={36}
          height={camH}
          fill="#f59e0b"
          opacity={0.9}
        />
      </svg>
    );
  };

  const button = (selected: boolean) =>
    `flex items-center gap-2 px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
      selected
        ? 'border-amber-400 bg-amber-400/10 text-amber-200'
        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600'
    }`;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-slate-400">Diseño del clip</p>
      <p className="text-[11px] text-slate-500">
        "Ajustada" hace que el panel tenga la forma exacta de la webcam: se ve entera, sin
        pedazos del juego alrededor.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {(['top', 'bottom'] as const).map((position) => (
          <button
            key={position}
            type="button"
            className={button(value.camPosition === position)}
            onClick={() => onChange({ ...value, camPosition: position })}
          >
            <Diagram position={position} share={value.fitCam === false ? value.camShare : 0.36} />
            <span>{position === 'top' ? 'Cámara arriba' : 'Cámara abajo'}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <button
          type="button"
          className={button(value.fitCam !== false)}
          onClick={() => onChange({ ...value, fitCam: true })}
          title="El panel toma la forma de la webcam: se ve entera, sin juego alrededor"
        >
          <Diagram position={value.camPosition} share={0.36} />
          <span>Ajustada</span>
        </button>
        {SIZES.map((size) => (
          <button
            key={size.share}
            type="button"
            className={button(value.fitCam === false && Math.abs(value.camShare - size.share) < 0.01)}
            onClick={() => onChange({ ...value, camShare: size.share, fitCam: false })}
          >
            <Diagram position={value.camPosition} share={size.share} />
            <span>{size.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
