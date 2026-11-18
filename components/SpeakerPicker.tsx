import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, RotateCcw, Users, User } from 'lucide-react';
import type { SpeakerRegion } from '../types';
import { findWebcamBox } from '../api-client';

interface SpeakerPickerProps {
  videoSrc: string | null;
  /** Second of the source to show as the reference frame. */
  previewTime: number;
  mode: 'focus' | 'split' | 'auto-fill' | 'gameplay';
  regions: SpeakerRegion[];
  onChange: (regions: SpeakerRegion[]) => void;
  /**
   * Server-side source, when there is one. Lets a click on a streamer's
   * webcam snap to the overlay's exact rectangle.
   */
  sourceId?: string | null;
}

/**
 * Lets the user point at who should stay in frame.
 *
 * Marking by hand rather than detecting faces is deliberate. A detector that
 * guesses wrong fails silently across a whole batch of clips, and the person
 * only finds out after exporting; a marked region is right by construction.
 *
 * Regions are stored normalised (0-1) so they survive whatever resolution the
 * source happens to be, and the same numbers drive both the preview here and
 * the FFmpeg crop on the server.
 */

const DEFAULT_SIZE = { width: 0.22, height: 0.4 };

const PANEL_LABELS = ['Arriba', 'Abajo'];

/**
 * What the two marks mean, per mode.
 *
 * In gameplay mode they are not two people at all - one is a webcam and the
 * other is the playfield - so a generic "Persona 1 / Persona 2" would be
 * actively misleading about which to click first, and clicking them in the
 * wrong order swaps the two panels.
 */
const GAMEPLAY_LABELS = ['Cámara', 'Juego'];

