import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSolos, soloWindows } from '../src/engine/solos.js';

// A 4/4 song at 120 bpm: one beat every 0.5 s, a bar every 2 s.
function beats(bars) {
    const out = [];
    for (let i = 0; i < bars * 4; i++) out.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : -1 });
    return out;
}

// Verse/chorus: the same open power chord every beat (repeated, low).
function chordBars(t0, t1) {
    const chords = [];
    for (let t = t0; t < t1 - 1e-9; t += 0.5) chords.push({ t, notes: [{ s: 0, f: 0 }, { s: 1, f: 2 }, { s: 2, f: 2 }] });
    return chords;
}
// Riff: a repeated low single-note figure, 4 notes per beat.
function riffNotes(t0, t1) {
    const notes = [];
    for (let t = t0; t < t1 - 1e-9; t += 0.125) notes.push({ t, s: 0, f: [0, 3, 5, 3][Math.round(t / 0.125) % 4] });
    return notes;
}
// Solo: fast, high on the neck, every bar different.
function soloNotes(t0, t1) {
    const notes = [];
    let k = 0;
    for (let t = t0; t < t1 - 1e-9; t += 0.125, k++) notes.push({ t, s: 3 + (k % 3), f: 9 + ((k * 7) % 11) });
    return notes;
}

const SECTIONS = [
    { time: 0, name: 'intro' }, { time: 8, name: 'verse' }, { time: 16, name: 'chorus' },
    { time: 24, name: 'interlude' }, { time: 32, name: 'chorus' }, { time: 40, name: 'outro' },
];

function song() {
    const notes = [...riffNotes(0, 8), ...soloNotes(24, 32), ...riffNotes(40, 48)];
    const chords = [...chordBars(8, 24), ...chordBars(32, 40)];
    return { notes, chords, beats: beats(24) };
}

test('detects a fast, unique, up-the-neck single-note section as a solo', () => {
    const s = song();
    const found = detectSolos(s.notes, s.chords, SECTIONS, s.beats);
    assert.deepEqual([...found], [3]);   // "interlude"
});

test('never flags verses, choruses, intros or repeated riffs', () => {
    const s = song();
    const notes = [...s.notes, ...soloNotes(0, 8)];   // a solo-like intro
    const found = detectSolos(notes, s.chords, SECTIONS, s.beats);
    assert.ok(!found.has(0));
    assert.ok(!found.has(1) && !found.has(2) && !found.has(4));
    assert.ok(!found.has(5));   // the outro riff repeats the intro riff
});

test('slow or low sections are not solos', () => {
    const s = song();
    const slow = s.notes.filter((n) => !(n.t >= 24 && n.t < 32)).concat(
        Array.from({ length: 8 }, (_, i) => ({ t: 24 + i, s: 4, f: 12 + i })));
    assert.equal(detectSolos(slow, s.chords, SECTIONS, s.beats).size, 0);
    const low = s.notes.map((n) => (n.t >= 24 && n.t < 32 ? { ...n, f: n.f % 4 } : n));
    assert.equal(detectSolos(low, s.chords, SECTIONS, s.beats).size, 0);
});

test('no beats or sections → nothing detected', () => {
    const s = song();
    assert.equal(detectSolos(s.notes, s.chords, [], s.beats).size, 0);
    assert.equal(detectSolos(s.notes, s.chords, SECTIONS, []).size, 0);
});

test('soloWindows uses auto-detection only when the chart names no solo', () => {
    const s = song();
    const auto = soloWindows(SECTIONS, s.notes, s.chords, s.beats);
    assert.deepEqual(auto, [{ id: 0, name: 'Solo (interlude)', start: 24, end: 32, auto: true }]);
    const named = SECTIONS.map((x) => (x.time === 16 ? { ...x, name: 'Guitar Solo' } : x));
    assert.deepEqual(soloWindows(named, s.notes, s.chords, s.beats),
        [{ id: 0, name: 'Guitar Solo', start: 16, end: 24, auto: false }]);
});

test('adjacent solo sections merge into one window; the last runs to the end', () => {
    const secs = [{ time: 0, name: 'verse' }, { time: 10, name: 'solo' }, { time: 20, name: 'solo' }, { time: 30, name: 'outro' }, { time: 40, name: 'solo 2' }];
    assert.deepEqual(soloWindows(secs, [], [], []), [
        { id: 0, name: 'solo', start: 10, end: 30, auto: false },
        { id: 1, name: 'solo 2', start: 40, end: Infinity, auto: false },
    ]);
});
