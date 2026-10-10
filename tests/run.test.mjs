import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJudgment, stringsOf, missReason } from '../src/engine/judgment.js';
import {
    createRun, recordJudgment, sectionList, sectionAt, techFlagsOf, techFlagsFromNames, weakSpots,
    pitchTendency, trackPlayback, isComplete, runPayload, closePass,
} from '../src/engine/run.js';

// notedetect ≥ 1.33 payload (README "Events").
const richChord = {
    note: { s: 0, f: 3 }, time: 12.4, noteTime: 12.345, expectedMidi: 43, detectedMidi: 43, confidence: 0.9,
    hit: false, timingState: 'OK', pitchState: 'OK', timingError: 8, pitchError: 3, chord: true,
    notes: [{ s: 0, f: 3 }, { s: 1, f: 5 }, { s: 2, f: 5 }], hitStrings: 1, totalStrings: 3, score: 0.33,
    key: '12.345_chord', strings: [{ s: 0, f: 3, hit: true, centsError: 2 }, { s: 1, f: 5, hit: false, centsError: null }, { s: 2, f: 5, hit: false, centsError: null }],
    techniques: ['palmMute'], latencyMs: 80, avOffsetMs: -20, detector: 'web-yin', section: 'verse',
    counted: true, points: 0, multiplier: 1, streak: 0, isDefault: true,
};
// A pre-1.33 single-note payload.
const legacySingle = { note: { s: 2, f: 7 }, time: 3.01, noteTime: 3, expectedMidi: 57, detectedMidi: null, confidence: 0, hit: false,
    timingState: null, pitchState: null, timingError: null, pitchError: null, chord: false };

test('normalizes the enriched payload', () => {
    const j = normalizeJudgment(richChord);
    assert.equal(j.key, '12.345_chord');
    assert.equal(j.chord, true);
    assert.equal(j.latencyMs, 80);
    assert.equal(j.section, 'verse');
    assert.deepEqual(j.strings.map((x) => x.hit), [true, false, false]);
    assert.deepEqual(j.techniques, ['palmMute']);
    assert.equal(j.counted, true);
});

test('normalizes a legacy payload with unknowns, not guesses', () => {
    const j = normalizeJudgment(legacySingle);
    assert.equal(j.s, 2);
    assert.equal(j.latencyMs, null);
    assert.equal(j.strings, null);
    assert.equal(j.techniques, null);
    assert.equal(j.section, undefined);
    assert.equal(j.counted, true);
    assert.equal(j.isDefault, true);
    assert.equal(normalizeJudgment({ hit: true }), null);
    assert.equal(normalizeJudgment(null), null);
    assert.equal(normalizeJudgment({ ...legacySingle, counted: false }).counted, false);
    assert.equal(normalizeJudgment({ ...legacySingle, isDefault: false }).isDefault, false);
});

test('per-string verdicts and miss reasons', () => {
    assert.deepEqual(stringsOf(normalizeJudgment(richChord)).map((x) => [x.s, x.hit, x.perString]),
        [[0, true, true], [1, false, true], [2, false, true]]);
    const oldChord = normalizeJudgment({ ...richChord, strings: undefined });
    assert.deepEqual(stringsOf(oldChord).map((x) => x.perString), [false, false, false]);
    assert.equal(missReason(normalizeJudgment(richChord)), 'chord');
    assert.equal(missReason(normalizeJudgment(legacySingle)), 'unheard');
    assert.equal(missReason(normalizeJudgment({ ...legacySingle, detectedMidi: 57, timingState: 'LATE' })), 'late');
    assert.equal(missReason(normalizeJudgment({ ...legacySingle, detectedMidi: 58, timingState: 'OK' })), 'pitch');
    assert.equal(missReason(normalizeJudgment({ ...legacySingle, hit: true })), null);
});

test('technique flags from chart notes and from notedetect names', () => {
    assert.deepEqual(techFlagsOf({ bn: 1, sl: -1, ho: true, sus: 1 }), ['B', 'h', 'SUS']);
    assert.deepEqual(techFlagsOf({ hp: true, pm: true }), ['H', 'PM']);
    assert.deepEqual(techFlagsFromNames(['harmonic', 'pinchHarmonic', 'palmMute', 'vibrato']), ['H', 'PM']);
});

test('section list numbers repeated names and counts notes', () => {
    const list = sectionList(
        [{ time: 0, name: 'verse' }, { time: 10, name: 'chorus' }, { time: 20, name: 'verse' }],
        [{ t: 1 }, { t: 2, mt: true }, { t: 21 }], [{ t: 11 }]);
    assert.deepEqual(list.map((s) => [s.key, s.label, s.notes]), [['0:verse', 'verse 1', 1], ['1:chorus', 'chorus', 1], ['2:verse', 'verse 2', 1]]);
    assert.equal(sectionAt(list, 15).key, '1:chorus');
    assert.equal(sectionAt(list, -1), null);
});

