import React, { useEffect, useRef, useState } from 'react';
import { Radio, Square, FolderOpen, Download, Loader2, Crosshair, RefreshCw, Copy } from 'lucide-react';
import {
  DEFAULT_GAMEPLAY_LAYOUT,
  SubtitleStyleType,
  type GameplayLayout,
  type WatermarkSettings,
} from '../types';
import { SUBTITLE_STYLES } from '../constants';
import { GameplayLayoutPicker } from './GameplayLayoutPicker';
import { WatermarkPicker } from './WatermarkPicker';

interface LivePanelProps {
  /** The same logo as in the studio view; every live clip gets it. */
  watermark: WatermarkSettings | null;
  onWatermarkChange: (value: WatermarkSettings | null) => void;
}

type Framing = 'auto' | 'focus' | 'split' | 'gameplay' | 'blur-fill' | 'zoom-crop';

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  markedAt?: number;
}
type Strictness = 'alta' | 'media' | 'baja';

interface LiveClip {
  id: string;
  title: string;
  hook: string;
  score: number;
  start: number;
  end: number;
  status: 'waiting' | 'exporting' | 'ready' | 'error';
  fileName?: string;
  error?: string;
  caption?: string;
  hashtags?: string[];
}

interface LiveView {
  id: string;
  title: string;
  status: 'starting' | 'recording' | 'finishing' | 'done' | 'error';
  message: string;
  recordedSeconds: number;
  analyzedSeconds: number;
  rounds: number;
  outputDir: string;
  clips: LiveClip[];
  needsWebcamMark: boolean;
  marksNeeded: number;
  marksSet: number;
  framingMode: Framing | 'fit';
  detected: { kind: string; reason: string } | null;
  marks: Region[];
  error?: string;
}

const STORAGE_KEY = 'extractor.liveSession';

const FRAMINGS: Array<{ id: Framing; name: string; note: string }> = [
  { id: 'auto', name: 'Automático', note: 'Mira si es gente hablando o un videojuego y elige solo. En videojuegos marca la webcam sin que hagas nada.' },
  { id: 'focus', name: 'Persona hablando', note: 'Vertical a pantalla completa siguiendo a quien habla. La marcas al empezar.' },
  { id: 'split', name: 'Dos personas', note: 'Una arriba y otra abajo, para entrevistas o pódcast. Marcas a las dos.' },
  { id: 'gameplay', name: 'Streamer + juego', note: 'Juego arriba, el jugador abajo ajustado a su webcam. Marcas la cámara.' },
  { id: 'blur-fill', name: 'Vertical con fondo', note: 'Todo el cuadro, con fondo desenfocado. No hay que marcar nada.' },
  { id: 'zoom-crop', name: 'Recorte al centro', note: 'Llena la pantalla recortando los lados. Sin marcar.' },
];

/** Box dropped around a click on a person: about a head and shoulders. */
const PERSON_BOX = { width: 0.22, height: 0.4 };

const personRegion = (cx: number, cy: number, markedAt?: number): Region => ({
  width: PERSON_BOX.width,
  height: PERSON_BOX.height,
  x: Math.min(Math.max(cx - PERSON_BOX.width / 2, 0), 1 - PERSON_BOX.width),
  y: Math.min(Math.max(cy - PERSON_BOX.height / 2, 0), 1 - PERSON_BOX.height),
  markedAt,
});

