import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurns } from '../lib/active-speaker.js';
import { buildReframeFilter, type SpeakerRegion } from '../lib/reframe.js';

/** Traza plana con picos en los tramos indicados. */
function trace(samples: number, loud: Array<[number, number]>, fps = 10): number[] {
  return Array.from({ length: samples }, (_, i) =>
    loud.some(([a, b]) => i / fps >= a && i / fps < b) ? 30 : 4
  );
}

describe('resolveTurns', () => {
  test('sigue a quien se mueve más', () => {
    const a = trace(100, [[0, 5]]);
    const b = trace(100, [[5, 10]]);
    const turns = resolveTurns(a, b, 10);

    assert.ok(turns.length >= 2, 'no detectó el cambio');
    assert.equal(turns[0].speaker, 0);
    assert.equal(turns[turns.length - 1].speaker, 1);
  });

  test('cubre el clip entero sin huecos', () => {
    const turns = resolveTurns(trace(100, [[0, 4]]), trace(100, [[4, 10]]), 10);

    assert.equal(turns[0].start, 0);
    assert.equal(turns[turns.length - 1].end, 10);
    for (let i = 1; i < turns.length; i++) {
      assert.equal(turns[i].start, turns[i - 1].end, 'hueco entre turnos');
    }
  });

  test('no parpadea cuando los dos se mueven parecido', () => {
    // Sin histéresis, un empate hace que el encuadre salte cada fotograma.
    const ruido = Array.from({ length: 100 }, (_, i) => 10 + (i % 2));
    const otro = Array.from({ length: 100 }, (_, i) => 10 + ((i + 1) % 2));
    const turns = resolveTurns(ruido, otro, 10);

    assert.ok(turns.length <= 2, `saltó ${turns.length} veces con un empate`);
  });

  test('respeta el tiempo mínimo en pantalla', () => {
    const a = trace(200, [[0, 1], [2, 3], [4, 5]]);
    const b = trace(200, [[1, 2], [3, 4], [5, 20]]);
    const turns = resolveTurns(a, b, 20, { minHold: 2 });

    for (const turn of turns.slice(0, -1)) {
      assert.ok(turn.end - turn.start >= 1.9, `turno de ${turn.end - turn.start}s`);
    }
  });

  test('sin señal se queda con el primero en vez de fallar', () => {
    const turns = resolveTurns([], [], 8);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].speaker, 0);
    assert.equal(turns[0].end, 8);
  });
});

describe('auto-fill', () => {
  const base = { sourceWidth: 1920, sourceHeight: 1080, targetWidth: 1080, targetHeight: 1920 };
  const dos: SpeakerRegion[] = [
    { x: 0.05, y: 0.2, width: 0.3, height: 0.6 },
    { x: 0.65, y: 0.2, width: 0.3, height: 0.6 },
  ];

  test('mueve el recorte con el tiempo', () => {
    const { filter, appliedMode } = buildReframeFilter({
      ...base,
      mode: 'auto-fill',
      speakers: dos,
      turns: [
        { start: 0, end: 4, speaker: 0 },
        { start: 4, end: 10, speaker: 1 },
      ],
    });

    assert.equal(appliedMode, 'auto-fill');
    // crop evalúa x/y por fotograma solo, sin la opción eval (que ya no existe).
    assert.ok(!filter.includes('eval='), 'eval= revienta el render en FFmpeg actual');
    assert.match(filter, /if\(lt\(t,4\.00\)/);
  });

  test('mantiene el mismo tamaño de recorte en los dos', () => {
    // Si cambiara de tamaño al cortar, la escala saltaría y se notaría el corte.
    const { filter } = buildReframeFilter({
      ...base,
      mode: 'auto-fill',
      speakers: dos,
      turns: [
        { start: 0, end: 4, speaker: 0 },
        { start: 4, end: 10, speaker: 1 },
      ],
    });

    const crop = /crop=(\d+):(\d+):/.exec(filter);
    assert.ok(crop, 'no encontró el recorte');
    assert.ok(Number(crop![1]) > 0 && Number(crop![2]) > 0);
  });

  test('con una sola persona cae a encuadre fijo', () => {
    const { appliedMode } = buildReframeFilter({
      ...base,
      mode: 'auto-fill',
      speakers: [dos[0]],
      turns: [{ start: 0, end: 10, speaker: 0 }],
    });
    assert.equal(appliedMode, 'focus');
  });

  test('sin turnos cae a encuadre fijo en vez de romperse', () => {
    const { appliedMode, filter } = buildReframeFilter({
      ...base,
      mode: 'auto-fill',
      speakers: dos,
    });
    assert.equal(appliedMode, 'focus');
    assert.match(filter, /crop=\d+:\d+:\d+:\d+/);
  });
});
