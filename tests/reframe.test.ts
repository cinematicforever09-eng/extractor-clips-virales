import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cropForRegion, buildReframeFilter, type SpeakerRegion } from '../lib/reframe.js';

const SRC_W = 1920;
const SRC_H = 1080;
const OUT_W = 1080;
const OUT_H = 1920;

const region = (x: number, y: number, w: number, h: number): SpeakerRegion => ({
  x,
  y,
  width: w,
  height: h,
});

describe('cropForRegion', () => {
  test('respeta la proporción pedida', () => {
    const crop = cropForRegion(region(0.4, 0.3, 0.2, 0.3), SRC_W, SRC_H, 9 / 16);
    assert.ok(Math.abs(crop.width / crop.height - 9 / 16) < 0.02);
  });

  test('nunca se sale del fotograma', () => {
    // Un sujeto pegado al borde no debe producir un recorte con x negativa,
    // que FFmpeg rechaza.
    for (const r of [region(0, 0, 0.2, 0.3), region(0.8, 0.7, 0.2, 0.3)]) {
      const crop = cropForRegion(r, SRC_W, SRC_H, 9 / 16);
      assert.ok(crop.x >= 0, 'x negativa');
      assert.ok(crop.y >= 0, 'y negativa');
      assert.ok(crop.x + crop.width <= SRC_W, 'se sale por la derecha');
      assert.ok(crop.y + crop.height <= SRC_H, 'se sale por abajo');
    }
  });

  test('queda centrado en el sujeto cuando hay sitio', () => {
    const crop = cropForRegion(region(0.45, 0.3, 0.1, 0.2), SRC_W, SRC_H, 9 / 16);
    const centre = crop.x + crop.width / 2;
    assert.ok(Math.abs(centre - SRC_W * 0.5) < 40, 'no está centrado en el sujeto');
  });

  test('sigue al sujeto cuando se mueve a un lado', () => {
    const izq = cropForRegion(region(0.1, 0.3, 0.1, 0.2), SRC_W, SRC_H, 9 / 16);
    const der = cropForRegion(region(0.8, 0.3, 0.1, 0.2), SRC_W, SRC_H, 9 / 16);
    assert.ok(der.x > izq.x, 'el recorte debería moverse con el sujeto');
  });

  test('usa dimensiones pares, que es lo que exige H.264', () => {
    const crop = cropForRegion(region(0.33, 0.21, 0.17, 0.29), SRC_W, SRC_H, 9 / 16);
    for (const value of [crop.x, crop.y, crop.width, crop.height]) {
      assert.equal(value % 2, 0, `${value} es impar`);
    }
  });

  test('aprovecha toda la altura disponible al pasar de 16:9 a 9:16', () => {
    // Un 9:16 sacado de un 16:9 es inevitablemente estrecho: con 1080 de alto
    // solo caben 607 de ancho. Lo que sí se puede exigir es que no desperdicie
    // altura, que es donde está toda la información útil.
    const crop = cropForRegion(region(0.3, 0.2, 0.4, 0.5), SRC_W, SRC_H, 9 / 16);
    assert.ok(crop.height >= SRC_H - 2, `solo usó ${crop.height} de ${SRC_H} de alto`);
  });

  test('un sujeto pequeño se amplía con aire alrededor', () => {
    // El recuadro que marca una persona suele ser la cabeza; encuadrar así de
    // justo es incómodo de ver, por eso se añade margen.
    const marked = region(0.45, 0.4, 0.08, 0.12);
    const crop = cropForRegion(marked, SRC_W, SRC_H, 9 / 16);
    assert.ok(crop.height > marked.height * SRC_H, 'no dejó margen alrededor');
  });
});

