import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWatermarkFilter,
  decodeWatermarkPng,
  normaliseWatermark,
  DEFAULT_WATERMARK_POSITION,
} from '../lib/watermark.js';

// PNG de 1x1 transparente.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('decodeWatermarkPng', () => {
  test('acepta un PNG con o sin el prefijo data:', () => {
    assert.ok(decodeWatermarkPng(PNG_1PX));
    assert.ok(decodeWatermarkPng(PNG_1PX.replace('data:image/png;base64,', '')));
  });

  test('rechaza lo que no es PNG', () => {
    // Un JPEG empieza con FF D8 FF.
    assert.equal(decodeWatermarkPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64')), null);
    assert.equal(decodeWatermarkPng(''), null);
  });
});

describe('normaliseWatermark', () => {
  test('sin imagen válida no hay marca de agua (el clip se exporta igual)', () => {
    assert.equal(normaliseWatermark(undefined), null);
    assert.equal(normaliseWatermark({ image: 'no-es-png', widthRatio: 0.2 }), null);
  });

  test('completa lo que falta con la posición de abajo', () => {
    const wm = normaliseWatermark({ image: PNG_1PX })!;
    assert.equal(wm.x, DEFAULT_WATERMARK_POSITION.x);
    assert.equal(wm.y, DEFAULT_WATERMARK_POSITION.y);
  });

  test('mete en rango los valores raros', () => {
    const wm = normaliseWatermark({ image: PNG_1PX, widthRatio: 3, x: -1, y: 'abc', opacity: 0 })!;
    assert.equal(wm.widthRatio, 0.9);
    assert.equal(wm.x, 0);
    assert.equal(wm.y, DEFAULT_WATERMARK_POSITION.y);
    assert.equal(wm.opacity, 0.05);
  });
});

describe('buildWatermarkFilter', () => {
  const wm = { image: PNG_1PX, widthRatio: 0.25, x: 0.5, y: 0.93, opacity: 0.85 };

  test('escala el logo al porcentaje del ancho del video', () => {
    // 25 % de 1080 = 270.
    assert.match(buildWatermarkFilter('[vout]', 3, 1080, wm), /^\[3:v\]format=rgba,scale=270:-1,/);
  });

  test('aplica la opacidad y lo pone sobre el video ya terminado', () => {
    const filter = buildWatermarkFilter('[vout]', 1, 1080, wm);
    assert.match(filter, /colorchannelmixer=aa=0\.850\[wm\];\[vout\]\[wm\]overlay=/);
    assert.match(filter, /\[vwm\]$/);
  });

  test('el logo nunca se sale del cuadro', () => {
    const filter = buildWatermarkFilter('[vout]', 1, 1080, { ...wm, x: 1, y: 1 });
    assert.match(filter, /x='max\(0,min\(main_w-overlay_w,main_w\*1\.0000-overlay_w\/2\)\)'/);
    assert.match(filter, /y='max\(0,min\(main_h-overlay_h,main_h\*1\.0000-overlay_h\/2\)\)'/);
  });

  test('ancho siempre par', () => {
    assert.match(buildWatermarkFilter('[0:v]', 1, 1080, { ...wm, widthRatio: 0.333 }), /scale=360:-1/);
  });
});
