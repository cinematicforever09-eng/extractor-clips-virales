import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideFraming } from '../lib/live.js';
import {
  looksLikeWebcam,
  pickWebcam,
  persistentEdges,
  ANALYSIS_WIDTH,
  ANALYSIS_HEIGHT,
} from '../lib/webcam-box.js';

const WEBCAM = { x: 0, y: 0.122, width: 0.236, height: 0.274 };

describe('decideFraming', () => {
  test('webcam encima del juego en un canal de Gaming: streamer + juego, ya marcada', () => {
    const d = decideFraming({ categories: ['Gaming'] }, WEBCAM);
    assert.equal(d.mode, 'gameplay');
    assert.deepEqual(d.speakers, [WEBCAM]);
    assert.equal(d.kind.kind, 'videojuego');
  });

  test('webcam y sin categoría (Twitch, Kick): se confía en la webcam', () => {
    assert.equal(decideFraming({}, WEBCAM).mode, 'gameplay');
  });

  test('canal de Gaming sin webcam: el juego completo', () => {
    const d = decideFraming({ categories: ['Gaming'] }, null);
    assert.equal(d.mode, 'blur-fill');
    assert.equal(d.kind.kind, 'videojuego-sin-camara');
  });

  test('noticias con un recuadro en la esquina: es gente, no una webcam de juego', () => {
    const d = decideFraming({ categories: ['News & Politics'] }, WEBCAM);
    assert.equal(d.mode, 'focus');
    assert.equal(d.kind.kind, 'gente');
  });

  test('sin webcam ni categoría: gente hablando', () => {
    assert.equal(decideFraming({}, null).mode, 'focus');
  });
});

describe('looksLikeWebcam', () => {
  const W = 960;
  const H = 540;
  test('la webcam de Rubius sí', () => {
    assert.ok(looksLikeWebcam({ x: 0, y: 66, width: 227, height: 148 }, W, H));
  });
  test('el panel izquierdo de la entrevista de DW (medido: 333x456 en 960x540) no', () => {
    assert.ok(!looksLikeWebcam({ x: 67, y: 35, width: 333, height: 456 }, W, H));
  });
  test('un panel de entrevista (un tercio del cuadro) no', () => {
    assert.ok(!looksLikeWebcam({ x: 0, y: 0, width: 320, height: 540 }, W, H));
  });
  test('una barra de rótulo de noticias (muy ancha) no', () => {
    assert.ok(!looksLikeWebcam({ x: 0, y: 440, width: 400, height: 60 }, W, H));
  });
  test('un recuadro en el centro no: es el contenido', () => {
    assert.ok(!looksLikeWebcam({ x: 380, y: 200, width: 200, height: 140 }, W, H));
  });
});

describe('pickWebcam con imágenes sintéticas', () => {
  /**
   * Un "juego" que cambia de color en cada cuadro y encima una webcam fija
   * con su borde: lo único que se mantiene entre cuadros es el marco.
   */
  function frames(withCam: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let f = 0; f < 9; f++) {
      const frame = new Uint8Array(ANALYSIS_WIDTH * ANALYSIS_HEIGHT).fill(30 + f * 20);
      if (withCam) {
        for (let y = 66; y < 214; y++) {
          for (let x = 0; x < 227; x++) frame[y * ANALYSIS_WIDTH + x] = 200;
        }
      }
      out.push(frame);
    }
    return out;
  }

  test('encuentra la webcam sin clic', () => {
    const { gx, gy } = persistentEdges(frames(true), ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    const box = pickWebcam(gx, gy, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    assert.ok(box, 'no la encontró');
    assert.ok(Math.abs(box!.x - 0) < 0.01, `x ${box!.x}`);
    assert.ok(Math.abs(box!.y - 66 / 540) < 0.01, `y ${box!.y}`);
    assert.ok(Math.abs(box!.width - 227 / 960) < 0.01, `ancho ${box!.width}`);
    assert.ok(Math.abs(box!.height - 148 / 540) < 0.01, `alto ${box!.height}`);
  });

  test('sin webcam no inventa una', () => {
    const { gx, gy } = persistentEdges(frames(false), ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    assert.equal(pickWebcam(gx, gy, ANALYSIS_WIDTH, ANALYSIS_HEIGHT), null);
  });
});
