import test from 'node:test';
import assert from 'node:assert/strict';
import {
    partKey, isScoredInstrument, normalizePlayer, normalizePlayJudgment, createPlayRun, recordPlay, rewindPlay,
    pickFollow, followable, playMissReason, resultRunPayload, instrumentLabel, missWord,
} from '../src/engine/play.js';

const J = (o) => normalizePlayJudgment({ sessionId: 's1', filename: 'a.sloppak', player: 'drums', instrument: 'drums', part: 'drums',
    input: 'kit', kind: 'hit', points: 25, multiplier: 1, streak: 1, t: 1, noteTime: 1, offsetMs: 0, timing: 'on', local: true, ...o });

test('partKey follows core: drums, five_fret:<part>', () => {
    assert.equal(partKey('drums', 'drums'), 'drums');
    assert.equal(partKey('drums', ''), 'drums');
    assert.equal(partKey('five_fret', 'rhythm'), 'five_fret:rhythm');
    assert.equal(partKey('five_fret', 'five_fret'), 'five_fret');
    assert.equal(partKey('guitar', 'lead'), '');
    assert.equal(partKey('drums', 'Bad Part!'), 'drums');
});

test('only drums and five_fret are scored here (guitar is note detect)', () => {
    assert.equal(isScoredInstrument('drums'), true);
    assert.equal(isScoredInstrument('five_fret'), true);
    assert.equal(isScoredInstrument('guitar'), false);
    assert.equal(isScoredInstrument('vocals'), false);
});

test('normalizePlayJudgment rejects junk and keeps the contract fields', () => {
    assert.equal(normalizePlayJudgment(null), null);
    assert.equal(normalizePlayJudgment({ kind: 'hit' }), null);   // no player
    assert.equal(normalizePlayJudgment({ player: 'drums', instrument: 'drums', kind: 'nope' }), null);
    const j = J({ offsetMs: 12, timing: 'late' });
    assert.equal(j.kind, 'hit');
    assert.equal(j.offsetMs, 12);
    assert.equal(j.timing, 'late');
    assert.equal(J({ offsetMs: null, timing: null }).offsetMs, null);
    assert.equal(J({ local: false }).local, false);
    assert.equal(J({}).local, true);
});

test('recordPlay sums RHS points and takes streak / multiplier from the event', () => {
    const r = createPlayRun({ player: 'drums', instrument: 'drums', part: 'drums' });
    recordPlay(r, J({ points: 25, streak: 1, multiplier: 1 }));
    recordPlay(r, J({ points: 30, streak: 2, multiplier: 1, t: 2 }));
    recordPlay(r, J({ kind: 'sustain', points: 7, streak: 2, multiplier: 1, t: 2.5, offsetMs: null }));
    recordPlay(r, J({ kind: 'bonus', points: 100, streak: 2, t: 3, offsetMs: null }));
    assert.equal(r.score, 162);
    assert.equal(r.hits, 2);
    assert.equal(r.misses, 0);
    assert.equal(r.streak, 2);
    assert.equal(r.bestStreak, 2);
    recordPlay(r, J({ kind: 'miss', points: 0, streak: 0, t: 4, offsetMs: null, timing: null }));
    assert.equal(r.misses, 1);
    assert.equal(r.streak, 0);
    assert.equal(r.bestStreak, 2);
    assert.equal(r.multiplier, 1);
    recordPlay(r, J({ points: 50, streak: 1, multiplier: 2, t: 5 }));
    assert.equal(r.multiplier, 2);
    assert.deepEqual(r.recent, [true, true, false, true]);
});

test('streak falls back to counting when the event has none', () => {
    const r = createPlayRun({});
    recordPlay(r, J({ streak: undefined }));
    recordPlay(r, J({ streak: undefined, t: 2 }));
    assert.equal(r.streak, 2);
    recordPlay(r, J({ kind: 'overhit', streak: undefined, points: 0, t: 3 }));
    assert.equal(r.streak, 0);
});

test('miss reasons: early, late, missed, overhit (no pitch / not heard)', () => {
    assert.equal(playMissReason(J({ kind: 'miss', timing: 'early', offsetMs: -90 })), 'early');
    assert.equal(playMissReason(J({ kind: 'miss', timing: 'late', offsetMs: 90 })), 'late');
    assert.equal(playMissReason(J({ kind: 'miss', timing: null, offsetMs: null })), 'missed');
    assert.equal(playMissReason(J({ kind: 'overhit' })), 'overhit');
    assert.equal(playMissReason(J({ kind: 'hit' })), null);
    const r = createPlayRun({});
    recordPlay(r, J({ kind: 'miss', timing: 'early', offsetMs: -90, streak: 0 }));
    recordPlay(r, J({ kind: 'miss', streak: 0, offsetMs: null, timing: null }));
    recordPlay(r, J({ kind: 'overhit', streak: 0 }));
    assert.deepEqual(r.why, { early: 1, late: 0, missed: 1, overhit: 1 });
    assert.equal(r.overhits, 1);
    assert.equal(r.misses, 2, 'an overhit is not a missed note (accuracy = hits / (hits + misses))');
    assert.equal(missWord('drums'), 'overhits');
    assert.equal(missWord('five_fret'), 'overstrums');
});

