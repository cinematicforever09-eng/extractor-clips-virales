import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { historyKey, overlapsDelivered } from '../lib/clip-history.js';

describe('historyKey', () => {
  test('the same YouTube video is the same key, whatever the link carries', () => {
    // The user's own link had a timestamp on it; a second upload of the same
    // video without it must still skip the clips already delivered.
    const plain = historyKey('https://www.youtube.com/watch?v=tOSd0RjP578', 3786);
    assert.equal(historyKey('https://www.youtube.com/watch?v=tOSd0RjP578&t=678s', 3786), plain);
    assert.equal(historyKey('https://youtu.be/tOSd0RjP578', 3786), plain);
    assert.equal(plain, 'youtube:tOSd0RjP578');
  });

  test('two different files with the same name are kept apart by duration', () => {
    assert.notEqual(historyKey('video.mp4', 600), historyKey('video.mp4', 1800));
  });
});

describe('overlapsDelivered', () => {
  const delivered = [{ start: 100, end: 130, at: '' }];

  test('a clip that grew a few seconds still counts as the delivered one', () => {
    assert.ok(overlapsDelivered({ start: 98, end: 136 }, delivered));
  });

  test('a clip elsewhere in the video is new', () => {
    assert.ok(!overlapsDelivered({ start: 200, end: 230 }, delivered));
  });

  test('just touching the edge is not a repeat', () => {
    assert.ok(!overlapsDelivered({ start: 125, end: 160 }, delivered));
  });
});
