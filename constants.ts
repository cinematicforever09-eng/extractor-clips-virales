import {
  SubtitleStyle,
  SubtitleStyleType,
  SubtitleAnimationOption,
  FramingMode,
} from './types';
import { SUBTITLE_STYLE_DEFS } from './lib/subtitle-styles';

/**
 * The style cards shown in the UI. Derived from the shared definitions rather
 * than restated, which is what had let the card colours drift away from what
 * the exporter actually produced.
 */
export const SUBTITLE_STYLES: SubtitleStyle[] = SUBTITLE_STYLE_DEFS.map((def) => ({
  id: def.id as SubtitleStyleType,
  name: def.name,
  description: def.description,
  badge: def.badge,
  previewClass: def.previewClass,
  textColor: def.base,
}));

export const MAX_FRAMES_FOR_ANALYSIS = 18;

export interface FramingModeOption {
  id: FramingMode;
  name: string;
  description: string;
  badge: string;
}

export const FRAMING_MODES: FramingModeOption[] = [
  {
    id: 'auto-fill',
    name: 'Seguir a quien habla',
    description:
      'Marca a las dos personas y el encuadre salta solo a la que se mueve. Pensado para cámara fija: en video en mano sigue el movimiento, no la voz.',
    badge: '🔄 Automático',
  },
  {
    id: 'focus',
    name: 'Seguir a una persona',
    description:
      'Recorte vertical a pantalla completa centrado en quien marques. Sin barras ni desenfoque, como los reels de Opus Clip.',
    badge: '🎯 El más usado',
  },
  {
    id: 'split',
    name: 'Pantalla dividida',
    description:
      'Dos personas apiladas, cada una recortada de su lado del fotograma. Para cuando hablan los dos a la vez.',
    badge: '👥 Dos personas',
  },
  {
    id: 'gameplay',
    name: 'Streamer + juego',
    description:
      'El juego y la cara del streamer apilados, cada uno recortado de su sitio. Eliges si la cámara va arriba o abajo y de qué tamaño. Marca primero la cámara y después la zona de juego; si no marcas el juego se usa el fotograma entero.',
    badge: '🎮 Gaming',
  },
  {
    id: 'blur-fill',
    name: 'Fondo Desenfocado Dinámico',
    description: 'El video se centra y en el fondo el mismo video se desenfoca para llenar el formato vertical sin barras negras',
    badge: '🌟 Recomendado (Sin cortes)',
  },
  {
    id: 'zoom-crop',
    name: 'Zoom & Llenar Pantalla',
    description: 'Hace zoom al video para llenar el 100% de la pantalla vertical 9:16 eliminando bordes',
    badge: '🔍 Inmersivo (Estilo TikTok)',
  },
  {
    id: 'fit',
    name: 'Ajustar con Bordes Limpios',
    description: 'Muestra el video completo en su proporción original con fondo oscuro elegante',
    badge: '⬛ Clásico',
  },
];

export const SAMPLE_VIDEOS = [
  {
    id: 'sample-1',
    name: 'Podcast Tech & IA (MP4)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    description: 'Video de demostración para probar extracción de momentos virales',
  },
  {
    id: 'sample-2',
    name: 'Naturaleza & Animación (MP4)',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    description: 'Video de alta resolución para probar renderizado',
  },
];

export const SUBTITLE_ANIMATIONS: SubtitleAnimationOption[] = [
  {
    id: 'word-pop',
    name: 'Palabra a palabra',
    description:
      'Cada palabra crece y cambia de color justo cuando se pronuncia. Es el efecto de los reels con más retención.',
    badge: '🔥 Más viral',
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    description:
      'Las palabras se van coloreando al ritmo del habla, sin cambiar de tamaño. Más sobrio que el anterior.',
    badge: '🎤 Sigue la voz',
  },
  {
    id: 'pop',
    name: 'Rebote de entrada',
    description: 'La frase entera aparece con un golpe de escala y se asienta. Rápido y limpio.',
    badge: '⚡ Enérgico',
  },
  {
    id: 'slide',
    name: 'Deslizar hacia arriba',
    description: 'La frase sube a su sitio mientras aparece. Funciona bien en contenido editorial.',
    badge: '🎬 Elegante',
  },
  {
    id: 'fade',
    name: 'Fundido suave',
    description: 'Aparece y desaparece con una transición corta, sin movimiento.',
    badge: '🌙 Discreto',
  },
  {
    id: 'none',
    name: 'Sin animación',
    description: 'El subtítulo aparece y desaparece de golpe.',
    badge: '⬜ Estático',
  },
];
