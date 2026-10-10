import test from 'node:test';
import assert from 'node:assert/strict';
import {
    multiplierFor, pipsFor, timingFactor, chartTechniques, scoringTechniques, speedDifficultyFactor,
    denseNoteTimes, soloRating, soloBonus, createScoreEngine, BASE_POINTS,
} from '../src/engine/score.js';

const hit = (t, extra) => ({ hit: true, chord: false, noteTime: t, timingError: 0, ...extra });
const miss = (t) => ({ hit: false, chord: false, noteTime: t, timingError: null });

test('multiplier steps every 10 notes and caps at ×4', () => {
    assert.equal(multiplierFor(0), 1);
    assert.equal(multiplierFor(9), 1);
    assert.equal(multiplierFor(10), 2);
    assert.equal(multiplierFor(29), 3);
    assert.equal(multiplierFor(30), 4);
    assert.equal(multiplierFor(500), 4);
    assert.equal(multiplierFor(-5), 1);
    assert.equal(multiplierFor(NaN), 1);
});

test('pips show progress to the next step, all lit at ×4', () => {
    assert.equal(pipsFor(0), 0);
    assert.equal(pipsFor(7), 7);
    assert.equal(pipsFor(13), 3);
    assert.equal(pipsFor(30), 10);
    assert.equal(pipsFor(77), 10);
});

test('timing factor: ≤25 ms ×1, ≤50 ms ×0.8, else ×0.6, unknown ×0.8', () => {
    assert.equal(timingFactor(0), 1);
    assert.equal(timingFactor(-25), 1);
    assert.equal(timingFactor(26), 0.8);
    assert.equal(timingFactor(-50), 0.8);
    assert.equal(timingFactor(51), 0.6);
    assert.equal(timingFactor(null), 0.8);
    assert.equal(timingFactor(undefined), 0.8);
});

test('chart techniques read the wire format', () => {
    assert.deepEqual(chartTechniques({ bn: 1 }), ['bend']);
    assert.deepEqual(chartTechniques({ sl: -1, slu: -1 }), []);
    assert.deepEqual(chartTechniques({ sl: 7 }), ['slide']);
    assert.deepEqual(chartTechniques({ slu: 0 }), ['slide']);
    assert.deepEqual(chartTechniques({ hm: true }), ['harmonic']);
    assert.deepEqual(chartTechniques({ hm: true, hp: true }), ['pinchHarmonic']);
    assert.deepEqual(chartTechniques(null), []);
    assert.deepEqual(scoringTechniques(['harmonic', 'pinchHarmonic', 'hammerOn']), ['pinchHarmonic']);
});

test('speed × difficulty factor caps each part at 1', () => {
    assert.equal(speedDifficultyFactor(1, 1), 1);
    assert.equal(speedDifficultyFactor(0.5, 1), 0.5);
    assert.equal(speedDifficultyFactor(1.5, 0.8), 0.8);
    assert.equal(speedDifficultyFactor(undefined, NaN), 1);
});

test('a hit single note is 50 × multiplier × timing', () => {
    const e = createScoreEngine();
    e.judge(hit(1, { timingError: 10 }));
    assert.equal(e.snapshot().score, BASE_POINTS);
    e.judge(hit(2, { timingError: 40 }));
    assert.equal(e.snapshot().score, 50 + 40);
    const b = e.snapshot().breakdown;
    assert.equal(b.base, 100);
    assert.equal(b.timing, -10);
});

test('chords score 50 per string that rang', () => {
    const e = createScoreEngine();
    e.judge({ hit: true, chord: true, noteTime: 1, timingError: 0, hitStrings: 3, totalStrings: 4 });
    assert.equal(e.snapshot().score, 150);
});

test('streak multiplier applies from the 11th note; a miss resets it and scores nothing', () => {
    const e = createScoreEngine();
    for (let i = 0; i < 10; i++) e.judge(hit(i));
    assert.equal(e.snapshot().score, 500);
    e.judge(hit(10));
    assert.equal(e.snapshot().score, 600);   // ×2
    assert.equal(e.snapshot().multiplier, 2);
    e.judge(miss(11));
    assert.equal(e.snapshot().score, 600);
    assert.equal(e.snapshot().streak, 0);
    assert.equal(e.snapshot().multiplier, 1);
    e.judge(hit(12));
    assert.equal(e.snapshot().score, 650);
    assert.equal(e.snapshot().bestStreak, 11);
});

