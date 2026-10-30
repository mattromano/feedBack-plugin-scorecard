import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../assets/scorecard.css', import.meta.url), 'utf8');

test('a drums / 5-fret solo hides the streak box and score: the lane HUD shows them', () => {
    assert.match(css, /\.sc-root\[data-play-solo\] \.sc-streak,\s*\.sc-root\[data-play-solo\] \.sc-score \{ display: none; \}/);
});
