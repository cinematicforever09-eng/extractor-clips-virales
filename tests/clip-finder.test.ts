import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSentences,
  endsOnDanglingWord,
  findClipCandidates,
  needsContinuation,
  normalizeScore,
} from '../lib/clip-finder.js';
import { groupWordsIntoLines, type TranscriptWord } from '../lib/whisper.js';

describe('endsOnDanglingWord', () => {
  // Every case below is a real clip ending from an hour of Colombian
  // television. Whisper's full stops and pauses could not tell these apart;
  // the last word can.
  test('flags endings that leave the sentence open', () => {
    for (const text of [
      '...menores de edad. Y',
      '¿Será que alguien me ayuda a poner mi',
      'lo que está pasando en el',
      'la gente dice que aún, que aún es.',
      'Imagínate los 25 así cacharrados. No,',
    ]) {
      assert.ok(endsOnDanglingWord(text), `"${text}" debería contar como a medias`);
    }
  });

  test('a question is not an ending: its answer is the payoff', () => {
    // 8 of 20 clips from an hour of street interviews ended like this, with
    // the answer immediately after the cut.
    for (const text of ['gana de su voz ¿cómo es su nombre?', 'o lo usaron solo para acá?']) {
      assert.ok(needsContinuation(text), `"${text}" deja la respuesta fuera`);
    }
    assert.ok(!needsContinuation('Eso sí es una película de terror.'));
  });

  test('accepts endings that close the thought', () => {
    for (const text of [
      '¿Será que alguien me ayuda a poner mi peluca?',
      'están investigando quién los mató.',
      'Eso sí es una película de terror.',
      'estoy ganando más puteando que haciendo box news.',
    ]) {
      assert.ok(!endsOnDanglingWord(text), `"${text}" debería contar como cerrada`);
    }
  });
});

/** Builds a word stream at a steady pace, so tests can reason about timings. */
function speak(text: string, startAt = 0, secondsPerWord = 0.35): TranscriptWord[] {
  return text.split(/\s+/).filter(Boolean).map((word, index) => ({
    text: word,
    start: Math.round((startAt + index * secondsPerWord) * 100) / 100,
    end: Math.round((startAt + (index + 1) * secondsPerWord) * 100) / 100,
  }));
}

describe('buildSentences', () => {
  test('splits on terminal punctuation', () => {
    const sentences = buildSentences(speak('Primera frase. Segunda frase.'));
    assert.equal(sentences.length, 2);
  });

  test('splits on a long pause even without punctuation', () => {
    const words = [...speak('antes de la pausa'), ...speak('después de la pausa', 5)];
    assert.equal(buildSentences(words).length, 2);
  });

  test('scores an audience reaction above plain speech', () => {
    const [reaction] = buildSentences(speak('(risas) qué bueno eso.'));
    const [plain] = buildSentences(speak('entonces seguimos con lo otro.'));
    assert.ok(reaction.score > plain.score, 'una risa debería puntuar más');
    assert.ok(reaction.reasons.some((r) => r.includes('reacción')));
  });

  test('scores questions and hook phrases', () => {
    const [question] = buildSentences(speak('¿Y sabes qué pasó entonces?'));
    assert.ok(question.reasons.includes('pregunta'));

    const [hook] = buildSentences(speak('Esto nadie te lo cuenta jamás.'));
    assert.ok(hook.reasons.some((r) => r.includes('gancho')));
  });

  test('penalises very short fragments', () => {
    const [fragment] = buildSentences(speak('Ya.'));
    assert.ok(fragment.score < 0, 'un fragmento suelto no debería ser candidato');
  });

  test('penalises a crawl and rewards a fast delivery', () => {
    const [slow] = buildSentences(speak('palabra tras palabra muy lenta', 0, 1.2));
    const [fast] = buildSentences(speak('palabra tras palabra muy rápida', 0, 0.2));
    assert.ok(fast.score > slow.score);
  });
});

