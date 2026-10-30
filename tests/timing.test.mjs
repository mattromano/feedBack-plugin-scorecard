import test from 'node:test';
import assert from 'node:assert/strict';
import {
    median, classifyTiming, gaugePos, latencySuggestion, avSuggestion, createTimingGauge, MIN_N, EAR_N, WINDOW_N,
} from '../src/engine/timing.js';

const j = (te, hit = true, ts = 'OK') => ({ hit, timingError: te, timingState: ts });

test('median', () => {
    assert.equal(median([]), null);
    assert.equal(median([3]), 3);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('timing classification has a ±12 ms dead zone', () => {
    assert.equal(classifyTiming(0), 'ontime');
    assert.equal(classifyTiming(11), 'ontime');
    assert.equal(classifyTiming(-11.9), 'ontime');
    assert.equal(classifyTiming(12), 'late');
    assert.equal(classifyTiming(-30), 'early');
    assert.equal(classifyTiming(null), null);
    assert.equal(classifyTiming(NaN), null);
});

test('gauge position clamps to ±150 ms', () => {
    assert.equal(gaugePos(0), 0.5);
    assert.equal(gaugePos(150), 1);
    assert.equal(gaugePos(-300), 0);
    assert.equal(gaugePos(75), 0.75);
});

test('latency suggestion moves the offset by the median, clamped to 0–250', () => {
    assert.deepEqual(latencySuggestion(80, 5), { ok: true, value: 80 });
    assert.deepEqual(latencySuggestion(80, 30), { ok: false, value: 110, atLimit: false, raise: true, changes: true });
    assert.deepEqual(latencySuggestion(20, -40), { ok: false, value: 0, atLimit: true, raise: false, changes: true });
    assert.deepEqual(latencySuggestion(240, 40), { ok: false, value: 250, atLimit: true, raise: true, changes: true });
    assert.equal(latencySuggestion(null, 30), null);
});

test('A/V suggestion cancels the ear-vs-eye difference', () => {
    assert.deepEqual(avSuggestion(0, 10), { ok: true, delta: 10 });
    assert.deepEqual(avSuggestion(-20, 40), { ok: false, delta: 40, value: -60, raise: false });
    assert.deepEqual(avSuggestion(0, -30), { ok: false, delta: -30, value: 30, raise: true });
    assert.equal(avSuggestion(0, NaN), null);
});

test('samples are latency-independent: changing latency re-centres the gauge', () => {
    const g = createTimingGauge();
    for (let i = 0; i < MIN_N; i++) g.push(j(30), { latencyMs: 80, avMs: 0 });
    let s = g.summary({ latencyMs: 80, avMs: 0 });
    assert.equal(s.median, 30);
    assert.equal(s.cls, 'late');
    assert.equal(s.latency.value, 110);
    s = g.summary({ latencyMs: 110, avMs: 0 });   // after Apply
    assert.equal(s.median, 0);
    assert.equal(s.cls, 'ontime');
    assert.equal(s.latency.ok, true);
});

test('no suggestion before MIN_N samples or without a known latency', () => {
    const g = createTimingGauge();
    for (let i = 0; i < MIN_N - 1; i++) g.push(j(30), { latencyMs: 80, avMs: 0 });
    assert.equal(g.summary({ latencyMs: 80, avMs: 0 }).latency, null);
    g.push(j(30), { latencyMs: null, avMs: 0 });
    assert.equal(g.summary({ latencyMs: null, avMs: 0 }).latency, null);
});

test('the window keeps the last WINDOW_N samples; judgments without timing are ignored', () => {
    const g = createTimingGauge();
    for (let i = 0; i < WINDOW_N + 10; i++) g.push(j(i), { latencyMs: 0 });
    g.push(j(null, false, null), { latencyMs: 0 });
    const s = g.summary({ latencyMs: 0 });
    assert.equal(s.samples, WINDOW_N);
    assert.equal(s.errors[0], 10);
});

test('an A/V offset change discards the old samples', () => {
    const g = createTimingGauge();
    for (let i = 0; i < MIN_N; i++) g.push(j(20), { latencyMs: 0, avMs: 0 });
    assert.equal(g.summary({ latencyMs: 0, avMs: 0 }).samples, MIN_N);
    assert.equal(g.summary({ latencyMs: 0, avMs: 25 }).samples, 0);
});

test('A/V check: by-ear hits against the by-eye median', () => {
    const g = createTimingGauge();
    assert.equal(g.startCheck(), false);
    for (let i = 0; i < MIN_N; i++) g.push(j(10), { latencyMs: 50, avMs: 0 });
    assert.equal(g.summary({ latencyMs: 50, avMs: 0 }).canCheck, true);
    assert.equal(g.startCheck(), true);
    let s = g.summary({ latencyMs: 50, avMs: 0 });
    assert.equal(s.byEar, true);
    assert.equal(s.check.progress, 0);
    g.push(j(200, false, 'LATE'), { latencyMs: 50, avMs: 0 });   // misses don't count
    for (let i = 0; i < EAR_N; i++) g.push(j(50), { latencyMs: 50, avMs: 0 });
    s = g.summary({ latencyMs: 50, avMs: 0 });
    assert.equal(s.byEar, false);
    assert.deepEqual(s.check.result, { ok: false, delta: 40, value: -40, raise: false });
    g.cancelCheck();
    assert.equal(g.summary({ latencyMs: 50, avMs: 0 }).check, null);
});

test('last EARLY/LATE miss is shown for 1.5 s', () => {
    const g = createTimingGauge();
    g.push(j(-90, false, 'EARLY'), { latencyMs: 0, now: 1000 });
    assert.deepEqual(g.lastMiss(1500), { ms: -90, age: 500 });
    assert.equal(g.lastMiss(2600), null);
    g.reset();
    assert.equal(g.lastMiss(1001), null);
});

test('latencySuggestion takes an instrument range (drums ±250, 5-fret ±200)', () => {
    assert.deepEqual(latencySuggestion(0, -40, { min: -250, max: 250 }),
        { ok: false, value: -40, atLimit: false, raise: false, changes: true });
    assert.equal(latencySuggestion(-190, -40, { min: -200, max: 200 }).value, -200);
    assert.equal(latencySuggestion(-190, -40, { min: -200, max: 200 }).atLimit, true);
    assert.equal(latencySuggestion(10, -40).value, 0, 'default range is Note Detection\'s 0–250');
});

test('a gauge with a range suggests negative offsets', () => {
    const g = createTimingGauge({ min: -250, max: 250 });
    for (let i = 0; i < 8; i++) g.push({ hit: true, timingError: -30 }, { latencyMs: 0 });
    const s = g.summary({ latencyMs: 0 });
    assert.equal(s.latency.value, -30);
    assert.equal(s.latency.raise, false);
});

test('latencySuggestion rounds to the range step (5-fret: 5 ms)', () => {
    assert.equal(latencySuggestion(0, 22, { min: -200, max: 200, step: 5 }).value, 20);
    assert.equal(latencySuggestion(0, 23, { min: -200, max: 200, step: 5 }).value, 25);
});
