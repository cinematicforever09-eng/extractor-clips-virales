import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSegmentList,
  segmentsCovering,
  safeFileName,
  wordsForRound,
  strictnessThresholds,
  LOOKBACK_SECONDS,
  type Segment,
} from '../lib/live.js';

describe('parseSegmentList', () => {
  test('lee la lista que escribe FFmpeg (archivo, inicio, fin)', () => {
    // Formato real, visto grabando un directo de prueba.
    const csv = 'r1-00000.ts,0.000000,60.016000\nr1-00001.ts,0.000000,59.983000\n';
    assert.deepEqual(parseSegmentList(csv), [
      { file: 'r1-00000.ts', duration: 60.016 },
      { file: 'r1-00001.ts', duration: 59.983 },
    ]);
  });

  test('ignora una última línea a medio escribir', () => {
    assert.equal(parseSegmentList('r1-00000.ts,0,60\nr1-00001.ts,0').length, 1);
  });
});

describe('segmentsCovering', () => {
  const segs: Segment[] = [
    { file: 'a.ts', start: 0, end: 60 },
    { file: 'b.ts', start: 60, end: 120 },
    { file: 'c.ts', start: 120, end: 180 },
  ];

  test('un clip dentro de un pedazo usa solo ese', () => {
    assert.deepEqual(segmentsCovering(segs, 10, 40).map((s) => s.file), ['a.ts']);
  });

  test('un clip que cruza el minuto usa los dos pedazos', () => {
    assert.deepEqual(segmentsCovering(segs, 50, 95).map((s) => s.file), ['a.ts', 'b.ts']);
  });
});

describe('safeFileName', () => {
  test('quita lo que Windows no acepta en un nombre', () => {
    assert.equal(safeFileName('¿Qué pasó? "Increíble": 10/10'), '¿Qué pasó Increíble 1010');
  });

  test('quita los emoji de los títulos de directo', () => {
    assert.equal(safeFileName('🔴 DW Español | En vivo'), 'DW Español En vivo');
  });

  test('sin texto usable usa el nombre de respaldo', () => {
    assert.equal(safeFileName('???', 'clip'), 'clip');
  });
});

describe('wordsForRound', () => {
  test('mira solo los últimos minutos y nada de lo que aún no se transcribió', () => {
    const words = [
      { text: 'viejo', start: 10, end: 11 },
      { text: 'reciente', start: 900, end: 901 },
      { text: 'futuro', start: 1300, end: 1301 },
    ];
    const round = wordsForRound(words, 1000);
    assert.deepEqual(round.map((w) => w.text), ['reciente']);
    assert.ok(1000 - LOOKBACK_SECONDS > 11);
  });
});

describe('strictnessThresholds', () => {
  test('más exigente pide más nota y mejor gancho', () => {
    const alta = strictnessThresholds('alta');
    const media = strictnessThresholds('media');
    const baja = strictnessThresholds('baja');
    assert.ok(alta.minScore > media.minScore && media.minScore > baja.minScore);
    assert.ok(alta.minHook > media.minHook && media.minHook > baja.minHook);
    // Medido antes: el relleno sacaba 15-25. Ni el nivel bajo deja pasar eso.
    assert.ok(baja.minScore > 25);
  });
});