test('rewindPlay drops judgments after t and rebuilds the run', () => {
    const r = createPlayRun({});
    for (let i = 1; i <= 30; i++) recordPlay(r, J({ t: i, streak: i, points: 10 }));
    assert.equal(r.bestStreak, 30);
    rewindPlay(r, 10.5);
    assert.equal(r.hits, 10);
    assert.equal(r.score, 100);
    assert.equal(r.streak, 10);
    assert.equal(r.bestStreak, 10);
    assert.equal(r.recent.length, 10);
    recordPlay(r, J({ t: 11, streak: 11, points: 10 }));
    assert.equal(r.score, 110);
});

test('followable / pickFollow: first local non-guitar player, keeps a valid pick', () => {
    const players = [
        { player: 'guitar', instrument: 'guitar', part: 'lead' },
        { player: 'drums', instrument: 'drums', part: 'drums' },
        { player: 'ctl1', instrument: 'five_fret', part: 'bass' },
        { player: 'ctl2', instrument: 'five_fret', part: 'guitar', local: false },
    ].map(normalizePlayer);
    assert.deepEqual(followable(players).map((p) => p.player), ['drums', 'ctl1']);
    assert.equal(pickFollow(players, null), 'drums');
    assert.equal(pickFollow(players, 'ctl1'), 'ctl1');
    assert.equal(pickFollow(players, 'guitar'), 'drums');
    assert.equal(pickFollow(players, 'ctl2'), 'drums');
    assert.equal(pickFollow([normalizePlayer({ player: 'guitar', instrument: 'guitar' })], null), null);
});

test('instrumentLabel names the part and difficulty', () => {
    assert.equal(instrumentLabel({ instrument: 'drums', part: 'drums', difficulty: 'expert' }), 'Drums · Expert');
    assert.equal(instrumentLabel({ instrument: 'five_fret', part: 'bass', difficulty: 'hard' }), '5-Fret Bass · Hard');
    assert.equal(instrumentLabel({ instrument: 'five_fret', part: 'guitar', difficulty: '' }), '5-Fret Guitar');
});

test('resultRunPayload: RHS numbers, part key, difficulty; null for guitar / empty / practice', () => {
    const session = { filename: 'a.sloppak', title: 'T', artist: 'A' };
    const result = { practice: false, durationSec: 200, players: [] };
    const p = { player: 'drums', instrument: 'drums', part: 'drums', difficulty: 'expert', score: 12345, hits: 90, misses: 10,
        overhits: 3, bestStreak: 44, accuracy: 0.9, failed: false, sections: [{ name: 'verse', hits: 9, misses: 1, accuracy: 0.9 }] };
    const run = createPlayRun({});
    recordPlay(run, J({ kind: 'miss', timing: 'late', offsetMs: 80, streak: 0 }));
    const body = resultRunPayload(p, result, session, run);
    assert.equal(body.filename, 'a.sloppak');
    assert.equal(body.arrangement, '');
    assert.equal(body.part, 'drums');
    assert.equal(body.difficulty, 'expert');
    assert.equal(body.hits, 90);
    assert.equal(body.misses, 10);
    assert.equal(body.best_streak, 44);
    assert.equal(body.score, 12345);
    assert.equal(body.complete, true);
    assert.equal(body.speed, 1);
    assert.equal(body.played_s, 200);
    assert.deepEqual(body.details.sections, { '0:verse': [90, 10] });
    assert.equal(body.details.overhits, 3);
    assert.deepEqual(body.details.why, run.why);
    assert.equal(resultRunPayload({ ...p, failed: true }, result, session, null).complete, false);
    assert.equal(resultRunPayload({ ...p, difficulty: 'expert_plus' }, result, session, null).difficulty, 'expert');
    assert.equal(resultRunPayload({ ...p, instrument: 'guitar' }, result, session, null), null);
    assert.equal(resultRunPayload({ ...p, hits: 0, misses: 0 }, result, session, null), null);
    assert.equal(resultRunPayload(p, { ...result, practice: true }, session, null), null);
    assert.equal(resultRunPayload({ ...p, instrument: 'five_fret', part: 'rhythm' }, result, session, null).part, 'five_fret:rhythm');
});
