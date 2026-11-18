/**
 * Single source of truth for subtitle looks.
 *
 * The same five styles have to be reproduced by four different renderers: the
 * FFmpeg burn-in (ASS tags), the browser export fallback (canvas 2D), the live
 * preview (CSS) and the little style cards in the UI. Each of those used to
 * carry its own copy of the colours, and they had already drifted - the
 * minimalist style was #F8FAFC in three places and #F1F5F9 in a fourth, and
 * Hormozi's yellow was #FACC15 everywhere except the preview card, which used
 * Tailwind's text-yellow-300 (#FDE047).
 *
 * Colours live here as plain hex and are converted per renderer. ASS in
 * particular wants &HAABBGGRR - alpha first, then blue, green, red - and hand
 * writing that byte order is how "why is my yellow text blue" happens.
 */

export type SubtitleStyleId = 'pill' | 'hormozi' | 'mrbeast' | 'cyberpunk' | 'clean_minimal' | 'classic';

export interface SubtitleStyleDef {
  id: SubtitleStyleId;
  name: string;
  description: string;
  badge: string;

  /** Resting colour of the text. */
  base: string;
  /** Colour the active word takes in karaoke and word-pop. */
  highlight: string;

  /** Font family name libass resolves against installed system fonts. */
  assFont: string;
  /** Font stack for canvas and CSS. */
  cssFont: string;
  cssWeight: number;
  /** Font size as a fraction of the output width, verified against real exports. */
  sizeRatio: number;
  uppercase: boolean;

  /** Filled plate behind the text. */
  box?: { fill: string; border?: string; radius: number; padX: number };
  /** Thick outline around the glyphs. */
  stroke?: { color: string; widthRatio: number };
  /** Neon bloom colour. */
  glow?: string;
  /**
   * A coloured box behind the word being spoken, jumping from word to word,
   * with every letter staying white. padRatio is the box padding as a
   * fraction of the font size. The box colour is `highlight` - or, when the
   * user has not picked one, a colour chosen to contrast with the video.
   */
  wordBox?: { padRatio: number };

  /**
   * libass-specific numbers. Outline and shadow are not derivable from the
   * canvas stroke width: ASS measures the outline outward from the glyph,
   * while canvas strokeText centres the line on the path.
   */
  ass: { bold: number; borderStyle: number; outline: number; shadow: number };

  /** Distance from the frame edge, as a fraction of the output height. */
  marginRatio: number;

  /** Layout-only Tailwind classes for the preview and the style cards. */
  previewClass: string;
}

