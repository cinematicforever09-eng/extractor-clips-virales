import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSceneCuts,
  cutsToShots,
  frameDistance,
  fallbackRanges,
  remapToKept,
  SAME_CAMERA_MAX_DISTANCE,
  type Shot,
} from '../lib/shots.js';
import { buildReframeFilter, rangesExpression } from '../lib/reframe.js';
import { maskTraces, resolveTurns } from '../lib/active-speaker.js';

describe('parseSceneCuts', () => {
  test('lee los tiempos de corte de la salida de scdet', () => {
    const output = [
      'frame:230  pts:231000 pts_time:7.705933',
      'lavfi.scd.mafd=16.243',
      'lavfi.scd.score=16.243',
      'lavfi.scd.time=7.705933',
      'frame:277  pts:277000 pts_time:9.2408',
      'lavfi.scd.score=16.612',
    ].join('\n');
    assert.deepEqual(parseSceneCuts(output), [7.705933, 9.2408]);
  });

  test('sin cortes devuelve lista vacía', () => {
    assert.deepEqual(parseSceneCuts(''), []);
  });
});

describe('cutsToShots', () => {
  test('cubre el clip entero sin huecos', () => {
    const shots = cutsToShots([7.7, 9.2, 21.1], 30);
    assert.equal(shots[0].start, 0);
    assert.equal(shots[shots.length - 1].end, 30);
    for (let i = 1; i < shots.length; i++) assert.equal(shots[i].start, shots[i - 1].end);
    assert.equal(shots.length, 4);
  });

  test('un fundido que dispara varios cuadros seguidos es un solo corte', () => {
    const shots = cutsToShots([10, 10.03, 10.07, 10.1], 20);
    assert.equal(shots.length, 2);
    assert.equal(shots[1].start, 10);
  });

  test('ignora cortes pegados al principio o al final', () => {
    assert.equal(cutsToShots([0.1, 19.9], 20).length, 1);
  });
});

describe('frameDistance', () => {
  const flat = (value: number) => new Array(32 * 18).fill(value);
  const pattern = (shift: number) =>
    Array.from({ length: 32 * 18 }, (_, i) => ((i % 32) < 16 ? 40 : 200) + shift);

  test('el mismo encuadre más claro sigue siendo la misma cámara', () => {
    assert.ok(frameDistance(pattern(0), pattern(30)) < 1);
  });

  test('una composición distinta supera el umbral', () => {
    const mirrored = Array.from({ length: 32 * 18 }, (_, i) => ((i % 32) < 16 ? 200 : 40));
    assert.ok(frameDistance(pattern(0), mirrored) > SAME_CAMERA_MAX_DISTANCE);
  });

  test('sin datos no coincide con nada', () => {
    assert.equal(frameDistance([], flat(10)), Infinity);
  });
});

describe('remapToKept', () => {
  test('sin limpieza de silencios no cambia nada', () => {
    const ranges = [{ start: 5, end: 8 }];
    assert.deepEqual(remapToKept(ranges, undefined), ranges);
  });

  test('corre los tramos según las pausas quitadas', () => {
    // Se quitó la pausa de 4 a 6: lo que estaba en 7-9 pasa a 5-7.
    const keep = [
      { start: 0, end: 4 },
      { start: 6, end: 12 },
    ];
    assert.deepEqual(remapToKept([{ start: 7, end: 9 }], keep), [{ start: 5, end: 7 }]);
  });

  test('un tramo partido por una pausa quitada queda en una sola pieza', () => {
    const keep = [
      { start: 0, end: 4 },
      { start: 6, end: 12 },
    ];
    assert.deepEqual(remapToKept([{ start: 3, end: 8 }], keep), [{ start: 3, end: 6 }]);
  });

  test('un tramo que cae entero en una pausa quitada desaparece', () => {
    const keep = [
      { start: 0, end: 4 },
      { start: 6, end: 12 },
    ];
    assert.deepEqual(remapToKept([{ start: 4.5, end: 5.5 }], keep), []);
  });
});

describe('encuadre por tomas', () => {
  const shots: Shot[] = [
    { start: 0, end: 7.7, matchesReference: true },
    { start: 7.7, end: 9.2, matchesReference: false },
    { start: 9.2, end: 20, matchesReference: true },
  ];
  const base = {
    sourceWidth: 1920,
    sourceHeight: 1080,
    targetWidth: 1080,
    targetHeight: 1920,
    speakers: [{ x: 0.4, y: 0.2, width: 0.2, height: 0.4 }],
  };

  test('solo las tomas de otra cámara van en plano completo', () => {
    assert.deepEqual(fallbackRanges(shots), [{ start: 7.7, end: 9.2 }]);
  });

  test('focus con otra cámara pone el plano completo encima solo en ese tramo', () => {
    const { filter, appliedMode } = buildReframeFilter({
      ...base,
      mode: 'focus',
      fallbackRanges: fallbackRanges(shots),
    });
    assert.equal(appliedMode, 'focus');
    assert.match(filter, /^\[0:v\]split=2\[rf_in\]\[bf_in\];\[rf_in\]crop=/);
    assert.match(filter, /\[bf_in\]split=2\[bg\]\[fg\]/);
    assert.match(filter, /overlay=0:0:enable='between\(t,7\.700,9\.200\)'$/);
  });

  test('si todas las tomas son de la misma cámara el filtro no cambia', () => {
    const plain = buildReframeFilter({ ...base, mode: 'focus' });
    const withShots = buildReframeFilter({ ...base, mode: 'focus', fallbackRanges: [] });
    assert.equal(withShots.filter, plain.filter);
  });

  test('blur-fill y zoom-crop no se tocan', () => {
    for (const mode of ['blur-fill', 'zoom-crop'] as const) {
      const plain = buildReframeFilter({ ...base, mode });
      const withShots = buildReframeFilter({ ...base, mode, fallbackRanges: [{ start: 1, end: 2 }] });
      assert.equal(withShots.filter, plain.filter, mode);
    }
  });

  test('varios tramos se suman en la expresión', () => {
    assert.equal(
      rangesExpression([
        { start: 1, end: 2 },
        { start: 5.5, end: 6 },
      ]),
      'between(t,1.000,2.000)+between(t,5.500,6.000)'
    );
  });
});

describe('maskTraces', () => {
  test('el movimiento en la toma de otra cámara no cambia de hablante', () => {
    const fps = 10;
    // A se mueve al principio; en 4-6 hay otra cámara donde "B" se mueve mucho.
    const a = Array.from({ length: 100 }, (_, i) => (i < 40 ? 30 : 4));
    const b = Array.from({ length: 100 }, (_, i) => (i >= 40 && i < 60 ? 80 : 4));
    const shots: Shot[] = [
      { start: 0, end: 4, matchesReference: true },
      { start: 4, end: 6, matchesReference: false },
      { start: 6, end: 10, matchesReference: true },
    ];

    const unmasked = resolveTurns(a, b, 10, { fps });
    assert.ok(unmasked.some((t) => t.speaker === 1), 'sin máscara sí cambiaba');

    const [ma, mb] = maskTraces(a, b, fps, shots);
    const masked = resolveTurns(ma, mb, 10, { fps });
    assert.ok(masked.every((t) => t.speaker === 0), 'con máscara no debe cambiar');
  });

  test('sin tomas devuelve las trazas tal cual', () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    const [ma, mb] = maskTraces(a, b, 10, undefined);
    assert.equal(ma, a);
    assert.equal(mb, b);
  });
});
