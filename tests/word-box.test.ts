import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssFile, wordBoxEvents } from '../lib/ass.js';
import { chooseAccent, dominantHue, hueDistance, ACCENT_PALETTE, NEUTRAL_ACCENT } from '../lib/accent.js';

const line = {
  text: 'deja de utilizar estos',
  startTime: 1,
  endTime: 3,
  words: [
    { text: 'deja', start: 1.0, end: 1.3 },
    { text: 'de', start: 1.35, end: 1.5 },
    { text: 'utilizar', start: 1.6, end: 2.2 },
    { text: 'estos', start: 2.3, end: 2.8 },
  ],
};

describe('subtítulos con recuadro por palabra', () => {
  const ass = buildAssFile([line], 'pill', 1080, 1920, 'bottom', 'word-pop', { highlight: '#7C3AED' });

  test('dos estilos: el texto blanco y la caja (BorderStyle 3) con el color elegido', () => {
    assert.match(ass, /^Style: Viral,Montserrat Black,/m);
    // #7C3AED en ASS es &H00ED3A7C (azul, verde, rojo al revés).
    assert.match(ass, /^Style: WordBox,Montserrat Black,\d+,&H00FFFFFF,&H00FFFFFF,&H00ED3A7C,&H00000000,0,0,0,0,100,100,0,0,3,/m);
  });

  test('la línea completa en blanco más un evento de caja por palabra', () => {
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    assert.equal(events.length, 1 + 4);
    assert.match(events[0], /^Dialogue: 0,.*,Viral,.*DEJA DE UTILIZAR ESTOS$/);
  });

  test('en cada evento de caja solo se ve la palabra que se dice', () => {
    const boxes = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,'));
    const hidden = String.raw`{\alpha&HFF&}`;
    const shown = String.raw`{\alpha&H00&}`;
    assert.ok(
      boxes[2].endsWith(`${hidden}DEJA DE ${shown}UTILIZAR${hidden} ESTOS`),
      boxes[2]
    );
  });

  test('la caja se queda hasta que empieza la palabra siguiente (no parpadea)', () => {
    const boxes = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,'));
    // "deja" va de 1.00 a 1.35, cuando empieza "de".
    assert.match(boxes[0], /^Dialogue: 1,0:00:01\.00,0:00:01\.35,WordBox/);
    // La última llega hasta el final de la línea.
    assert.match(boxes[3], /,0:00:03\.00,WordBox/);
  });

  test('sin caracteres de control colados (la trampa de los escapes)', () => {
    assert.doesNotMatch(ass, /[\x08\x0c]/);
    assert.doesNotMatch(wordBoxEvents([line], true, { x: 0.5, y: 0.6 }, 1080, 1920), /[\x08\x0c]/);
  });

  test('los otros estilos no cambian: un solo evento por línea', () => {
    const hormozi = buildAssFile([line], 'hormozi', 1080, 1920, 'bottom', 'word-pop');
    assert.equal(hormozi.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 1);
    assert.doesNotMatch(hormozi, /WordBox/);
  });
});

describe('color del recuadro según el video', () => {
  const fill = (r: number, g: number, b: number, n = 300) => {
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) out.set([r, g, b], i * 3);
    return out;
  };

  test('video morado (escenario de streamer): el recuadro no es morado', () => {
    const accent = chooseAccent(fill(120, 40, 200));
    assert.ok(hueDistance(accent.hue, 270) > 90, accent.name);
  });

  test('bosque verde: el recuadro se aleja del verde', () => {
    const accent = chooseAccent(fill(40, 140, 60));
    assert.ok(hueDistance(accent.hue, 130) > 90, accent.name);
  });

  test('video en grises: color por defecto', () => {
    assert.equal(chooseAccent(fill(128, 128, 128)), NEUTRAL_ACCENT);
    assert.equal(dominantHue(fill(20, 20, 20)), null);
  });

  test('todos los colores dejan leer letras blancas (contraste >= 4.5)', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    for (const accent of ACCENT_PALETTE) {
      const contrast = 1.05 / (lum(accent.hex) + 0.05);
      assert.ok(contrast >= 4.5, `${accent.name} ${contrast.toFixed(2)}`);
    }
  });
});