/**
 * Lays sentences back to back with a natural breath between them.
 *
 * The fixture this replaces put 7.2 s of silence between every remark and
 * described itself as "a minute of speech". That is the exact shape a clip now
 * has to reject - two short remarks either side of a hole - so the sparse case
 * has its own test below, and this one is continuous speech as it always
 * claimed to be. Measured on real whisper output, continuous Spanish speech
 * never exceeded a 0.74 s gap between words.
 *
 * The gap is 0.6 s because each line here is a separate remark, and a clip
 * may only open where the speaker actually paused - at 0.4 s these read as
 * one unbroken run of speech, which is not what the fixture is describing.
 */
function conversation(lines: string[], startAt = 0, gap = 0.6): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = startAt;

  for (const line of lines) {
    const spoken = speak(line, cursor);
    words.push(...spoken);
    cursor = spoken[spoken.length - 1].end + gap;
  }

  return words;
}

describe('findClipCandidates', () => {
  // Continuous speech with several clearly marked moments in it.
  const transcript: TranscriptWord[] = conversation([
    'bueno entonces vamos a empezar con esto tranquilamente.',
    '¿Y sabes qué fue lo peor de todo aquello?',
    'resulta que nadie te cuenta esa parte nunca.',
    'seguimos hablando de cosas sin mayor interés aquí.',
    'te voy a contar cómo terminó todo aquel asunto.',
    '(risas) no puedo creer que dijera eso en directo.',
    'y la clave estaba en algo que nadie había mirado.',
    'por eso insisto tanto cada vez que sale este tema.',
    'y con eso cerramos por hoy, muchas gracias a todos.',
  ]);

  const total = transcript[transcript.length - 1].end + 1;

  test('finds candidates around the marked moments', () => {
    const candidates = findClipCandidates(transcript, { totalDuration: total, minDuration: 10 });
    assert.ok(candidates.length > 0);
  });

  test('every clip is mostly someone talking', () => {
    // The defect this guards: a window used to be measured as the span from
    // its first word to its last, so a clip could be 94 % silence and still
    // be returned. Reported from a six-hour stream as "clips where nobody
    // speaks" and "the subtitles were missing" - one defect, not two, because
    // there were no words to caption.
    for (const candidate of findClipCandidates(transcript, {
      totalDuration: total,
      minDuration: 10,
    })) {
      const inside = transcript.filter(
        (w) => w.end > candidate.startSeconds && w.start < candidate.endSeconds
      );

      let voiced = 0;
      let cursor = candidate.startSeconds;
      for (const word of inside) {
        const from = Math.max(word.start, cursor);
        if (word.end > from) {
          voiced += Math.min(word.end, candidate.endSeconds) - from;
          cursor = word.end;
        }
      }

      const span = candidate.endSeconds - candidate.startSeconds;
      assert.ok(
        voiced / span >= 0.6,
        `${candidate.startSeconds}s-${candidate.endSeconds}s solo tiene ${Math.round(
          (voiced / span) * 100
        )}% de voz`
      );
    }
  });

  test('refuses to build a clip across a long silence', () => {
    // Two remarks 25 s apart, which is what an idle stretch of a stream looks
    // like. Joining them would be a 26-second clip with 1.5 s of speech in it.
    const sparse = [
      ...speak('tienes que verlo, esto es lo que nadie cuenta.', 3000),
      ...speak('siempre pasa igual con todos estos temas.', 3025),
    ];

    for (const candidate of findClipCandidates(sparse, { totalDuration: 21600, minDuration: 15 })) {
      const span = candidate.endSeconds - candidate.startSeconds;
      assert.ok(span < 20, `clip de ${span}s abarca el silencio entre las dos frases`);
    }
  });

  test('does not promote a stretch of music as if it were a reaction', () => {
    // "[Música]" was in the audience-reaction pattern, scoring +30 - the
    // highest single signal here - so background music promoted exactly the
    // passages where nobody is talking.
    const [music] = buildSentences(speak('[Música]'));
    const [plain] = buildSentences(speak('entonces seguimos con lo otro tranquilamente.'));
    assert.ok(music.score < plain.score, 'la música no debería puntuar más que el habla');
    assert.ok(music.score < 0, 'la música no debería poder iniciar un clip');
  });

  test('discards what whisper invents over silence', () => {
    // Verified on this machine: given 30 s of digital silence between two bits
    // of speech, the turbo model wrote "Tiene cosas chismas." over it. Three
    // invented words were enough to seed a clip.
    for (const invented of [
      'Subtítulos realizados por la comunidad de Amara.org',
      'Gracias por ver el video, no olvides suscribirte al canal',
    ]) {
      const [sentence] = buildSentences(speak(invented));
      assert.ok(sentence.score < 0, `"${invented}" no debería poder iniciar un clip`);
    }
  });

  test('starts and ends on a sentence boundary', () => {
    // A clip that opens mid-phrase reads as broken however good the moment is.
    const sentences = buildSentences(transcript);
    const starts = new Set(sentences.map((s) => Math.round(s.start * 10) / 10));
    const ends = new Set(sentences.map((s) => Math.round(s.end * 10) / 10));

    for (const candidate of findClipCandidates(transcript, { totalDuration: 65, minDuration: 10 })) {
      assert.ok(starts.has(candidate.startSeconds), `inicio ${candidate.startSeconds} no es frase`);
      assert.ok(ends.has(candidate.endSeconds), `fin ${candidate.endSeconds} no es frase`);
    }
  });

  test('respects the maximum duration', () => {
    for (const candidate of findClipCandidates(transcript, {
      totalDuration: 65,
      minDuration: 10,
      maxDuration: 25,
    })) {
      assert.ok(candidate.endSeconds - candidate.startSeconds <= 25);
    }
  });

  test('never returns more clips than asked for', () => {
    const candidates = findClipCandidates(transcript, { totalDuration: 65, maxClips: 2, minDuration: 8 });
    assert.ok(candidates.length <= 2);
  });

  test('returns them in chronological order', () => {
    const candidates = findClipCandidates(transcript, { totalDuration: 65, minDuration: 10 });
    for (let i = 1; i < candidates.length; i++) {
      assert.ok(candidates[i].startSeconds >= candidates[i - 1].startSeconds);
    }
  });

  test('does not return heavily overlapping windows', () => {
    const candidates = findClipCandidates(transcript, { totalDuration: 65, minDuration: 10 });

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        const overlap =
          Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds);
        const shorter = Math.min(
          a.endSeconds - a.startSeconds,
          b.endSeconds - b.startSeconds
        );
        assert.ok(overlap <= shorter * 0.5, 'dos clips se solapan demasiado');
      }
    }
  });

  test('returns nothing for silence rather than inventing a clip', () => {
    assert.deepEqual(findClipCandidates([], { totalDuration: 60 }), []);
  });
});

