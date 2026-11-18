import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssFile, splitLineIntoWords, wordsForLine } from '../lib/ass.js';

const line = (text: string, startTime: number, endTime: number) => ({ text, startTime, endTime });

describe('splitLineIntoWords', () => {
  test('covers the whole duration with no gaps', () => {
    const words = splitLineIntoWords('una frase de prueba', 4000);
    assert.equal(words[0].startMs, 0);
    assert.equal(words[words.length - 1].endMs, 4000);

    for (let i = 1; i < words.length; i++) {
      assert.equal(words[i].startMs, words[i - 1].endMs, 'hueco entre palabras');
    }
  });

  test('gives longer words more time than short ones', () => {
    // An even split is what this exists to avoid: "y" would sit on screen as
    // long as "extraordinario", and the mismatch is obvious once the highlight
    // is following speech.
    const [corta, larga] = splitLineIntoWords('y extraordinario', 2000);
    assert.ok(
      larga.endMs - larga.startMs > corta.endMs - corta.startMs,
      'la palabra larga debería durar más'
    );
  });

  test('never collapses a one-letter word to zero', () => {
    for (const word of splitLineIntoWords('y a o e u i', 1200)) {
      assert.ok(word.endMs > word.startMs, `"${word.text}" duró 0 ms`);
    }
  });

  test('returns nothing for empty text', () => {
    assert.deepEqual(splitLineIntoWords('   ', 1000), []);
  });
});

describe('wordsForLine', () => {
  test('uses real timings when the line carries them', () => {
    const words = wordsForLine({
      text: 'hola mundo',
      startTime: 10,
      endTime: 12,
      // Whisper reports seconds relative to the clip, not to the line.
      words: [
        { text: 'hola', start: 10.2, end: 10.5 },
        { text: 'mundo', start: 11.0, end: 11.9 },
      ],
    });

    assert.deepEqual(
      words.map((w) => [w.text, w.startMs, w.endMs]),
      [
        ['hola', 200, 500],
        ['mundo', 1000, 1900],
      ]
    );
  });

  test('falls back to the estimate when there are no real timings', () => {
    const words = wordsForLine(line('hola mundo', 0, 2));
    assert.equal(words.length, 2);
    assert.equal(words[0].startMs, 0);
    assert.equal(words[words.length - 1].endMs, 2000);
  });

  test('keeps real timings inside the line, never past its end', () => {
    const words = wordsForLine({
      text: 'desbordado',
      startTime: 0,
      endTime: 1,
      words: [{ text: 'desbordado', start: 0, end: 5 }],
    });
    assert.ok(words[0].endMs <= 1000);
  });
});

describe('buildAssFile', () => {
  const lines = [line('Hola mundo', 0, 2), line('Segunda frase', 2, 4)];

  test('emits one dialogue row per line', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920);
    assert.equal(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 2);
  });

  test('scales the font with the output width', () => {
    const narrow = buildAssFile(lines, 'hormozi', 1080, 1920);
    const wide = buildAssFile(lines, 'hormozi', 1920, 1080);

    const size = (ass: string) =>
      Number(ass.split('\n').find((l) => l.startsWith('Style: Viral'))!.split(',')[2]);

    assert.ok(size(wide) > size(narrow), 'un frame más ancho debería usar texto mayor');
  });

  test('puts the box colour in OutlineColour for boxed styles', () => {
    // BorderStyle 3 paints the box from OutlineColour, not BackColour. Getting
    // that backwards painted MrBeast as a solid yellow slab that swallowed the
    // highlighted word.
    const fields = buildAssFile(lines, 'mrbeast', 1080, 1920)
      .split('\n')
      .find((l) => l.startsWith('Style: Viral'))!
      .split(',');

    // Field order follows the Format: line. BorderStyle is 15, OutlineColour 5.
    assert.equal(fields[15], '3', 'mrbeast debería usar BorderStyle 3');
    assert.match(fields[5], /^&H[0-9A-F]{2}000000$/, 'la caja debería ser negra');
  });

  test('strips emoji, which libass cannot render', () => {
    const ass = buildAssFile([line('[Risas 😂] increíble 🔥', 0, 2)], 'hormozi', 1080, 1920);
    assert.ok(!/[\u{1F000}-\u{1FAFF}]/u.test(ass), 'quedaron emoji en el ASS');
    assert.match(ass, /RISAS/);
    assert.match(ass, /INCREÍBLE/);
  });

  test('keeps Spanish accents and punctuation intact', () => {
    const ass = buildAssFile([line('¿Qué pasó aquí? Año', 0, 2)], 'classic', 1080, 1920);
    assert.match(ass, /¿Qué pasó aquí\? Año/);
  });

  test('escapes braces so they cannot open an override block', () => {
    const ass = buildAssFile([line('un {truco} raro', 0, 2)], 'classic', 1080, 1920);
    assert.match(ass, /\\\{truco\\\}/);
  });

  test('emits karaoke timings per word', () => {
    const ass = buildAssFile([line('una dos tres', 0, 3)], 'hormozi', 1080, 1920, 'bottom', 'karaoke');
    assert.equal((ass.match(/\\k\d+/g) || []).length, 3);
  });

  test('word-pop recolours each word on its own beat', () => {
    const dialogue = buildAssFile(
      [line('una dos tres', 0, 3)],
      'hormozi',
      1080,
      1920,
      'bottom',
      'word-pop'
    )
      .split('\n')
      .find((l) => l.startsWith('Dialogue:'))!;

    // Each word gets a pair of transforms (grow into the accent, settle back),
    // on top of the two the line-level pop entrance contributes.
    assert.equal((dialogue.match(/\\t\(/g) || []).length, 3 * 2 + 2);

    // And each word is recoloured to the style's highlight on its own beat.
    assert.equal((dialogue.match(/&H005EC522/g) || []).length, 3);
  });

  test('adds no animation tags when animation is none', () => {
    const dialogue = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'none')
      .split('\n')
      .find((l) => l.startsWith('Dialogue:'))!;
    assert.ok(!dialogue.includes('\\t('));
    assert.ok(!dialogue.includes('\\fad'));
  });

  test('drops lines that end before they start', () => {
    const ass = buildAssFile([line('válida', 0, 2), line('inválida', 5, 3)], 'classic', 1080, 1920);
    assert.equal(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 1);
  });
});

