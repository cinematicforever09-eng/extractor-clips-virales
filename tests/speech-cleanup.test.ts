import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, buildCleanupFilter } from '../lib/speech-cleanup.js';
import type { TranscriptWord } from '../lib/whisper.js';

/** Palabras seguidas, con una duración fija cada una. */
function speak(text: string, from: number, each = 0.3): TranscriptWord[] {
  return text.split(/\s+/).filter(Boolean).map((word, i) => ({
    text: word,
    start: Math.round((from + i * each) * 100) / 100,
    end: Math.round((from + (i + 1) * each) * 100) / 100,
  }));
}

describe('planCleanup', () => {
  test('recorta un silencio largo en medio', () => {
    const words = [...speak('hola que tal', 0), ...speak('seguimos hablando ahora', 6)];
    const { segments, removedSeconds } = planCleanup(words, 0, 8);

    assert.equal(segments.length, 2, 'debería partir en dos por el silencio');
    assert.ok(removedSeconds > 4, `solo quitó ${removedSeconds}s de silencio`);
  });

  test('no parte nada cuando se habla seguido', () => {
    const { segments } = planCleanup(speak('una frase dicha del tirón sin pausas', 0), 0, 2.1);
    assert.equal(segments.length, 1);
  });

  test('quita muletillas claras', () => {
    const words = [
      ...speak('entonces', 0),
      ...speak('eh', 0.3),
      ...speak('te lo explico', 0.6),
    ];
    const { words: kept, removedFillers } = planCleanup(words, 0, 2);

    assert.equal(removedFillers, 1);
    assert.ok(!kept.some((w) => w.text === 'eh'), 'la muletilla sigue ahí');
  });

  test('conserva palabras que solo a veces son muletilla', () => {
    // "este coche" es un demostrativo, no una duda: cortarlo rompe la frase.
    const words = speak('este coche es rapido', 0);
    const { words: kept } = planCleanup(words, 0, 1.5);
    assert.ok(kept.some((w) => w.text === 'este'), 'cortó un demostrativo');
  });

  test('respeta que no se quieran quitar muletillas', () => {
    const words = [...speak('entonces', 0), ...speak('eh', 0.3), ...speak('vale', 0.6)];
    const { removedFillers } = planCleanup(words, 0, 1.2, { removeFillers: false });
    assert.equal(removedFillers, 0);
  });

  test('recoloca los tiempos de las palabras sobre el clip ya recortado', () => {
    const words = [...speak('hola que tal', 0), ...speak('seguimos', 6)];
    const { words: kept } = planCleanup(words, 0, 7);

    const ultima = kept[kept.length - 1];
    // Sin recolocar, "seguimos" seguiría en el segundo 6 y el subtítulo
    // aparecería después de que el clip haya terminado.
    assert.ok(ultima.start < 2.5, `quedó en ${ultima.start}s, sin recolocar`);
  });

  test('los segmentos no se salen del clip ni se solapan', () => {
    const words = [...speak('uno dos', 1), ...speak('tres cuatro', 5), ...speak('cinco', 9)];
    const { segments } = planCleanup(words, 1, 10);

    for (const s of segments) {
      assert.ok(s.start >= 1 && s.end <= 10, 'segmento fuera del clip');
      assert.ok(s.end > s.start, 'segmento vacío');
    }
    for (let i = 1; i < segments.length; i++) {
      assert.ok(segments[i].start >= segments[i - 1].end, 'segmentos solapados');
    }
  });

  test('un clip sin voz no produce nada que cortar', () => {
    const { segments, words } = planCleanup([], 0, 10);
    assert.deepEqual(segments, []);
    assert.deepEqual(words, []);
  });

  test('ignora las palabras de fuera de la ventana del clip', () => {
    const words = [...speak('antes', 0), ...speak('dentro', 5), ...speak('despues', 20)];
    const { words: kept } = planCleanup(words, 4, 8);
    assert.ok(kept.every((w) => w.text === 'dentro'), 'coló texto de fuera');
  });
});

describe('buildCleanupFilter', () => {
  test('no genera filtro cuando no hay nada que cortar', () => {
    assert.equal(buildCleanupFilter([{ start: 0, end: 10 }], true), null);
  });

  test('encadena los trozos conservados con audio', () => {
    const built = buildCleanupFilter(
      [
        { start: 0, end: 2 },
        { start: 6, end: 9 },
      ],
      true
    );

    assert.ok(built);
    assert.match(built!.filter, /concat=n=2:v=1:a=1/);
    // Ojo: /trim=start=/ también casa dentro de "atrim=start=".
    assert.equal((built!.filter.match(/\[0:v\]trim=start=/g) || []).length, 2);
    assert.equal((built!.filter.match(/atrim=start=/g) || []).length, 2);
    assert.equal(built!.audioLabel, '[cleana]');
  });

  test('funciona en un video mudo', () => {
    const built = buildCleanupFilter(
      [
        { start: 0, end: 2 },
        { start: 6, end: 9 },
      ],
      false
    );

    assert.ok(built);
    assert.match(built!.filter, /concat=n=2:v=1:a=0/);
    assert.ok(!built!.filter.includes('atrim'), 'generó audio donde no lo hay');
    assert.equal(built!.audioLabel, null);
  });
});