const STRICTNESS: Array<{ id: Strictness; name: string; note: string }> = [
  { id: 'alta', name: 'Alta', note: 'Solo momentos muy fuertes. Pocos clips.' },
  { id: 'media', name: 'Media', note: 'Gancho claro y la idea completa.' },
  { id: 'baja', name: 'Baja', note: 'Más clips, algunos menos llamativos.' },
];

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(h > 0 ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

/**
 * Clips a stream while it is still live.
 *
 * Everything heavy happens on the server (lib/live.ts); this panel only starts
 * a session, shows its progress, and - in streamer mode - lets the user point
 * at the webcam on a recent frame of the stream, since there is no finished
 * video to mark it on.
 */
export const LivePanel: React.FC<LivePanelProps> = ({ watermark, onWatermarkChange }) => {
  const [url, setUrl] = useState('');
  const [framing, setFraming] = useState<Framing>('auto');
  const [layout, setLayout] = useState<GameplayLayout>(DEFAULT_GAMEPLAY_LAYOUT);
  const [strictness, setStrictness] = useState<Strictness>('media');
  const [style, setStyle] = useState<SubtitleStyleType>(SubtitleStyleType.PILL);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [view, setView] = useState<LiveView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frameStamp, setFrameStamp] = useState(0);
  const [marking, setMarking] = useState<'idle' | 'busy' | 'failed' | 'done'>('idle');
  const [marks, setMarks] = useState<Region[]>([]);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameTime, setFrameTime] = useState<number | undefined>(undefined);
  const frameRef = useRef<HTMLImageElement>(null);

  // The live frame is fetched rather than linked so its recording time (sent
  // as a header) can travel with the marks made on it.
  const recordedMinute = Math.floor((view?.recordedSeconds ?? 0) / 60);
  const hasFrame = (view?.recordedSeconds ?? 0) > 0;
  useEffect(() => {
    if (!view?.id || !hasFrame) return;
    let revoked: string | null = null;
    let alive = true;
    fetch(`/api/live/${view.id}/frame?t=${frameStamp}`)
      .then(async (res) => {
        if (!res.ok || !alive) return;
        const time = Number(res.headers.get('X-Frame-Time'));
        const url = URL.createObjectURL(await res.blob());
        revoked = url;
        setFrameUrl(url);
        setFrameTime(Number.isFinite(time) ? time : undefined);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
    // Only on demand ("Otra imagen") and once the first minute exists.
  }, [view?.id, hasFrame, frameStamp]);
  void recordedMinute;

  useEffect(() => {
    try {
      if (sessionId) localStorage.setItem(STORAGE_KEY, sessionId);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage blocked: the session just will not survive a reload */
    }
  }, [sessionId]);

  // Poll the session while it exists.
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/live/${sessionId}`);
        if (res.status === 404) {
          // The server restarted; that session is gone.
          if (alive) {
            setSessionId(null);
            setView(null);
          }
          return;
        }
        const data = (await res.json()) as LiveView;
        if (alive) setView(data);
      } catch {
        /* server busy; next poll */
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch('/api/live/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          settings: {
            aspectRatio: '9:16',
            framingMode: framing,
            gameplayLayout: layout,
            strictness,
            subtitleStyle: style,
            subtitleAnimation: 'word-pop',
            burnSubtitles: true,
            watermark,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo empezar a grabar el directo.');
      setView(data);
      setSessionId(data.id);
      setMarking('idle');
      setMarks([]);
      setFrameUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo empezar a grabar el directo.');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!sessionId) return;
    await fetch(`/api/live/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
  };

  /** What the session is really using: 'auto' becomes a real framing once decided. */
  const activeFraming: Framing | 'fit' = view?.framingMode ?? framing;
  const currentMarks: Region[] = view?.marks ?? marks;

  const changeFraming = async (next: Framing) => {
    if (!sessionId) return;
    setMarks([]);
    setMarking('idle');
    const res = await fetch(`/api/live/${sessionId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framingMode: next }),
    }).catch(() => null);
    if (res?.ok) setView(await res.json());
  };

  const saveMarks = async (regions: Region[]) => {
    if (!sessionId) return;
    setMarks(regions);
    await fetch(`/api/live/${sessionId}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakers: regions }),
    }).catch(() => {});
  };

  /**
   * A click on the live frame.
   *
   * Streamer mode snaps it to the webcam overlay's real edges (server side);
   * people get a head-and-shoulders box around the click, like the studio's
   * picker. In two-person mode clicks alternate between the two.
   */
  const markOnFrame = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || !frameRef.current) return;
    const rect = frameRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    if (activeFraming === 'gameplay') {
      setMarking('busy');
      try {
        const res = await fetch(`/api/live/${sessionId}/webcam`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, y }),
        });
        const { box } = await res.json();
        if (!box) {
          setMarking('failed');
          return;
        }
        await saveMarks([{ ...box, markedAt: frameTime }]);
        setMarking('done');
      } catch {
        setMarking('failed');
      }
      return;
    }

    const region = personRegion(x, y, frameTime);
    if (activeFraming === 'split') {
      // First two clicks fill the two slots; after that, replace the older one.
      const next =
        currentMarks.length < 2 ? [...currentMarks, region] : [currentMarks[1], region];
      await saveMarks(next);
    } else {
      await saveMarks([region]);
    }
    setMarking('done');
  };

  const running = view && (view.status === 'starting' || view.status === 'recording' || view.status === 'finishing');
  const showMarkStep =
    view &&
    (activeFraming === 'gameplay' || activeFraming === 'focus' || activeFraming === 'split') &&
    view.status === 'recording';

  // ---- Not started yet: the form ------------------------------------------------
  if (!view) {
    return (
      <div className="space-y-4 animate-in fade-in duration-200">
        <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div>
            <label className="text-xs font-bold text-slate-200 mb-1.5 flex items-center">
              <Radio className="w-4 h-4 mr-1.5 text-red-500" />
              Enlace del directo (YouTube, Twitch o Kick):
            </label>
            <p className="text-[11px] text-slate-400 mb-3">
              Graba mientras transmite y cada pocos minutos saca los momentos que enganchan, con la
              idea completa. Cada clip se exporta solo, en cuanto se encuentra. Al terminar se borra la
              grabación y quedan solo los clips.
            </p>
            <input
              type="url"
              placeholder="https://www.youtube.com/watch?v=...  ·  https://www.twitch.tv/canal  ·  https://kick.com/canal"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-slate-400">Encuadre</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {FRAMINGS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFraming(f.id)}
                  className={`text-left p-2.5 rounded-xl border text-[11px] ${
                    framing === f.id
                      ? 'border-red-400 bg-red-500/10 text-red-100'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <span className="block font-bold text-xs mb-0.5">{f.name}</span>
                  {f.note}
                </button>
              ))}
            </div>
            {(framing === 'gameplay' || framing === 'auto') && (
              <div className="space-y-1">
                {framing === 'auto' && (
                  <p className="text-[11px] text-slate-500">Si resulta ser un videojuego:</p>
                )}
                <GameplayLayoutPicker value={layout} onChange={setLayout} />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-slate-400">Qué tan llamativo tiene que ser un momento</p>
            <div className="grid grid-cols-3 gap-2">
              {STRICTNESS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStrictness(s.id)}
                  className={`text-left p-2.5 rounded-xl border text-[11px] ${
                    strictness === s.id
                      ? 'border-amber-400 bg-amber-400/10 text-amber-100'
                      : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <span className="block font-bold text-xs mb-0.5">{s.name}</span>
                  {s.note}
                </button>
              ))}
            </div>
          </div>

          <label className="block text-[11px] font-semibold text-slate-400 space-y-1">
            <span>Estilo de subtítulos</span>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value as SubtitleStyleType)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200"
            >
              {SUBTITLE_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-slate-400">Marca de agua (opcional)</p>
            <WatermarkPicker value={watermark} onChange={onWatermarkChange} />
          </div>

          {error && <p className="text-[12px] text-rose-300">{error}</p>}

          <button
            type="button"
            onClick={start}
            disabled={!url.trim() || starting}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-red-600 to-rose-600 text-white font-bold text-sm disabled:opacity-50"
          >
            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
            {starting ? 'Conectando con el directo...' : 'Empezar a grabar y sacar clips'}
          </button>
        </div>
      </div>
    );
  }

  // ---- Running or finished: progress, webcam marking, clips --------------------
  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="bg-slate-950/70 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-white truncate">{view.title || 'Directo'}</p>
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
              {view.status === 'recording' && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />}
              {view.message}
            </p>
          </div>
          {running && view.status !== 'finishing' && (
            <button
              type="button"
              onClick={stop}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-[12px] text-slate-200 hover:border-rose-400"
            >
              <Square className="w-3.5 h-3.5" /> Detener
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="bg-slate-900 rounded-lg p-2">
            <p className="text-[10px] text-slate-500">Grabado</p>
            <p className="text-sm font-bold text-white">{clock(view.recordedSeconds)}</p>
          </div>
          <div className="bg-slate-900 rounded-lg p-2">
            <p className="text-[10px] text-slate-500">Revisado</p>
            <p className="text-sm font-bold text-white">{clock(view.analyzedSeconds)}</p>
          </div>
          <div className="bg-slate-900 rounded-lg p-2">
            <p className="text-[10px] text-slate-500">Clips</p>
            <p className="text-sm font-bold text-white">{view.clips.filter((c) => c.status === 'ready').length}</p>
          </div>
        </div>

        {view.framingMode === 'auto' && view.status === 'recording' && (
          <p className="text-[11px] text-amber-200">
            Mirando si es un directo de gente o de videojuego (a los 2 minutos de grabación)...
          </p>
        )}
        {view.detected && (
          <p className="text-[11px] text-emerald-200">Detectado: {view.detected.reason}</p>
        )}
        {(view.status === 'recording' || view.status === 'starting') && (
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="shrink-0">Encuadre:</span>
            <select
              value={view.framingMode === 'fit' ? 'blur-fill' : view.framingMode}
              onChange={(e) => void changeFraming(e.target.value as Framing)}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-slate-200"
            >
              {FRAMINGS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="text-[11px] text-slate-500">
          La primera revisión llega a los ~3 minutos de grabación; después, cada 3 minutos. Un momento
          sale como clip unos minutos después de ocurrir.
        </p>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => fetch(`/api/live/${view.id}/open-folder`, { method: 'POST' })}
            className="flex items-center gap-1.5 text-[12px] text-slate-300 hover:text-white"
          >
            <FolderOpen className="w-4 h-4" /> Abrir carpeta de clips
          </button>
          {(view.status === 'done' || view.status === 'error') && (
            <button
              type="button"
              onClick={() => {
                setSessionId(null);
                setView(null);
              }}
              className="flex items-center gap-1.5 text-[12px] text-slate-300 hover:text-white"
            >
              <Radio className="w-4 h-4" /> Nuevo directo
            </button>
          )}
        </div>
      </div>

      {showMarkStep && (
        <div className="bg-slate-950/70 border border-amber-500/30 rounded-2xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-amber-200 flex items-center gap-1.5">
              <Crosshair className="w-4 h-4" />
              {activeFraming === 'gameplay'
                ? view.needsWebcamMark
                  ? 'Haz clic sobre la cámara del streamer'
                  : 'Cámara marcada'
                : activeFraming === 'split'
                  ? view.needsWebcamMark
                    ? `Haz clic sobre cada persona (${view.marksSet}/2): la primera va arriba`
                    : 'Las dos personas están marcadas'
                  : view.needsWebcamMark
                    ? 'Haz clic sobre la persona que habla'
                    : 'Persona marcada'}
            </p>
            <button
              type="button"
              onClick={() => setFrameStamp(Date.now())}
              className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Otra imagen
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            {marking === 'busy'
              ? 'Buscando el borde exacto de la cámara...'
              : marking === 'failed'
                ? 'No encontré el borde de la cámara en esta imagen; prueba con otra o haz clic justo en el centro de la cámara.'
                : view.needsWebcamMark
                  ? 'Los clips que se encuentren esperan a que marques, para no recortar a ciegas.'
                  : activeFraming === 'gameplay'
                    ? 'Listo: los clips usan este recuadro. Si el streamer mueve la cámara, ese tramo sale en pantalla completa.'
                    : 'Listo: el clip sigue a quien marcaste en vertical. Si el directo cambia a otra cámara, ese tramo sale completo. Puedes volver a hacer clic para corregir.'}
          </p>
          {!frameUrl ? (
            <p className="text-[11px] text-slate-500">
              La imagen aparece al terminar el primer minuto de grabación.
            </p>
          ) : (
            <div className="relative">
              <img
                ref={frameRef}
                src={frameUrl}
                alt="Imagen reciente del directo"
                onClick={markOnFrame}
                className="w-full rounded-lg border border-slate-700 cursor-crosshair"
              />
              {currentMarks.map((mark, index) => (
                <div
                  key={index}
                  className="absolute border-2 border-amber-400 rounded pointer-events-none"
                  style={{
                    left: `${mark.x * 100}%`,
                    top: `${mark.y * 100}%`,
                    width: `${mark.width * 100}%`,
                    height: `${mark.height * 100}%`,
                  }}
                >
                  {activeFraming === 'split' && (
                    <span className="absolute -top-5 left-0 text-[10px] font-bold bg-amber-400 text-black px-1 rounded">
                      {index === 0 ? 'Arriba' : 'Abajo'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view.clips.length > 0 && (
        <div className="space-y-2">
          {[...view.clips].reverse().map((clip) => (
            <div key={clip.id} className="bg-slate-950/70 border border-slate-800 rounded-xl p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{clip.title}</p>
                  <p className="text-[11px] text-slate-400">
                    {clock(clip.start)} – {clock(clip.end)} · nota {clip.score}
                  </p>
                </div>
                {clip.status === 'ready' ? (
                  <a
                    href={`/api/live/${view.id}/clips/${clip.id}`}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-[11px] text-emerald-200"
                  >
                    <Download className="w-3.5 h-3.5" /> MP4
                  </a>
                ) : (
                  <span className="shrink-0 text-[11px] text-slate-400 flex items-center gap-1">
                    {clip.status === 'exporting' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    {clip.status === 'exporting'
                      ? 'Exportando'
                      : clip.status === 'waiting'
                        ? 'Esperando'
                        : 'Error'}
                  </span>
                )}
              </div>
              {clip.hook && <p className="text-[12px] text-slate-300">“{clip.hook}”</p>}
              {clip.caption && (
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard
                      ?.writeText(`${clip.caption}\n\n${(clip.hashtags ?? []).join(' ')}`)
                      .catch(() => {})
                  }
                  className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" /> Copiar texto para publicar
                </button>
              )}
              {clip.status === 'error' && clip.error && (
                <p className="text-[11px] text-rose-300">{clip.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
