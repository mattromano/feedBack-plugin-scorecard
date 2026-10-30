// Drums and 5-fret input: RockHeroSmith's play:* events (play layer contract §3).
//
// RockHeroSmith scores drums (MIDI kit or controller) and 5-fret controllers
// and publishes every ledger entry as play:judgment on the core bus. For these
// instruments the scorecard shows RockHeroSmith's numbers (points, streak,
// multiplier) instead of running its own guitar scoring engine. Real guitar
// stays on Note Detection: play:* for instrument 'guitar' is ignored.
//
// Per player it keeps one run: hits, misses, overhits, score, streak, the
// last-50 form and why notes were missed (early / late / missed / overhit).
// Every judgment is kept, so a play:rewind (backward seek, loop wrap) can drop
// the ones after the rewind point and rebuild the run.
//
// Pure: no DOM, no globals.

export const INSTRUMENTS = Object.freeze(['drums', 'five_fret']);
export const KINDS = Object.freeze(['hit', 'miss', 'overhit', 'sustain', 'bonus', 'deploy', 'phrase']);
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'expert']);
export const RECENT_N = 50;

const SLUG = /^[a-z][a-z0-9_]{0,23}$/;
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' ? v : '');

export const isScoredInstrument = (instrument) => INSTRUMENTS.includes(instrument);

// Core's part key (lib/play_parts.py): the instrument when the part is empty or
// the same, else "instrument:part". '' for anything this plugin doesn't score.
export function partKey(instrument, part) {
    if (!isScoredInstrument(instrument)) return '';
    const p = str(part).toLowerCase();
    return !p || p === instrument || !SLUG.test(p) ? instrument : instrument + ':' + p;
}

// Expert+ is Expert for history (the contract's difficulty set).
export function normDifficulty(d) {
    const s = str(d).toLowerCase();
    if (s === 'expert_plus' || s === 'expertplus') return 'expert';
    return DIFFICULTIES.includes(s) ? s : '';
}

export function normalizePlayer(p) {
    if (!p || typeof p !== 'object' || !str(p.player)) return null;
    return {
        player: p.player, instrument: str(p.instrument), part: str(p.part), input: str(p.input),
        difficulty: normDifficulty(p.difficulty), canvas: p.canvas == null ? null : p.canvas,
        local: p.local !== false,
    };
}

export function normalizePlayJudgment(d) {
    if (!d || typeof d !== 'object' || !str(d.player) || !KINDS.includes(d.kind)) return null;
    const timing = d.timing === 'early' || d.timing === 'late' || d.timing === 'on' ? d.timing : null;
    return {
        sessionId: d.sessionId == null ? '' : String(d.sessionId), filename: str(d.filename),
        player: d.player, instrument: str(d.instrument), part: str(d.part), input: str(d.input),
        kind: d.kind, points: fin(d.points) || 0, multiplier: fin(d.multiplier), streak: fin(d.streak),
        t: fin(d.t), noteTime: fin(d.noteTime), offsetMs: fin(d.offsetMs), timing,
        canvas: d.canvas == null ? null : d.canvas, local: d.local !== false,
    };
}

// The players the scorecard can follow: local drums / 5-fret players.
export const followable = (players) => (players || []).filter((p) => p && p.local && isScoredInstrument(p.instrument));

// Keep the current pick while it's followable, else the first followable player.
export function pickFollow(players, current) {
    const list = followable(players);
    if (current && list.some((p) => p.player === current)) return current;
    return list.length ? list[0].player : null;
}

export function playMissReason(j) {
    if (!j) return null;
    if (j.kind === 'overhit') return 'overhit';
    if (j.kind !== 'miss') return null;
    if (j.timing === 'early' || (j.timing == null && j.offsetMs != null && j.offsetMs < 0)) return 'early';
    if (j.timing === 'late' || (j.timing == null && j.offsetMs != null && j.offsetMs > 0)) return 'late';
    return 'missed';
}

export const missWord = (instrument) => (instrument === 'five_fret' ? 'overstrums' : 'overhits');

