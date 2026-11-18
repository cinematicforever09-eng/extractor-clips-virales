import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEmojiCues,
  planEmojiLayout,
  estimateCaptionLines,
  buildEmojiOverlayFilter,
  type EmojiLine,
} from '../lib/emoji-overlay.js';

const line = (
  startTime: number,
  endTime: number,
  words: Array<{ text: string; start: number; end: number; emoji?: string }>
): EmojiLine => ({ startTime, endTime, words });

describe('collectEmojiCues', () => {
  test('ignora las palabras sin emoji', () => {
    const cues = collectEmojiCues([
      line(0, 3, [
        { text: 'hola', start: 0, end: 0.5 },
        { text: 'mundo', start: 0.5, end: 1 },
      ]),
    ]);
    assert.equal(cues.length, 0);
  });

  test('crea una señal por palabra marcada', () => {
    const cues = collectEmojiCues([
      line(0, 5, [
        { text: 'dinero', start: 1, end: 1.6, emoji: '💰' },
        { text: 'fuego', start: 2, end: 2.4, emoji: '🔥' },
      ]),
    ]);
    assert.deepEqual(
      cues.map((c) => c.emoji),
      ['💰', '🔥']
    );
    assert.equal(cues[0].start, 1);
  });

  test('mantiene el emoji en pantalla un momento después de la palabra', () => {
    const [cue] = collectEmojiCues([
      line(0, 10, [{ text: 'ya', start: 1, end: 1.2, emoji: '👉' }]),
    ]);
    // La palabra dura 0.2 s; la señal tiene que durar bastante más.
    assert.ok(cue.end - cue.start > 1, `duró ${cue.end - cue.start}s`);
  });

  test('no deja el emoji colgando más allá de su línea', () => {
    const [cue] = collectEmojiCues([
      line(0, 2, [{ text: 'final', start: 1.8, end: 2, emoji: '🔥' }]),
    ]);
    assert.ok(cue.end <= 2, `terminó en ${cue.end}`);
  });

  test('ordena las señales por tiempo aunque lleguen desordenadas', () => {
    const cues = collectEmojiCues([
      line(0, 5, [{ text: 'b', start: 3, end: 3.2, emoji: '🔥' }]),
      line(0, 5, [{ text: 'a', start: 1, end: 1.2, emoji: '💰' }]),
    ]);
    assert.deepEqual(
      cues.map((c) => c.emoji),
      ['💰', '🔥']
    );
  });
});

describe('planEmojiLayout', () => {
  const base = { width: 1080, height: 1920, fontSize: 96, marginV: 320 };

  test('queda centrado horizontalmente', () => {
    const layout = planEmojiLayout({ ...base, position: 'bottom' });
    const centre = layout.x + layout.size / 2;
    assert.ok(Math.abs(centre - 540) < 2, `centro en ${centre}`);
  });

  test('abajo: va por encima del texto, no sobre él', () => {
    const layout = planEmojiLayout({ ...base, position: 'bottom' });
    const capTop = 1920 - base.marginV - base.fontSize * 1.25;
    assert.ok(
      layout.y + layout.size <= capTop,
      `el emoji termina en ${layout.y + layout.size} y el texto empieza en ${capTop}`
    );
  });

  test('arriba con margen pequeño: baja en vez de salirse del cuadro', () => {
    const layout = planEmojiLayout({ ...base, position: 'top', marginV: 40 });
    assert.ok(layout.y >= 8, `y=${layout.y} se sale por arriba`);
  });

  test('nunca se sale del cuadro', () => {
    for (const position of ['top', 'center', 'bottom'] as const) {
      for (const marginV of [0, 40, 320, 900]) {
        const layout = planEmojiLayout({ ...base, position, marginV });
        assert.ok(layout.y >= 0, `${position}/${marginV}: y=${layout.y}`);
        assert.ok(
          layout.y + layout.size <= 1920,
          `${position}/${marginV}: termina en ${layout.y + layout.size}`
        );
      }
    }
  });

  test('una leyenda de dos líneas empuja el emoji más arriba', () => {
    const one = planEmojiLayout({ ...base, position: 'bottom', captionLines: 1 });
    const two = planEmojiLayout({ ...base, position: 'bottom', captionLines: 2 });
    assert.ok(two.y < one.y, `una línea y=${one.y}, dos líneas y=${two.y}`);
  });

  test('abajo y con dos líneas: sigue sin pisar el texto', () => {
    const layout = planEmojiLayout({ ...base, position: 'bottom', captionLines: 2 });
    const capTop = 1920 - base.marginV - base.fontSize * 1.25 * 2;
    assert.ok(
      layout.y + layout.size <= capTop,
      `el emoji termina en ${layout.y + layout.size} y el texto empieza en ${capTop}`
    );
  });

  test('el tamaño sigue al de la letra', () => {
    const small = planEmojiLayout({ ...base, position: 'bottom', fontSize: 60 });
    const big = planEmojiLayout({ ...base, position: 'bottom', fontSize: 140 });
    assert.ok(big.size > small.size);
  });
});

