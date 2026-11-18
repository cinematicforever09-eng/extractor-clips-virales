import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoudnormOutput, buildLoudnormFilter, TARGET_LUFS } from '../lib/loudness.js';
import { cacheKeyString } from '../lib/transcript-cache.js';

// Salida real de FFmpeg 9 sobre 20 s del programa de prueba.
const REAL_OUTPUT = `[Parsed_loudnorm_0 @ 000001]
{
	"input_i" : "-13.93",
	"input_tp" : "-0.52",
	"input_lra" : "8.20",
	"input_thresh" : "-24.04",
	"output_i" : "-13.29",
	"output_tp" : "-1.50",
	"output_lra" : "3.90",
	"output_thresh" : "-23.29",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.71"
}`;

describe('parseLoudnormOutput', () => {
  test('lee la medición de la primera pasada', () => {
    assert.deepEqual(parseLoudnormOutput(REAL_OUTPUT), {
      inputI: -13.93,
      inputTp: -0.52,
      inputLra: 8.2,
      inputThresh: -24.04,
      targetOffset: -0.71,
    });
  });

  test('un clip en silencio (-inf) no se normaliza', () => {
    const silent = REAL_OUTPUT.replace('"-13.93"', '"-inf"');
    assert.equal(parseLoudnormOutput(silent), null);
  });

  test('sin bloque JSON devuelve null', () => {
    assert.equal(parseLoudnormOutput('Output file does not contain any stream'), null);
  });
});

describe('buildLoudnormFilter', () => {
  test('segunda pasada lineal hacia -14 LUFS con los valores medidos', () => {
    const filter = buildLoudnormFilter(parseLoudnormOutput(REAL_OUTPUT)!);
    assert.equal(TARGET_LUFS, -14);
    assert.match(filter, /^loudnorm=I=-14:TP=-1\.5:LRA=11/);
    assert.match(filter, /measured_I=-13\.93/);
    assert.match(filter, /offset=-0\.71/);
    assert.match(filter, /linear=true$/);
  });
});

describe('cacheKeyString', () => {
  test('el idioma pedido y el modelo separan las transcripciones', () => {
    const base = { source: 'youtube:radyt5m9QqU', language: 'auto', model: 'ggml-large-v3-turbo.bin' };
    const keys = new Set([
      cacheKeyString(base),
      cacheKeyString({ ...base, language: 'es' }),
      cacheKeyString({ ...base, model: 'ggml-small.bin' }),
    ]);
    assert.equal(keys.size, 3);
  });

  test('idioma vacío cuenta como auto', () => {
    const base = { source: 'x', language: '', model: 'm' };
    assert.equal(cacheKeyString(base), cacheKeyString({ ...base, language: 'auto' }));
  });
});