export const SUBTITLE_STYLE_DEFS: SubtitleStyleDef[] = [
  {
    // Asked for by the user (18-11-2026) with a reference frame: white
    // Montserrat Black, the spoken word on a solid colour box. The font ships
    // in fonts/ so it does not depend on what is installed.
    id: 'pill',
    name: 'Recuadro por palabra',
    description:
      'Letras blancas y un recuadro de color que salta a la palabra que se dice. El color se elige para que contraste con el video.',
    badge: '✨ Elegante',
    base: '#FFFFFF',
    highlight: '#7C3AED',
    assFont: 'Montserrat Black',
    cssFont: '"Montserrat Black", "Montserrat", "Arial Black", sans-serif',
    cssWeight: 900,
    sizeRatio: 0.0722,
    uppercase: true,
    ass: { bold: 0, borderStyle: 1, outline: 1, shadow: 3 },
    marginRatio: 0.16667,
    previewClass: 'font-black uppercase drop-shadow-[0_3px_3px_rgba(0,0,0,0.85)]',
    wordBox: { padRatio: 0.18 },
  },
  {
    id: 'hormozi',
    name: 'Alex Hormozi Viral',
    description: 'Mayúsculas amarillas con trazo negro grueso. Máximo impacto visual.',
    badge: '🔥 Más Popular',
    base: '#FACC15',
    highlight: '#22C55E',
    assFont: 'Impact',
    cssFont: '"Impact", "Arial Black", sans-serif',
    cssWeight: 900,
    sizeRatio: 0.0889,
    uppercase: true,
    stroke: { color: '#000000', widthRatio: 0.2 },
    ass: { bold: 1, borderStyle: 1, outline: 5, shadow: 2 },
    marginRatio: 0.16667,
    previewClass: 'font-black uppercase tracking-wider drop-shadow-[0_4px_6px_rgba(0,0,0,1)]',
  },
  {
    id: 'mrbeast',
    name: 'MrBeast High-Energy',
    description: 'Caja negra con borde amarillo y tipografía enérgica.',
    badge: '⚡ Alta Retención',
    base: '#FFFFFF',
    highlight: '#FACC15',
    assFont: 'Arial Black',
    cssFont: '"Arial Black", "Arial", sans-serif',
    cssWeight: 800,
    sizeRatio: 0.0759,
    uppercase: true,
    box: { fill: 'rgba(0,0,0,0.88)', border: '#FACC15', radius: 14, padX: 26 },
    ass: { bold: 1, borderStyle: 3, outline: 4, shadow: 0 },
    marginRatio: 0.16667,
    previewClass:
      'font-extrabold uppercase tracking-wide bg-black/90 border-2 border-yellow-400 px-4 py-1.5 rounded-xl shadow-2xl',
  },
  {
    id: 'cyberpunk',
    name: 'Cyber Neon / Gamer',
    description: 'Brillo cian con acento magenta. Para tech y gaming.',
    badge: '🎮 Tech & Gaming',
    base: '#67E8F9',
    highlight: '#F472B6',
    assFont: 'Consolas',
    cssFont: '"Consolas", "Courier New", monospace',
    cssWeight: 700,
    sizeRatio: 0.063,
    uppercase: false,
    box: { fill: 'rgba(8,14,26,0.85)', border: '#06B6D4', radius: 6, padX: 22 },
    glow: '#06B6D4',
    ass: { bold: 1, borderStyle: 3, outline: 3, shadow: 0 },
    marginRatio: 0.16667,
    previewClass:
      'font-mono font-bold bg-slate-950/80 border border-cyan-500/50 px-4 py-1 rounded-lg drop-shadow-[0_0_10px_rgba(6,182,212,0.9)]',
  },
  {
    id: 'clean_minimal',
    name: 'Minimalista Elegante',
    description: 'Limpio y profesional, para podcasts, negocios y educación.',
    badge: '✨ Podcast & Negocios',
    base: '#F8FAFC',
    highlight: '#818CF8',
    assFont: 'Arial',
    cssFont: '"Arial", sans-serif',
    cssWeight: 600,
    sizeRatio: 0.0556,
    uppercase: false,
    box: { fill: 'rgba(15,23,42,0.85)', radius: 18, padX: 24 },
    ass: { bold: 0, borderStyle: 3, outline: 3, shadow: 0 },
    marginRatio: 0.15625,
    previewClass:
      'font-semibold bg-slate-900/80 backdrop-blur-md px-4 py-1.5 rounded-full shadow-lg',
  },
  {
    id: 'classic',
    name: 'Clásico Blanco',
    description: 'Subtítulo tradicional centrado con sombra suave.',
    badge: '📺 Estándar',
    base: '#FFFFFF',
    highlight: '#FACC15',
    assFont: 'Arial',
    cssFont: '"Arial", sans-serif',
    cssWeight: 700,
    sizeRatio: 0.063,
    uppercase: false,
    stroke: { color: '#000000', widthRatio: 0.09 },
    ass: { bold: 1, borderStyle: 1, outline: 3, shadow: 1 },
    marginRatio: 0.14583,
    previewClass: 'font-bold drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]',
  },
];

const BY_ID = new Map(SUBTITLE_STYLE_DEFS.map((def) => [def.id, def]));

/** Accepts a plain string so callers can pass the SubtitleStyleType enum directly. */
export function getSubtitleStyle(id: string): SubtitleStyleDef {
  return BY_ID.get(id as SubtitleStyleId) ?? SUBTITLE_STYLE_DEFS[SUBTITLE_STYLE_DEFS.length - 1];
}

/**
 * Converts #RRGGBB to the &HAABBGGRR literal ASS expects.
 *
 * `alpha` is ASS's transparency, where 0 is fully opaque and 255 invisible -
 * the inverse of the usual convention.
 */
export function toAssColour(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').trim();
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const a = Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Converts an `rgba(r,g,b,a)` string to the ASS back colour used for boxes. */
export function rgbaToAssColour(rgba: string): string {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(rgba);
  if (!match) return '&H00000000';

  const [, r, g, b, a] = match;
  const opacity = a === undefined ? 1 : Number(a);
  const assAlpha = Math.round((1 - opacity) * 255);

  const hex = (value: string) => Number(value).toString(16).padStart(2, '0');
  return `&H${assAlpha.toString(16).padStart(2, '0')}${hex(b)}${hex(g)}${hex(r)}`.toUpperCase();
}
