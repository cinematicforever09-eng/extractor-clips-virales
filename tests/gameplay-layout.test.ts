import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReframeFilter,
  normaliseGameplayLayout,
  gameplayPanels,
  cropInsideRegion,
  DEFAULT_GAMEPLAY_LAYOUT,
} from '../lib/reframe.js';
import { regionCrop } from '../lib/shots.js';

const base = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  targetWidth: 1080,
  targetHeight: 1920,
  mode: 'gameplay' as const,
  // La cámara de Rubius en el stream de prueba: arriba a la izquierda.
  speakers: [{ x: 0, y: 0.122, width: 0.237, height: 0.273 }],
};

describe('diseño Streamer + juego', () => {
  test('por defecto: juego arriba, cámara abajo, panel con la forma de la webcam', () => {
    const { filter } = buildReframeFilter(base);
    assert.equal(DEFAULT_GAMEPLAY_LAYOUT.camPosition, 'bottom');
    assert.equal(DEFAULT_GAMEPLAY_LAYOUT.fitCam, true);
    assert.match(filter, /\[gtop\]\[cbot\]vstack=inputs=2$/);
    // Webcam de 455x295 a 1080 de ancho -> 700 de alto; el juego, el resto.
    assert.match(filter, /scale=1080:698\[cbot\]/);
    assert.match(filter, /scale=1080:1222:force_original_aspect_ratio=increase/);
  });

  test('ajustada: el recorte de la cámara es el recuadro entero, sin juego alrededor', () => {
    const { filter } = buildReframeFilter(base);
    const crop = /\[c\]crop=(\d+):(\d+):(\d+):(\d+)/.exec(filter)!.slice(1).map(Number);
    const [w, h, x, y] = crop;
    // El recuadro marcado: x 0-455, y 132-427 en 1920x1080.
    assert.ok(x >= 0 && x + w <= 456, `se sale a los lados: ${crop}`);
    assert.ok(y >= 130 && y + h <= 428, `se sale arriba/abajo: ${crop}`);
    assert.ok(w >= 450 && h >= 290, `recorta de más: ${crop}`);
  });

  test('con tamaño fijo la cámara se recorta por dentro, nunca crece hacia el juego', () => {
    for (const camShare of [0.3, 0.38, 0.5]) {
      const { filter } = buildReframeFilter({
        ...base,
        gameplayLayout: { camPosition: 'bottom', camShare, fitCam: false },
      });
      const [w, h, x, y] = /\[c\]crop=(\d+):(\d+):(\d+):(\d+)/.exec(filter)!.slice(1).map(Number);
      assert.ok(x + w <= 456 && y >= 130 && y + h <= 428, `camShare ${camShare}: ${w}x${h}+${x}+${y}`);
    }
  });

  test('cámara arriba invierte el orden de los paneles', () => {
    const { filter } = buildReframeFilter({
      ...base,
      gameplayLayout: { camPosition: 'top', camShare: 0.38, fitCam: false },
    });
    assert.match(filter, /\[cbot\]\[gtop\]vstack=inputs=2$/);
  });

  test('mitad y mitad da dos paneles de 960', () => {
    const { filter } = buildReframeFilter({
      ...base,
      gameplayLayout: { camPosition: 'bottom', camShare: 0.5, fitCam: false },
    });
    assert.match(filter, /scale=1080:960\[cbot\]/);
    assert.match(filter, /scale=1080:960:force_original_aspect_ratio=decrease/);
  });

  test('las alturas siempre suman la pantalla completa', () => {
    for (const camShare of [0.25, 0.3, 0.38, 0.5]) {
      const { filter } = buildReframeFilter({
        ...base,
        gameplayLayout: { camPosition: 'top', camShare, fitCam: false },
      });
      const cam = Number(/scale=1080:(\d+)\[cbot\]/.exec(filter)![1]);
      const game = Number(/scale=1080:(\d+):force_original_aspect_ratio=decrease/.exec(filter)![1]);
      assert.equal(cam + game, 1920, `camShare ${camShare}`);
    }
  });

  test('valores raros del cliente se corrigen', () => {
    assert.deepEqual(normaliseGameplayLayout(undefined), DEFAULT_GAMEPLAY_LAYOUT);
    assert.deepEqual(normaliseGameplayLayout({ camPosition: 'izquierda', camShare: 0.9 }), {
      camPosition: 'bottom',
      camShare: 0.5,
      fitCam: true,
    });
    assert.equal(normaliseGameplayLayout({ fitCam: false }).fitCam, false);
    assert.equal(normaliseGameplayLayout({ camShare: 0.05 }).camShare, 0.25);
    assert.equal(normaliseGameplayLayout({ camShare: 'abc' }).camShare, DEFAULT_GAMEPLAY_LAYOUT.camShare);
  });

  test('cuando la cámara no está, ese tramo va en plano completo', () => {
    const { filter } = buildReframeFilter({
      ...base,
      fallbackRanges: [{ start: 12, end: 30 }],
    });
    assert.match(filter, /^\[0:v\]split=2\[rf_in\]\[bf_in\];\[rf_in\]split=3/);
    assert.match(filter, /overlay=0:0:enable='between\(t,12\.000,30\.000\)'$/);
  });
});