test('technique bonuses: +25 % bend/slide, +100 % harmonic, +200 % pinch', () => {
    const e = createScoreEngine();
    let ev = e.judge(hit(1), { techniques: ['bend'] });
    assert.equal(e.snapshot().score, 63);   // 62.5, rounded for display
    assert.equal(ev[0].type, 'technique');
    e.reset();
    e.judge(hit(1), { techniques: ['harmonic'] });
    assert.equal(e.snapshot().score, 100);
    e.reset();
    ev = e.judge(hit(1), { techniques: ['pinchHarmonic'] });
    assert.equal(e.snapshot().score, 150);
    assert.ok(ev.some((x) => x.type === 'pinch'));
    assert.deepEqual(e.snapshot().techniques, { pinchHarmonic: 1 });
    e.reset();
    e.judge(hit(1), { techniques: ['bend', 'slide'] });
    assert.equal(e.snapshot().score, 75);
});

test('speed/difficulty factor scales every point', () => {
    const e = createScoreEngine();
    e.judge(hit(1), { factor: 0.5 });
    assert.equal(e.snapshot().score, 25);
});

test('dense passages: ×1.5 and a technical run report after 8+ notes', () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({ t: 10 + i * 0.1 }));
    const dense = denseNoteTimes(notes);
    assert.equal(dense.size, 10);
    assert.ok(!denseNoteTimes([{ t: 1 }, { t: 2 }, { t: 3 }]).size);
    const e = createScoreEngine();
    e.setChart({ dense, solos: [] });
    let now = 0;
    for (const n of notes) { e.judge(hit(n.t), { now }); now += 100; }
    assert.equal(e.snapshot().score, 10 * 75);   // first 10 notes are ×1
    assert.equal(e.snapshot().breakdown.technical, 250);
    assert.ok(e.snapshot().inRun);
    assert.deepEqual(e.closeRun(now + 100, false), []);   // still settling
    const ev = e.closeRun(now + 2000, false);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].h, ev[0].n, ev[0].perfect], [10, 10, true]);
    assert.equal(e.snapshot().runs.length, 1);
});

test('short dense bursts do not report a run', () => {
    const e = createScoreEngine();
    const notes = Array.from({ length: 6 }, (_, i) => ({ t: 1 + i * 0.1 }));
    e.setChart({ dense: denseNoteTimes(notes), solos: [] });
    for (const n of notes) e.judge(hit(n.t));
    assert.deepEqual(e.closeRun(5000, true), []);
});

test('solo bonus: 100 per hit, doubled when perfect, with a rating', () => {
    assert.equal(soloBonus(9, 10), 900);
    assert.equal(soloBonus(10, 10), 2000);
    assert.equal(soloBonus(10, 10, 0.5), 1000);
    assert.equal(soloRating(100, true), 'PERFECT SOLO!');
    assert.equal(soloRating(96, false), 'AWESOME SOLO!');
    assert.equal(soloRating(91, false), 'GREAT SOLO!');
    assert.equal(soloRating(85, false), 'GOOD SOLO!');
    assert.equal(soloRating(75, false), 'SOLID SOLO');
    assert.equal(soloRating(65, false), 'OKAY SOLO');
    assert.equal(soloRating(10, false), 'MESSY SOLO');
});

test('solos close once the playhead leaves them, once', () => {
    const e = createScoreEngine();
    e.setChart({ dense: new Set(), solos: [{ id: 0, name: 'Solo', start: 10, end: 20 }] });
    e.judge(hit(11)); e.judge(hit(12)); e.judge(miss(13)); e.judge(hit(14));
    assert.deepEqual(e.soloProgress(0), { h: 3, n: 4, done: false });
    assert.equal(e.soloAt(15).name, 'Solo');
    assert.equal(e.soloAt(25), null);
    assert.deepEqual(e.closeSolos(20.5), []);   // grace for late verdicts
    const ev = e.closeSolos(21.5);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].rating, 'SOLID SOLO');
    assert.equal(ev[0].bonus, 300);
    assert.deepEqual(e.closeSolos(30), []);
    assert.equal(e.snapshot().breakdown.solo, 300);
    e.judge(hit(15));   // a late verdict after close doesn't reopen it
    assert.equal(e.soloProgress(0).n, 4);
});

test('closeSolos({ all }) closes an unfinished solo at song end', () => {
    const e = createScoreEngine();
    e.setChart({ dense: new Set(), solos: [{ id: 0, name: 'Outro solo', start: 10, end: Infinity }] });
    e.judge(hit(11)); e.judge(hit(12));
    const ev = e.closeSolos(15, 1, { all: true });
    assert.equal(ev[0].rating, 'PERFECT SOLO!');
    assert.equal(ev[0].bonus, 400);
});
