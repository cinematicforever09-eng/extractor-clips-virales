import React, { useRef, useState } from 'react';
import { ImagePlus, Trash2, Stamp } from 'lucide-react';
import { DEFAULT_WATERMARK, type WatermarkSettings } from '../types';

interface WatermarkPickerProps {
  value: WatermarkSettings | null;
  onChange: (value: WatermarkSettings | null) => void;
}

/** Big enough for any logo; a 20 MB "logo" is a photo and would bloat every export request. */
const MAX_BYTES = 5 * 1024 * 1024;

/** Preview frame, a 9:16 phone screen. */
const FRAME_W = 135;
const FRAME_H = 240;

const POSITIONS: Array<{ label: string; x: number; y: number }> = [
  { label: 'Arriba izquierda', x: 0.15, y: 0.07 },
  { label: 'Arriba', x: 0.5, y: 0.07 },
  { label: 'Arriba derecha', x: 0.85, y: 0.07 },
  { label: 'Centro izquierda', x: 0.15, y: 0.5 },
  { label: 'Centro', x: 0.5, y: 0.5 },
  { label: 'Centro derecha', x: 0.85, y: 0.5 },
  { label: 'Abajo izquierda', x: 0.15, y: 0.93 },
  { label: 'Abajo', x: 0.5, y: 0.93 },
  { label: 'Abajo derecha', x: 0.85, y: 0.93 },
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Lets the user put their own logo on every clip.
 *
 * The preview is the point: "25 % of the width, centred at 93 %" means
 * nothing until it is drawn on a phone-shaped frame next to where the
 * captions go. The logo is placed exactly the way the export places it -
 * centred on the chosen point, then pushed back inside the frame if it would
 * hang off an edge - so what is seen here is what gets burned in.
 */
export const WatermarkPicker: React.FC<WatermarkPickerProps> = ({ value, onChange }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(1); // logo height / width
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const pickFile = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.type !== 'image/png') {
      setError('Tiene que ser un archivo PNG (así se respeta el fondo transparente).');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('El PNG pesa más de 5 MB. Exporta el logo más pequeño, con 1000 px de ancho basta.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = String(reader.result);
      onChange({ ...(value ?? DEFAULT_WATERMARK), image });
    };
    reader.readAsDataURL(file);
  };

  const moveTo = (clientX: number, clientY: number) => {
    const frame = frameRef.current;
    if (!frame || !value) return;
    const rect = frame.getBoundingClientRect();
    onChange({
      ...value,
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    });
  };

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/png"
      className="hidden"
      onChange={(e) => {
        pickFile(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  if (!value) {
    return (
      <div className="space-y-2">
        {fileInput}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-slate-700 text-[12px] text-slate-300 hover:border-indigo-400 hover:text-indigo-200 transition-colors"
        >
          <ImagePlus className="w-4 h-4" />
          Subir logo en PNG
        </button>
        <p className="text-[11px] text-slate-500">
          Se pone en todos los clips que exportes, también al exportar en lote. Usa un PNG con fondo
          transparente.
        </p>
        {error && <p className="text-[11px] text-amber-300">{error}</p>}
      </div>
    );
  }

  // Where the logo lands in the preview, kept inside the frame like the export does.
  const logoW = value.widthRatio * FRAME_W;
  const logoH = logoW * aspect;
  const left = clamp(value.x * FRAME_W - logoW / 2, 0, Math.max(0, FRAME_W - logoW));
  const top = clamp(value.y * FRAME_H - logoH / 2, 0, Math.max(0, FRAME_H - logoH));

  const isPreset = (p: { x: number; y: number }) =>
    Math.abs(p.x - value.x) < 0.01 && Math.abs(p.y - value.y) < 0.01;

  return (
    <div className="space-y-3">
      {fileInput}
      <div className="flex gap-3">
        {/* Phone-shaped preview: drag the logo anywhere */}
        <div
          ref={frameRef}
          className="relative shrink-0 rounded-lg overflow-hidden border border-slate-700 bg-gradient-to-b from-slate-700 via-slate-800 to-slate-900 cursor-crosshair select-none touch-none"
          style={{ width: FRAME_W, height: FRAME_H }}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDragging(true);
            moveTo(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => dragging && moveTo(e.clientX, e.clientY)}
          onPointerUp={() => setDragging(false)}
          title="Arrastra el logo para moverlo"
        >
          {/* Where the bottom captions usually sit, so the logo can avoid them. */}
          <div
            className="absolute left-2 right-2 text-center text-[8px] font-black text-white/50 border border-dashed border-white/25 rounded"
            style={{ top: FRAME_H * 0.77, height: FRAME_H * 0.07, lineHeight: `${FRAME_H * 0.07}px` }}
          >
            SUBTÍTULOS
          </div>
          <img
            src={value.image}
            alt="Logo"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0) setAspect(img.naturalHeight / img.naturalWidth);
            }}
            className="absolute pointer-events-none"
            style={{ left, top, width: logoW, opacity: value.opacity }}
          />
        </div>

        <div className="flex-1 space-y-2 min-w-0">
          <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <Stamp className="w-3.5 h-3.5 text-indigo-300" />
            Arrastra el logo en la vista previa o elige un lugar:
          </p>
          <div className="grid grid-cols-3 gap-1 w-[120px]">
            {POSITIONS.map((p) => (
              <button
                key={p.label}
                type="button"
                title={p.label}
                onClick={() => onChange({ ...value, x: p.x, y: p.y })}
                className={`h-6 rounded border ${
                  isPreset(p)
                    ? 'border-indigo-400 bg-indigo-500/30'
                    : 'border-slate-700 bg-slate-950 hover:border-slate-500'
                }`}
              />
            ))}
          </div>

          <label className="block text-[11px] text-slate-400">
            Tamaño: {Math.round(value.widthRatio * 100)} % del ancho
            <input
              type="range"
              min={5}
              max={60}
              value={Math.round(value.widthRatio * 100)}
              onChange={(e) => onChange({ ...value, widthRatio: Number(e.target.value) / 100 })}
              className="w-full accent-indigo-500"
            />
          </label>

          <label className="block text-[11px] text-slate-400">
            Opacidad: {Math.round(value.opacity * 100)} %
            <input
              type="range"
              min={20}
              max={100}
              value={Math.round(value.opacity * 100)}
              onChange={(e) => onChange({ ...value, opacity: Number(e.target.value) / 100 })}
              className="w-full accent-indigo-500"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1 text-[11px] text-slate-300 hover:text-indigo-200"
            >
              <ImagePlus className="w-3.5 h-3.5" /> Cambiar
            </button>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-300"
            >
              <Trash2 className="w-3.5 h-3.5" /> Quitar
            </button>
          </div>
          {error && <p className="text-[11px] text-amber-300">{error}</p>}
        </div>
      </div>
    </div>
  );
};