describe('buildReframeFilter', () => {
  const base = { sourceWidth: SRC_W, sourceHeight: SRC_H, targetWidth: OUT_W, targetHeight: OUT_H };

  test('focus produce un recorte a pantalla completa, sin barras', () => {
    const { filter, appliedMode } = buildReframeFilter({
      ...base,
      mode: 'focus',
      speakers: [region(0.4, 0.2, 0.2, 0.4)],
    });
    assert.equal(appliedMode, 'focus');
    assert.match(filter, /crop=\d+:\d+:\d+:\d+/);
    assert.ok(!filter.includes('pad='), 'focus no debería dejar barras');
    assert.ok(!filter.includes('gblur'), 'focus no debería desenfocar');
  });

  test('split apila dos recortes distintos', () => {
    const { filter } = buildReframeFilter({
      ...base,
      mode: 'split',
      speakers: [region(0.1, 0.3, 0.2, 0.4), region(0.7, 0.3, 0.2, 0.4)],
    });

    assert.match(filter, /vstack=inputs=2/);

    const crops = [...filter.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    assert.equal(crops.length, 2, 'deberían ser dos recortes');
    assert.notEqual(crops[0][3], crops[1][3], 'los dos paneles salen del mismo sitio');
  });

  test('cada panel del split ocupa media altura exacta', () => {
    const { filter } = buildReframeFilter({
      ...base,
      mode: 'split',
      speakers: [region(0.1, 0.3, 0.2, 0.4), region(0.7, 0.3, 0.2, 0.4)],
    });
    // Dos paneles de 960 apilados dan los 1920 de salida.
    assert.equal((filter.match(/scale=1080:960/g) || []).length, 2);
  });

  test('split sin dos personas marcadas no revienta', () => {
    const { filter } = buildReframeFilter({ ...base, mode: 'split', speakers: [] });
    assert.match(filter, /vstack=inputs=2/);
  });

  test('focus sin nadie marcado cae a un recorte central', () => {
    const { filter } = buildReframeFilter({ ...base, mode: 'focus' });
    assert.match(filter, /crop=\d+:\d+:\d+:\d+/);
  });

  test('los modos antiguos siguen igual', () => {
    assert.match(buildReframeFilter({ ...base, mode: 'blur-fill' }).filter, /gblur/);
    assert.match(buildReframeFilter({ ...base, mode: 'fit' }).filter, /pad=/);
    assert.match(buildReframeFilter({ ...base, mode: 'zoom-crop' }).filter, /force_original_aspect_ratio=increase/);
  });

  test('ningún modo deja un recorte fuera del fotograma', () => {
    for (const speakers of [
      [region(0, 0, 0.15, 0.2)],
      [region(0.85, 0.8, 0.15, 0.2)],
      [region(0, 0, 0.15, 0.2), region(0.85, 0.8, 0.15, 0.2)],
    ]) {
      for (const mode of ['focus', 'split'] as const) {
        const { filter } = buildReframeFilter({ ...base, mode, speakers });
        for (const [, w, h, x, y] of filter.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
          assert.ok(Number(x) + Number(w) <= SRC_W, `${mode}: se sale a lo ancho`);
          assert.ok(Number(y) + Number(h) <= SRC_H, `${mode}: se sale a lo alto`);
        }
      }
    }
  });
});

describe('modo gameplay (streamer + juego)', () => {
  const build = (speakers?: SpeakerRegion[]) =>
    buildReframeFilter({
      sourceWidth: SRC_W,
      sourceHeight: SRC_H,
      targetWidth: OUT_W,
      targetHeight: OUT_H,
      mode: 'gameplay',
      speakers,
    });

  test('apila dos paneles con vstack', () => {
    const { filter, appliedMode } = build();
    assert.equal(appliedMode, 'gameplay');
    assert.match(filter, /vstack=inputs=2/);
  });

  const alturasPanel = (filter: string) => ({
    juego: Number(filter.match(/crop=1080:(\d+),gblur/)![1]),
    camara: Number(filter.match(/scale=1080:(\d+)\[cbot\]/)![1]),
  });

  test('los dos paneles suman exactamente la altura de salida', () => {
    const { juego, camara } = alturasPanel(build().filter);
    assert.equal(juego + camara, OUT_H);
  });

  test('el juego se lleva más pantalla que la cámara', () => {
    const { juego, camara } = alturasPanel(build().filter);
    assert.ok(juego > camara, `juego ${juego}, cámara ${camara}`);
  });

  test('el juego se ve entero, no recortado a la forma del panel', () => {
    // El fallo que esto evita: forzar una zona de juego ancha al panel vertical
    // la convertía en una franja estrecha y se perdía el HUD y el minimapa.
    const juego = region(0, 0, 0.6, 0.5);
    const { filter } = build([region(0.8, 0.7, 0.15, 0.2), juego]);

    const recorte = filter.match(/crop=(\d+):(\d+):(\d+):(\d+),scale=1080:\d+:force_original_aspect_ratio=decrease/);
    assert.ok(recorte, filter);
    // Tiene que ser la zona marcada tal cual: 1152x540, no una franja vertical.
    assert.equal(Number(recorte[1]), 1152);
    assert.equal(Number(recorte[2]), 540);
  });

  test('lo que sobra en el panel del juego se rellena con desenfoque, no con barras', () => {
    const { filter } = build();
    assert.match(filter, /gblur=sigma=\d+/);
    assert.match(filter, /overlay=\(W-w\)\/2:\(H-h\)\/2\[gtop\]/);
  });

  test('la primera zona marcada es la cámara, la segunda el juego', () => {
    const camara = region(0.02, 0.02, 0.2, 0.2);
    const juego = region(0.5, 0.5, 0.5, 0.5);
    const { filter } = build([camara, juego]);

    // El panel de la cámara sale del recorte que alimenta [cbot].
    const cam = filter.match(/crop=(\d+):(\d+):(\d+):(\d+),scale=1080:\d+\[cbot\]/);
    assert.ok(cam, filter);
    assert.ok(Number(cam[3]) < SRC_W / 2, `la cámara salió en x=${cam[3]}`);

    // Y el del juego, del que va a [gfg].
    const game = filter.match(/crop=(\d+):(\d+):(\d+):(\d+),scale=1080:\d+:force_original_aspect_ratio=decrease/);
    assert.ok(Number(game![3]) >= SRC_W / 2, `el juego salió en x=${game![3]}`);
  });

  test('sin marcar nada sigue produciendo un grafo válido', () => {
    const { filter } = build();
    for (const [, w, h, x, y] of filter.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
      assert.ok(Number(x) + Number(w) <= SRC_W, `recorte fuera por ancho: ${x}+${w}`);
      assert.ok(Number(y) + Number(h) <= SRC_H, `recorte fuera por alto: ${y}+${h}`);
    }
  });

  test('todos los recortes caben dentro del fotograma original', () => {
    const { filter } = build([region(0.8, 0.7, 0.18, 0.28), region(0, 0, 1, 1)]);
    for (const [, w, h, x, y] of filter.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
      assert.ok(Number(x) >= 0 && Number(y) >= 0);
      assert.ok(Number(x) + Number(w) <= SRC_W);
      assert.ok(Number(y) + Number(h) <= SRC_H);
    }
  });
});

describe('gameplay: la cámara se recorta ceñida', () => {
  test('el recorte de la cámara no se traga el juego de alrededor', () => {
    // Webcam de 620x480 sobre 1920x1080. Con el relleno por defecto (1.6) el
    // recorte salía de 1137x768 y arrastraba medio juego detrás de la cara.
    const { filter } = buildReframeFilter({
      sourceWidth: SRC_W,
      sourceHeight: SRC_H,
      targetWidth: OUT_W,
      targetHeight: OUT_H,
      mode: 'gameplay',
      speakers: [region(0.615, 0.5, 0.323, 0.444), region(0, 0, 1, 1)],
    });

    const cam = filter.match(/crop=(\d+):(\d+):\d+:\d+,scale=1080:\d+\[cbot\]/)!;
    assert.ok(Number(cam[1]) < 900, `ancho del recorte de cámara: ${cam[1]}`);
  });
});