test('a run tallies hits, streaks, strings, techniques and section passes', () => {
    const secs = sectionList([{ time: 0, name: 'intro' }, { time: 10, name: 'verse' }], [], []);
    secs[0].notes = 4;
    const run = createRun({ filename: 'a.sloppak', arrangement: 'Bass' });
    assert.equal(run.bass, true);
    const single = (t, s, hit) => normalizeJudgment({ note: { s, f: 3 }, noteTime: t, hit, chord: false, detectedMidi: hit ? 40 : null, timingError: hit ? 5 : null });
    recordJudgment(run, single(1, 0, true), { flags: ['B'], sections: secs });
    recordJudgment(run, single(2, 0, true), { flags: ['B'], sections: secs });
    recordJudgment(run, single(3, 1, false), { flags: [], sections: secs });
    recordJudgment(run, single(4, 1, true), { flags: [], sections: secs });
    recordJudgment(run, normalizeJudgment(richChord), { flags: ['PM'], sections: secs });
    assert.deepEqual([run.hits, run.misses, run.bestStreak, run.streak], [3, 2, 2, 0]);
    assert.deepEqual(run.strings.slice(0, 3), [[3, 0], [1, 2], [0, 1]]);
    assert.deepEqual(run.tech, { B: [2, 0], PM: [0, 1] });
    assert.deepEqual(run.why, { unheard: 1, early: 0, late: 0, pitch: 0, chord: 1 });
    assert.deepEqual(run.singles, [3, 1]);
    assert.deepEqual(run.chords, [0, 1]);
    // the intro pass closed when the verse started: 3/4 = 75 %
    assert.deepEqual(run.sections, { '0:intro': [75, 4] });
});

test('section passes need full speed and 70 % coverage', () => {
    const secs = sectionList([{ time: 0, name: 'a' }, { time: 10, name: 'b' }], [], []);
    secs[0].notes = 10;
    const run = createRun({});
    const j = (t) => normalizeJudgment({ note: { s: 0 }, noteTime: t, hit: true });
    for (let i = 0; i < 5; i++) recordJudgment(run, j(i), { sections: secs });
    closePass(run);
    assert.deepEqual(run.sections, {});   // 5 of 10 notes
    const slow = createRun({});
    secs[0].notes = 5;
    for (let i = 0; i < 5; i++) recordJudgment(slow, j(i), { sections: secs, fullSpeed: i !== 2 });
    closePass(slow);
    assert.deepEqual(slow.sections, {});
});

test('weak spots and pitch tendency', () => {
    assert.deepEqual(weakSpots({ B: [2, 3], h: [9, 1], S: [1, 1] }, 4, 3).map((x) => [x.k, x.p]), [['B', 40], ['h', 90]]);
    assert.equal(pitchTendency([1, 2, 3]), null);
    assert.deepEqual(pitchTendency([10, 12, 14, 9, 11, 13]), { cents: 12, word: 'sharp' });
    assert.deepEqual(pitchTendency([-1, 2, 3, 0, -2, 1]), { cents: 1, word: 'in tune' });
});

test('completeness: ended or ≥ 92 %, never looped', () => {
    const run = createRun({});
    assert.equal(isComplete(run, 'ended'), true);
    assert.equal(isComplete(run, 'switch'), false);
    trackPlayback(run, { progress: 0.95, speed: 1, looped: false });
    assert.equal(isComplete(run, 'switch'), true);
    trackPlayback(run, { progress: 0.5, speed: 0.75, looped: true });
    assert.equal(run.maxProgress, 0.95);
    assert.equal(run.minSpeed, 0.75);
    assert.equal(isComplete(run, 'ended'), false);
});

test('run payload carries the score and the details', () => {
    const run = createRun({ filename: 'x.sloppak', arrangement: 'Lead', title: 'X', now: 1000 });
    recordJudgment(run, normalizeJudgment({ note: { s: 0 }, noteTime: 1, hit: true }), {});
    const p = runPayload(run, 'ended', { score: 1234, breakdown: {} }, 61000);
    assert.equal(p.complete, true);
    assert.equal(p.speed, 1);
    assert.equal(p.played_s, 60);
    assert.equal(p.score, 1234);
    assert.equal(p.details.score.score, 1234);
    assert.equal(p.hits, 1);
});