const PART_NAMES = { guitar: 'Guitar', rhythm: 'Rhythm', bass: 'Bass', lead: 'Lead', keys: 'Keys' };
export function instrumentLabel(p) {
    if (!p) return '';
    const name = p.instrument === 'drums' ? 'Drums'
        : '5-Fret' + (p.part && p.part !== 'five_fret' ? ' ' + (PART_NAMES[p.part] || p.part) : '');
    const d = normDifficulty(p.difficulty);
    return d ? name + ' · ' + d[0].toUpperCase() + d.slice(1) : name;
}

export function createPlayRun(info) {
    const i = info || {};
    return {
        player: str(i.player), instrument: str(i.instrument), part: str(i.part), input: str(i.input),
        difficulty: normDifficulty(i.difficulty), canvas: i.canvas == null ? null : i.canvas,
        hits: 0, misses: 0, overhits: 0, score: 0, streak: 0, bestStreak: 0, multiplier: 1,
        recent: [], why: { early: 0, late: 0, missed: 0, overhit: 0 }, log: [],
    };
}

function apply(run, j) {
    run.score += j.points;
    if (j.multiplier != null && j.multiplier >= 1) run.multiplier = j.multiplier;
    const k = j.kind;
    if (k !== 'hit' && k !== 'miss' && k !== 'overhit') return;
    if (k === 'hit') run.hits++;
    else if (k === 'miss') run.misses++;
    else run.overhits++;
    if (k === 'overhit' && j.streak == null) run.streak = 0;
    else if (j.streak != null) run.streak = Math.max(0, Math.round(j.streak));
    else run.streak = k === 'hit' ? run.streak + 1 : 0;
    if (run.streak > run.bestStreak) run.bestStreak = run.streak;
    if (k === 'miss' && j.multiplier == null) run.multiplier = 1;
    const why = playMissReason(j);
    if (why) run.why[why]++;
    if (k !== 'overhit') {
        run.recent.push(k === 'hit');
        if (run.recent.length > RECENT_N) run.recent.shift();
    }
}

export function recordPlay(run, j) {
    if (!run || !j) return;
    run.log.push(j);
    apply(run, j);
}

// Drop the judgments after chart time t (a backward seek or a loop wrap) and rebuild.
export function rewindPlay(run, t) {
    if (!run || !Number.isFinite(t)) return;
    const keep = run.log.filter((j) => j.t == null || j.t <= t);
    if (keep.length === run.log.length) return;
    const fresh = createPlayRun(run);
    Object.assign(run, { hits: 0, misses: 0, overhits: 0, score: 0, streak: 0, bestStreak: 0, multiplier: 1,
        recent: [], why: fresh.why, log: [] });
    for (const j of keep) recordPlay(run, j);
}

// The POST /api/plugins/scorecard/run body for one play:result player, or
// null when it isn't recorded (guitar, practice, nothing judged).
export function resultRunPayload(p, result, session, run) {
    if (!p || !result || result.practice === true || !isScoredInstrument(p.instrument)) return null;
    const hits = Math.max(0, Math.round(fin(p.hits) || 0));
    const misses = Math.max(0, Math.round(fin(p.misses) || 0));
    if (hits + misses < 1) return null;
    const s = session || {};
    const sections = {};
    (Array.isArray(p.sections) ? p.sections : []).forEach((x, i) => {
        if (!x || typeof x !== 'object') return;
        const n = (fin(x.hits) || 0) + (fin(x.misses) || 0);
        const acc = fin(x.accuracy);
        if (n > 0 && acc != null) sections[i + ':' + str(x.name)] = [Math.round(acc * 100), n];
    });
    const failed = p.failed === true;
    const score = fin(p.score);
    return {
        filename: str(s.filename) || str(result.filename), arrangement: '',
        part: partKey(p.instrument, p.part), difficulty: normDifficulty(p.difficulty),
        title: str(s.title), artist: str(s.artist),
        hits, misses, best_streak: Math.max(0, Math.round(fin(p.bestStreak) || 0)),
        complete: !failed, looped: false, speed: 1, progress: failed ? 0 : 1,
        played_s: Math.max(0, Math.min(86400, fin(result.durationSec) || 0)),
        score: score != null && score >= 0 ? Math.round(score) : null,
        details: {
            sections, overhits: Math.max(0, Math.round(fin(p.overhits) || 0)),
            input: str(p.input), player: str(p.player), stars: fin(p.stars),
            ...(run ? { why: { ...run.why } } : {}),
        },
    };
}
