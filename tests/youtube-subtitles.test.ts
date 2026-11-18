import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeIdFrom, normalizeUrl, looksLikeUrl } from '../lib/media.js';
import { normalizeSubtitleTimings, extractSubtitlesFromTranscript } from '../lib/subtitles.js';

describe('youtubeIdFrom', () => {
  const ID = 'dQw4w9WgXcQ';

  const accepted: Array<[string, string]> = [
    ['watch', `https://www.youtube.com/watch?v=${ID}`],
    ['watch sin www', `https://youtube.com/watch?v=${ID}`],
    ['youtu.be', `https://youtu.be/${ID}`],
    ['shorts', `https://www.youtube.com/shorts/${ID}`],
    ['embed', `https://www.youtube.com/embed/${ID}`],
    ['live', `https://www.youtube.com/live/${ID}`],
    ['nocookie', `https://www.youtube-nocookie.com/embed/${ID}`],
    ['con timestamp', `https://www.youtube.com/watch?v=${ID}&t=42s`],
    ['con lista', `https://www.youtube.com/watch?v=${ID}&list=PLabc`],
    ['sin protocolo', `youtube.com/watch?v=${ID}`],
    ['id suelto', ID],
    ['con espacios', `  https://youtu.be/${ID}  `],
    ['entre comillas', `"https://youtu.be/${ID}"`],
    ['entre angulares', `<https://youtu.be/${ID}>`],
  ];

  for (const [name, url] of accepted) {
    test(`acepta ${name}`, () => {
      assert.equal(youtubeIdFrom(normalizeUrl(url)), ID);
    });
  }

  test('reconoce enlaces que no son de YouTube como enlaces válidos', () => {
    // Antes la app los rechazaba de plano; ahora van a yt-dlp, que sí los maneja.
    for (const url of [
      'https://kick.com/xqc/videos/abc-123',
      'https://www.twitch.tv/videos/123456',
      'https://vimeo.com/123456789',
    ]) {
      assert.ok(looksLikeUrl(url), `${url} debería parecer un enlace`);
      assert.equal(youtubeIdFrom(normalizeUrl(url)), null, 'no es de YouTube');
    }
  });

  const rejected: Array<[string, string]> = [
    ['vacío', ''],
    ['otro dominio', 'https://vimeo.com/123456789'],
    ['id demasiado corto', 'https://youtu.be/abc'],
  ];

  for (const [name, url] of rejected) {
    test(`rechaza ${name}`, () => {
      assert.equal(youtubeIdFrom(normalizeUrl(url)), null);
    });
  }
});

describe('normalizeSubtitleTimings', () => {
  test('orders lines by start time', () => {
    const lines = normalizeSubtitleTimings(
      [
        { text: 'segunda', startTime: 2, endTime: 3 },
        { text: 'primera', startTime: 0, endTime: 1 },
      ],
      5
    );
    assert.deepEqual(lines.map((l) => l.text), ['primera', 'segunda']);
  });

  test('snaps a near-zero start to zero so the hook lands on frame one', () => {
    const [first] = normalizeSubtitleTimings([{ text: 'gancho', startTime: 0.3, endTime: 2 }], 5);
    assert.equal(first.startTime, 0);
  });

  test('leaves a deliberate late start alone', () => {
    const [first] = normalizeSubtitleTimings([{ text: 'tardío', startTime: 3, endTime: 4 }], 8);
    assert.equal(first.startTime, 3);
  });

  test('resolves overlapping lines instead of stacking them', () => {
    const lines = normalizeSubtitleTimings(
      [
        { text: 'una', startTime: 0, endTime: 3 },
        { text: 'dos', startTime: 1, endTime: 4 },
      ],
      5
    );
    assert.ok(lines[0].endTime <= lines[1].startTime + 0.1);
  });

  test('never runs past the clip', () => {
    for (const line of normalizeSubtitleTimings([{ text: 'larga', startTime: 0, endTime: 30 }], 5)) {
      assert.ok(line.endTime <= 5);
    }
  });

  test('fixes an inverted line rather than dropping it', () => {
    const lines = normalizeSubtitleTimings([{ text: 'invertida', startTime: 2, endTime: 1 }], 8);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endTime > lines[0].startTime);
  });

  test('drops blank text', () => {
    assert.deepEqual(normalizeSubtitleTimings([{ text: '   ', startTime: 0, endTime: 2 }], 5), []);
  });

  test('falls back to the quote, and never invents filler', () => {
    const lines = normalizeSubtitleTimings([], 10, { soundBiteQuote: 'una frase real' });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'una frase real');
  });

  test('returns nothing when there is nothing real to show', () => {
    assert.deepEqual(normalizeSubtitleTimings([], 10), []);
  });
});

describe('extractSubtitlesFromTranscript', () => {
  const transcript = [
    { text: 'primera parte del discurso', start: 0, duration: 3 },
    { text: 'segunda parte que queda dentro de la ventana', start: 3, duration: 4 },
    { text: 'tercera parte ya fuera', start: 20, duration: 3 },
  ];

  test('keeps only what overlaps the window', () => {
    const lines = extractSubtitlesFromTranscript(transcript, 0, 7);
    assert.ok(lines.length > 0);
    assert.ok(!lines.some((l) => l.text.includes('tercera')));
  });

  test('rebases times onto the clip start', () => {
    const lines = extractSubtitlesFromTranscript(transcript, 3, 7);
    assert.ok(lines[0].startTime < 1, 'el primer subtítulo debería arrancar cerca de 0');
  });

  test('splits a long chunk into readable bursts', () => {
    const lines = extractSubtitlesFromTranscript(transcript, 3, 7);
    for (const line of lines) {
      assert.ok(line.text.split(/\s+/).length <= 6, `demasiado largo: "${line.text}"`);
    }
  });

  test('returns nothing for a window with no speech', () => {
    assert.deepEqual(extractSubtitlesFromTranscript(transcript, 50, 60), []);
  });

  test('survives an empty transcript', () => {
    assert.deepEqual(extractSubtitlesFromTranscript([], 0, 10), []);
  });
});
