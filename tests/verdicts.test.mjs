import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJudgment } from '../src/engine/judgment.js';
import {
    verdictKey, createVerdictStore, composeProvider, HIT_S, MISS_HOLD_S, PARTIAL_S, HIT_COLOR, PARTIAL_COLOR,
} from '../src/engine/verdicts.js';

const single = (t, s, hit) => normalizeJudgment({ note: { s, f: 5 }, noteTime: t, hit, chord: false });
const chord = (t, per) => normalizeJudgment({ note: { s: 0 }, noteTime: t, hit: per.every(Boolean), chord: true,
    notes: per.map((_, s) => ({ s, f: 2 })), strings: per.map((h, s) => ({ s, f: 2, hit: h })) });

test('verdict keys are per chart time (ms) and string', () => {
    assert.equal(verdictKey(1.2344, 2), verdictKey(1.2341, 2));
    assert.notEqual(verdictKey(1.234, 2), verdictKey(1.234, 3));
    assert.notEqual(verdictKey(1.234, 2), verdictKey(1.236, 2));
});

test('a hit flashes white and fades over HIT_S', () => {
    const v = createVerdictStore();
    v.record(single(10, 1, true), 10.02);
    const at = (now) => v.stateFor({ s: 1 }, 10, now);
    assert.deepEqual(at(10.02), { state: 'hit', alpha: 1, color: HIT_COLOR });
    assert.ok(Math.abs(at(10.02 + HIT_S / 2).alpha - 0.5) < 1e-9);
    assert.equal(at(10.02 + HIT_S + 1e-6), null);
    assert.equal(v.stateFor({ s: 2 }, 10, 10.1), null);
});

test('a miss stays marked until it is well past the line', () => {
    const v = createVerdictStore();
    v.record(single(10, 0, false), 10.3);
    assert.deepEqual(v.stateFor({ s: 0 }, 10, 10.3), { state: 'miss', alpha: 1 });
    assert.deepEqual(v.stateFor({ s: 0 }, 10, 10 + MISS_HOLD_S - 0.01), { state: 'miss', alpha: 1 });
    assert.equal(v.stateFor({ s: 0 }, 10, 10 + MISS_HOLD_S), null);
});

test('a partly played chord: rung strings amber, dead strings missed', () => {
    const v = createVerdictStore();
    v.record(chord(5, [true, false, true]), 5);
    assert.deepEqual(v.stateFor({ s: 0 }, 5, 5), { state: 'hit', alpha: 1, color: PARTIAL_COLOR });
    assert.deepEqual(v.stateFor({ s: 1 }, 5, 5), { state: 'miss', alpha: 1 });
    assert.ok(v.stateFor({ s: 2 }, 5, 5 + PARTIAL_S - 0.1));
    v.record(chord(6, [true, true]), 6);
    assert.equal(v.stateFor({ s: 1 }, 6, 6).color, HIT_COLOR);
    v.record(chord(7, [false, false]), 7);
    assert.equal(v.stateFor({ s: 0 }, 7, 7).state, 'miss');
});

test('older notedetect: lenient chord hit with dead strings is partial', () => {
    const v = createVerdictStore();
    v.record(normalizeJudgment({ note: { s: 0 }, noteTime: 3, hit: true, chord: true, notes: [{ s: 0 }, { s: 1 }], hitStrings: 1, totalStrings: 2 }), 3);
    assert.equal(v.stateFor({ s: 1 }, 3, 3).color, PARTIAL_COLOR);
});

test('prune drops verdicts far from the playhead', () => {
    const v = createVerdictStore();
    v.record(single(1, 0, true), 1);
    v.record(single(20, 0, true), 20);
    v.prune(20);
    assert.equal(v.size, 1);
});

test('composed provider keeps the previous provider\'s sustain glow', () => {
    const v = createVerdictStore();
    let now = 10;
    let enabled = true;
    const prev = (note) => (note.s === 0 ? { state: 'active', alpha: 0.7 } : note.s === 3 ? 'hit' : null);
    const p = composeProvider(v, { getPrev: () => prev, getNow: () => now, isEnabled: () => enabled });
    v.record(single(10, 0, true), 10);
    v.record(single(10, 1, false), 10);
    assert.deepEqual(p({ s: 0 }, 10), { state: 'active', alpha: 0.7 });
    assert.deepEqual(p({ s: 1 }, 10), { state: 'miss', alpha: 1 });
    assert.equal(p({ s: 3 }, 10), 'hit');   // no verdict of ours → previous answer
    assert.equal(p({ s: 4 }, 10), null);
    enabled = false;
    assert.equal(p({ s: 1 }, 10), null);
    now = 30;
    enabled = true;
    const lone = composeProvider(v, { getPrev: () => null, getNow: () => now, isEnabled: () => true });
    assert.equal(lone({ s: 1 }, 10), null);
    const throwing = composeProvider(v, { getPrev: () => () => { throw new Error('x'); }, getNow: () => 10, isEnabled: () => true });
    assert.deepEqual(throwing({ s: 1 }, 10), { state: 'miss', alpha: 1 });
});
