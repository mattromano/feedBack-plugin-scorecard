import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wantsHud, claimsResults } from '../src/visibility.js';

const base = { onPlayer: true, mode: 'full', isDrums: false, hasRun: true, frozen: false, ndEnabled: true, hudHidden: false };

test('wantsHud matches the old rule and hudHidden wins', () => {
    assert.equal(wantsHud(base), true);
    assert.equal(wantsHud({ ...base, hudHidden: true }), false);
    assert.equal(wantsHud({ ...base, mode: 'off' }), false);
    assert.equal(wantsHud({ ...base, isDrums: true }), false);
});

test('claimsResults needs enough judgments, a mode and no hide', () => {
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'full', hudHidden: false }), true);
    assert.equal(claimsResults({ judged: 4, minJudged: 5, mode: 'full', hudHidden: false }), false);
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'full', hudHidden: true }), false);
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'off', hudHidden: false }), false);
});

test('main.js publishes setHudHidden and guards the end card', () => {
    const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
    assert.ok(src.includes('setHudHidden'));
    assert.ok(src.includes('claimsResults('));
    assert.ok(src.includes('!st.hudHidden'));
});