describe('estimateCaptionLines', () => {
  test('una frase corta cabe en una línea', () => {
    assert.equal(estimateCaptionLines('HOLA MUNDO', 1080, 96, 60), 1);
  });

  test('la frase que se partió en el render sale como dos', () => {
    // El caso real: con word-pop esta leyenda se parte en dos filas y el emoji
    // se quedaba encima del texto.
    assert.ok(estimateCaptionLines('ESTO ESTA QUEMANDO DINERO', 1080, 96, 60) >= 2);
  });

  test('con la letra más grande se parte antes', () => {
    const small = estimateCaptionLines('UNA FRASE DE LARGO MEDIO', 1080, 70, 60);
    const big = estimateCaptionLines('UNA FRASE DE LARGO MEDIO', 1080, 140, 60);
    assert.ok(big > small, `pequeña ${small}, grande ${big}`);
  });

  test('nunca devuelve cero, ni con texto vacío', () => {
    assert.equal(estimateCaptionLines('', 1080, 96, 60), 1);
    assert.equal(estimateCaptionLines('   ', 1080, 96, 60), 1);
  });

  test('un cuadro más ancho aguanta más texto por línea', () => {
    const narrow = estimateCaptionLines('UNA FRASE BASTANTE LARGA DE VERDAD', 1080, 96, 60);
    const wide = estimateCaptionLines('UNA FRASE BASTANTE LARGA DE VERDAD', 1920, 96, 60);
    assert.ok(wide <= narrow, `estrecho ${narrow}, ancho ${wide}`);
  });
});

describe('buildEmojiOverlayFilter', () => {
  const layout = { size: 110, x: 485, y: 1400 };

  test('sin señales no añade nada al grafo', () => {
    assert.equal(buildEmojiOverlayFilter('[v]', [], layout, 1), null);
  });

  test('encadena un overlay por señal', () => {
    const built = buildEmojiOverlayFilter(
      '[v]',
      [
        { emoji: '🔥', start: 1, end: 2 },
        { emoji: '💰', start: 3, end: 4 },
      ],
      layout,
      1
    );
    assert.ok(built);
    // La salida de cada overlay tiene que ser la entrada del siguiente.
    assert.match(built.filter, /\[v\]\[es0\]overlay=/);
    assert.match(built.filter, /\[emo0\]\[es1\]overlay=/);
    assert.equal(built.outLabel, '[emo1]');
  });

  test('cada PNG se escala al tamaño del diseño', () => {
    const built = buildEmojiOverlayFilter('[v]', [{ emoji: '🔥', start: 0, end: 1 }], layout, 1);
    assert.match(built!.filter, /\[1:v\]scale=110:110/);
  });

  test('el mismo emoji dos veces usa dos entradas distintas', () => {
    const built = buildEmojiOverlayFilter(
      '[v]',
      [
        { emoji: '🔥', start: 0, end: 1 },
        { emoji: '🔥', start: 2, end: 3 },
      ],
      layout,
      1
    );
    assert.match(built!.filter, /\[1:v\]scale=/);
    assert.match(built!.filter, /\[2:v\]scale=/);
  });

  test('cada señal solo se ve en su ventana de tiempo', () => {
    const built = buildEmojiOverlayFilter('[v]', [{ emoji: '🔥', start: 1.5, end: 2.75 }], layout, 1);
    assert.match(built!.filter, /enable='between\(t,1\.50,2\.75\)'/);
  });

  test('respeta el índice de entrada del primer PNG', () => {
    const built = buildEmojiOverlayFilter('[v]', [{ emoji: '🔥', start: 0, end: 1 }], layout, 5);
    assert.match(built!.filter, /\[5:v\]scale=/);
  });

  test('repite el último fotograma del PNG, que si no desaparece', () => {
    const built = buildEmojiOverlayFilter('[v]', [{ emoji: '🔥', start: 0, end: 1 }], layout, 1);
    assert.match(built!.filter, /eof_action=repeat/);
  });
});

describe('planEmojiLayout con la leyenda arrastrada', () => {
  const base = { width: 1080, height: 1920, fontSize: 96, marginV: 320 };

  test('el emoji sigue al anchor y no a la posición preestablecida', () => {
    const alto = planEmojiLayout({ ...base, position: 'bottom', anchorY: 0.25 });
    const bajo = planEmojiLayout({ ...base, position: 'bottom', anchorY: 0.75 });
    assert.ok(alto.y < bajo.y, `arriba y=${alto.y}, abajo y=${bajo.y}`);
  });

  test('queda por encima del texto, que está centrado en el anchor', () => {
    const layout = planEmojiLayout({ ...base, position: 'bottom', anchorY: 0.5 });
    const capTop = 1920 * 0.5 - (base.fontSize * 1.25) / 2;
    assert.ok(
      layout.y + layout.size <= capTop,
      `el emoji termina en ${layout.y + layout.size} y el texto empieza en ${capTop}`
    );
  });

  test('un anchor pegado al borde de arriba no saca el emoji del cuadro', () => {
    const layout = planEmojiLayout({ ...base, position: 'bottom', anchorY: 0.05 });
    assert.ok(layout.y >= 0, `y=${layout.y}`);
    assert.ok(layout.y + layout.size <= 1920);
  });
});