describe('regionCrop', () => {
  test('recorta la zona marcada en unidades del cuadro', () => {
    assert.equal(
      regionCrop({ x: 0, y: 0.122, width: 0.237, height: 0.273 }),
      'crop=iw*0.2370:ih*0.2730:iw*0.0000:ih*0.1220'
    );
  });

  test('una zona que se sale del cuadro se mete dentro', () => {
    assert.equal(
      regionCrop({ x: 0.9, y: -0.1, width: 0.3, height: 0.3 }),
      'crop=iw*0.3000:ih*0.3000:iw*0.7000:ih*0.0000'
    );
  });
});

describe('gameplayPanels', () => {
  test('una webcam muy ancha no deja el panel por debajo de un cuarto', () => {
    const panels = gameplayPanels(
      { camPosition: 'bottom', camShare: 0.38, fitCam: true },
      { x: 0, y: 0, width: 0.6, height: 0.1 },
      1920,
      1080,
      1080,
      1920
    );
    assert.equal(panels.camHeight, 480);
    assert.equal(panels.camHeight + panels.gameHeight, 1920);
  });

  test('sin webcam marcada usa el tamaño elegido', () => {
    const panels = gameplayPanels(
      { camPosition: 'bottom', camShare: 0.5, fitCam: true },
      undefined,
      1920,
      1080,
      1080,
      1920
    );
    assert.equal(panels.camHeight, 960);
  });
});

describe('cropInsideRegion', () => {
  test('mantiene la forma pedida y queda centrado dentro del recuadro', () => {
    const crop = cropInsideRegion({ x: 0, y: 0.122, width: 0.237, height: 0.273 }, 1920, 1080, 1080 / 960);
    assert.ok(Math.abs(crop.width / crop.height - 1080 / 960) < 0.02);
    assert.ok(crop.x >= 0 && crop.x + crop.width <= 456);
    assert.ok(crop.y >= 130 && crop.y + crop.height <= 428);
  });
});

describe('subtítulos en Streamer + juego', async () => {
  const { gameplayCaptionAnchor } = await import('../lib/ffmpeg.js');
  const request = {
    framingMode: 'gameplay' as const,
    speakers: [{ x: 0, y: 0.122, width: 0.237, height: 0.273 }],
    sourceWidth: 1920,
    sourceHeight: 1080,
  };
  const size = { width: 1080, height: 1920 };

  test('van en la unión entre el juego y la cámara', () => {
    const anchor = gameplayCaptionAnchor(request, size)!;
    // Juego de 1222 arriba: la unión está en 1222/1920.
    assert.equal(anchor.x, 0.5);
    assert.ok(Math.abs(anchor.y - 1222 / 1920) < 0.001, String(anchor.y));
  });

  test('con la cámara arriba, la unión está al final de la cámara', () => {
    const anchor = gameplayCaptionAnchor(
      { ...request, gameplayLayout: { camPosition: 'top', camShare: 0.38, fitCam: true } },
      size
    )!;
    assert.ok(Math.abs(anchor.y - 698 / 1920) < 0.001, String(anchor.y));
  });

  test('si el usuario arrastró el subtítulo, se respeta', () => {
    assert.equal(
      gameplayCaptionAnchor({ ...request, subtitleOverrides: { anchor: { x: 0.3, y: 0.2 } } }, size),
      null
    );
  });

  test('en otros encuadres no se toca', () => {
    assert.equal(gameplayCaptionAnchor({ ...request, framingMode: 'focus' }, size), null);
  });
});