describe('buildAssFile con la leyenda arrastrada', () => {
  const lines = [{ text: 'HOLA MUNDO', startTime: 0, endTime: 2 }];

  const styleField = (ass: string, index: number) =>
    ass.split('\n').find((l) => l.startsWith('Style:'))!.split(',')[index];

  const dialogue = (ass: string) =>
    ass.split('\n').find((l) => l.startsWith('Dialogue:'))!.split(',').slice(9).join(',');

  test('sin anchor nada cambia: sigue colocándose por alineación', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'none');
    assert.equal(styleField(ass, 18), '2');
    assert.ok(!dialogue(ass).includes('\pos('));
  });

  test('con anchor pasa a alineación 5, que es la que centra en el punto', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'none', {
      anchor: { x: 0.5, y: 0.4 },
    });
    assert.equal(styleField(ass, 18), '5');
    assert.match(dialogue(ass), /\pos\(540,768\)/);
  });

  test('no deja arrastrar el texto fuera del cuadro por el lado', () => {
    // \pos centra la línea en el punto y no la parte para que quepa, así que
    // un anchor pegado al borde sacaba medio subtítulo de cuadro.
    const izq = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'none', {
      anchor: { x: 0.02, y: 0.4 },
    });
    const x = Number(dialogue(izq).match(/\pos\((\d+),/)![1]);
    // La mitad del texto ("HOLA MUNDO" a 96 px) tiene que caber a su izquierda.
    assert.ok(x > 300, `x=${x} deja el texto saliéndose`);
  });

  test('un texto más largo obliga a quedarse más cerca del centro', () => {
    const anchor = { x: 0.02, y: 0.4 };
    const xDe = (texto: string) => {
      const ass = buildAssFile([{ text: texto, startTime: 0, endTime: 2 }], 'hormozi', 1080, 1920, 'bottom', 'none', { anchor });
      return Number(dialogue(ass).match(/\pos\((\d+),/)![1]);
    };
    assert.ok(xDe('UNA FRASE MUCHO MAS LARGA') > xDe('CORTO'));
  });

  test('un texto que no cabe de ninguna forma se centra', () => {
    const ass = buildAssFile(
      [{ text: 'UNA FRASE TAN LARGA QUE NO CABE DE NINGUNA MANERA EN EL CUADRO', startTime: 0, endTime: 2 }],
      'hormozi', 1080, 1920, 'bottom', 'none', { anchor: { x: 0.05, y: 0.4 } }
    );
    assert.match(dialogue(ass), /\pos\(540,/);
  });

  test('el anchor manda sobre la posición elegida', () => {
    const arriba = buildAssFile(lines, 'hormozi', 1080, 1920, 'top', 'none', {
      anchor: { x: 0.5, y: 0.8 },
    });
    assert.match(dialogue(arriba), /\pos\(540,1536\)/);
    assert.equal(styleField(arriba, 18), '5');
  });

  test('un anchor fuera del cuadro se recorta en vez de sacar el texto', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'none', {
      anchor: { x: -5, y: 9 },
    });
    const [, x, y] = dialogue(ass).match(/\pos\((\d+),(\d+)\)/)!.map(Number);
    assert.ok(x > 300 && x < 780, `x=${x}`);
    assert.equal(y, 1824);
  });

  test('slide aterriza en el anchor, y no emite \pos además de \move', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'slide', {
      anchor: { x: 0.5, y: 0.4 },
    });
    const d = dialogue(ass);
    // \move gana sobre \pos, así que los dos juntos dejarían el \pos sin efecto.
    assert.ok(!d.includes('\pos('), d);
    assert.match(d, /\move\(540,838,540,768,0,190\)/);
  });

  test('slide sin anchor conserva el comportamiento de siempre', () => {
    const ass = buildAssFile(lines, 'hormozi', 1080, 1920, 'bottom', 'slide');
    assert.match(dialogue(ass), /\move\(540,1670,540,1600,0,190\)/);
  });
});