export const SpeakerPicker: React.FC<SpeakerPickerProps> = ({
  videoSrc,
  previewTime,
  mode,
  regions,
  onChange,
  sourceId,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [snap, setSnap] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');

  // The snap answer arrives seconds after the click; by then `regions` in the
  // closure is the list from before the click.
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  const wanted = mode === 'focus' ? 1 : 2;
  const isGameplay = mode === 'gameplay';

  // Park the reference video on a frame from inside the clip.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const seek = () => {
      try {
        video.currentTime = previewTime;
      } catch {
        /* metadata not ready yet */
      }
    };

    if (video.readyState >= 1) seek();
    else video.addEventListener('loadedmetadata', seek, { once: true });
  }, [previewTime, videoSrc]);

  const place = useCallback(
    (index: number, clientX: number, clientY: number) => {
      const frame = frameRef.current;
      if (!frame) return;

      const rect = frame.getBoundingClientRect();
      const cx = (clientX - rect.left) / rect.width;
      const cy = (clientY - rect.top) / rect.height;

      const size = regions[index]
        ? { width: regions[index].width, height: regions[index].height }
        : DEFAULT_SIZE;

      // Keep the box inside the frame; a region hanging off the edge would be
      // clamped server-side anyway, so showing it off-frame would mislead.
      const next: SpeakerRegion = {
        width: size.width,
        height: size.height,
        x: Math.min(Math.max(cx - size.width / 2, 0), 1 - size.width),
        y: Math.min(Math.max(cy - size.height / 2, 0), 1 - size.height),
        // The frame on screen is the reference the export compares every
        // camera shot against, so it travels with the marks.
        markedAt: previewTime,
      };

      const updated = [...regions];
      while (updated.length < index) {
        updated.push({ ...DEFAULT_SIZE, x: 0.39, y: 0.3, markedAt: previewTime });
      }
      updated[index] = next;
      onChange(updated.slice(0, wanted));
    },
    [regions, onChange, wanted, previewTime]
  );

  /**
   * In 'Streamer + juego' the first mark is the webcam. A generic box around
   * the click always takes in a strip of game, which then shows up in the
   * face panel, so the box is replaced by the overlay's real rectangle as
   * soon as the server finds it.
   */
  const snapToWebcam = async (cx: number, cy: number) => {
    if (!sourceId) return;
    setSnap('busy');
    const box = await findWebcamBox(sourceId, previewTime, cx, cy);
    if (!box) {
      setSnap('failed');
      return;
    }
    const updated = [...regionsRef.current];
    updated[0] = { ...box, markedAt: previewTime };
    onChange(updated.slice(0, wanted));
    setSnap('done');
  };

  const handleFrameClick = (event: React.MouseEvent) => {
    const index = activeIndex;
    place(index, event.clientX, event.clientY);
    if (wanted === 2) setActiveIndex((i) => (i + 1) % 2);

    if (isGameplay && index === 0 && frameRef.current) {
      const rect = frameRef.current.getBoundingClientRect();
      void snapToWebcam(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height
      );
    }
  };

  useEffect(() => {
    if (dragging === null) return;

    const move = (event: MouseEvent) => place(dragging, event.clientX, event.clientY);
    const stop = () => setDragging(null);

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop, { once: true });
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, [dragging, place]);

  if (!videoSrc) {
    return (
      <p className="text-[11px] text-slate-400">
        Carga un video para marcar a las personas.
      </p>
    );
  }

  const missing = wanted - regions.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-300 flex items-center space-x-1.5">
          <Crosshair className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            {isGameplay
              ? 'Haz clic primero sobre la cámara del streamer y después sobre la zona de juego. Si no marcas el juego se usa el fotograma entero.'
              : mode === 'split'
                ? 'Haz clic sobre cada persona. La primera va arriba, la segunda abajo.'
                : mode === 'auto-fill'
                  ? 'Haz clic sobre cada persona. El encuadre saltará a la que se mueva.'
                  : 'Haz clic sobre la persona que debe quedar en el encuadre.'}
          </span>
        </span>

        {regions.length > 0 && (
          <button
            type="button"
            onClick={() => {
              onChange([]);
              setActiveIndex(0);
              setSnap('idle');
            }}
            className="text-[11px] text-slate-400 hover:text-rose-300 flex items-center space-x-1"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Borrar marcas</span>
          </button>
        )}
      </div>

      {isGameplay && snap !== 'idle' && (
        <p
          className={`text-[11px] ${
            snap === 'done' ? 'text-emerald-300' : snap === 'failed' ? 'text-amber-300' : 'text-slate-400'
          }`}
        >
          {snap === 'busy'
            ? 'Buscando el borde exacto de la cámara...'
            : snap === 'done'
              ? 'Recuadro ajustado a la cámara: el panel mostrará solo la webcam.'
              : 'No encontré el borde de la cámara en este momento del video. Se usa el recuadro que marcaste.'}
        </p>
      )}

      <div
        ref={frameRef}
        onClick={handleFrameClick}
        className="relative w-full rounded-xl overflow-hidden border border-slate-700 cursor-crosshair bg-black select-none"
      >
        <video
          ref={videoRef}
          src={videoSrc}
          muted
          playsInline
          preload="metadata"
          className="w-full block pointer-events-none"
        />

        {regions.slice(0, wanted).map((region, index) => (
          <div
            key={index}
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragging(index);
              setActiveIndex(index);
            }}
            className={`absolute border-2 rounded-md cursor-move transition-colors ${
              index === 0
                ? 'border-emerald-400 bg-emerald-400/10'
                : 'border-sky-400 bg-sky-400/10'
            }`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
          >
            <span
              className={`absolute -top-5 left-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                index === 0 ? 'bg-emerald-400 text-slate-950' : 'bg-sky-400 text-slate-950'
              }`}
            >
              {isGameplay
                ? GAMEPLAY_LABELS[index]
                : mode === 'split'
                  ? PANEL_LABELS[index]
                  : mode === 'auto-fill'
                    ? `Persona ${index + 1}`
                    : 'Encuadre'}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-400 flex items-center space-x-1.5">
        {mode === 'split' ? (
          <Users className="w-3 h-3 shrink-0" />
        ) : (
          <User className="w-3 h-3 shrink-0" />
        )}
        <span>
          {missing > 0
            ? isGameplay
              ? `Falta marcar ${missing === 2 ? 'la cámara y el juego' : regions.length === 0 ? 'la cámara' : 'el juego'}. Sin marcar, se usa el fotograma entero.`
              : `Falta marcar ${missing} ${missing === 1 ? 'persona' : 'personas'}. Sin marcar, se usa un encuadre centrado.`
            : 'Arrastra los recuadros para ajustarlos.'}
        </span>
      </p>
    </div>
  );
};
