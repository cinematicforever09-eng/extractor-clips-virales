import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAssColour,
  rgbaToAssColour,
  getSubtitleStyle,
  SUBTITLE_STYLE_DEFS,
} from '../lib/subtitle-styles.js';

/**
 * ASS colour literals are &HAABBGGRR - alpha, then blue, green, red. Writing
 * that byte order by hand is how "why is my yellow text blue" happens, and it
 * already bit this project once: the magenta accent was hand-written as
 * &H00B674F4 when the correct value is &H00B672F4.
 *
 * The expected values below were verified against real exported frames.
 */
describe('toAssColour', () => {
  const cases: Array<[string, string]> = [
    ['#FACC15', '&H0015CCFA'], // hormozi yellow
    ['#22C55E', '&H005EC522'], // hormozi highlight green
    ['#FFFFFF', '&H00FFFFFF'],
    ['#000000', '&H00000000'],
    ['#67E8F9', '&H00F9E867'], // cyberpunk cyan
    ['#F472B6', '&H00B672F4'], // cyberpunk magenta
    ['#F8FAFC', '&H00FCFAF8'],
    ['#818CF8', '&H00F88C81'],
  ];

  for (const [hex, expected] of cases) {
    test(`${hex} -> ${expected}`, () => {
      assert.equal(toAssColour(hex), expected);
    });
  }

  test('reverses the RGB byte order rather than passing it through', () => {
    // A colour where every channel differs, so a pass-through would be obvious.
    assert.equal(toAssColour('#112233'), '&H00332211');
  });

  test('accepts hex without the leading hash', () => {
    assert.equal(toAssColour('FACC15'), '&H0015CCFA');
  });

  test('encodes alpha, where 0 is opaque', () => {
    assert.equal(toAssColour('#000000', 255), '&HFF000000');
  });
});

describe('rgbaToAssColour', () => {
  test('inverts opacity, because ASS alpha counts transparency', () => {
    // 0.88 opaque -> 12% transparent -> 0x1F
    assert.equal(rgbaToAssColour('rgba(0,0,0,0.88)'), '&H1F000000');
  });

  test('treats a missing alpha as fully opaque', () => {
    assert.equal(rgbaToAssColour('rgb(15,23,42)'), '&H002A170F');
  });

  test('keeps the channel order consistent with toAssColour', () => {
    assert.equal(rgbaToAssColour('rgba(8,14,26,1)'), toAssColour('#080E1A'));
  });

  test('falls back to opaque black on unparseable input', () => {
    assert.equal(rgbaToAssColour('not a colour'), '&H00000000');
  });
});

describe('getSubtitleStyle', () => {
  test('finds every declared style by id', () => {
    for (const def of SUBTITLE_STYLE_DEFS) {
      assert.equal(getSubtitleStyle(def.id).id, def.id);
    }
  });

  test('falls back instead of returning undefined for an unknown id', () => {
    assert.ok(getSubtitleStyle('no-existe').id);
  });
});

describe('style definitions', () => {
  test('every style has a highlight distinct from its base colour', () => {
    // A matching pair makes the word-by-word animation invisible.
    for (const def of SUBTITLE_STYLE_DEFS) {
      assert.notEqual(
        def.base.toUpperCase(),
        def.highlight.toUpperCase(),
        `${def.id} highlights in its own base colour`
      );
    }
  });

  test('sizes and margins stay within a sane fraction of the frame', () => {
    for (const def of SUBTITLE_STYLE_DEFS) {
      assert.ok(def.sizeRatio > 0.02 && def.sizeRatio < 0.15, `${def.id} sizeRatio`);
      assert.ok(def.marginRatio > 0.05 && def.marginRatio < 0.4, `${def.id} marginRatio`);
    }
  });
});