describe('normalizeScore', () => {
  test('stays inside the band the UI expects', () => {
    for (const raw of [0, 1, 50, 200]) {
      const score = normalizeScore(raw, 200);
      assert.ok(score >= 60 && score <= 95, `${score} fuera de rango`);
    }
  });

  test('caps below the high nineties, since these are signals not judgement', () => {
    assert.ok(normalizeScore(1000, 1000) < 96);
  });

  test('survives a zero maximum', () => {
    assert.ok(Number.isFinite(normalizeScore(0, 0)));
  });
});

describe('groupWordsIntoLines', () => {
  test('keeps lines within the word limit', () => {
    for (const line of groupWordsIntoLines(speak('una dos tres cuatro cinco seis siete ocho'), 5)) {
      assert.ok(line.words.length <= 5);
    }
  });

  test('keeps every word, in order', () => {
    const words = speak('una dos tres cuatro cinco seis siete');
    const flattened = groupWordsIntoLines(words).flatMap((l) => l.words.map((w) => w.text));
    assert.deepEqual(flattened, words.map((w) => w.text));
  });

  test('breaks on a pause', () => {
    const words = [...speak('antes de la pausa'), ...speak('después', 9)];
    const lines = groupWordsIntoLines(words, 10, 0.6);
    assert.ok(lines.length >= 2, 'una pausa larga debería cortar la línea');
  });

  test('line bounds match its first and last word', () => {
    for (const line of groupWordsIntoLines(speak('una dos tres cuatro cinco seis'))) {
      assert.equal(line.start, line.words[0].start);
      assert.equal(line.end, line.words[line.words.length - 1].end);
    }
  });
});
