// One "run": one stretch of note detection on one song + arrangement.
//
// It's saved when the song ends, another song/arrangement loads, detection
// resets, or the page closes (if it judged at least MIN_JUDGED notes). It
// counts toward the song's best only when complete (song ended or ≥ 92 %
// reached, no A-B loop) at 1.00×; slower or partial runs still go in the
// history. A miss-free counted run is a full combo.
//
// Per run it keeps:
//  - section passes: accuracy of each pass through a chart section (keyed
//    "<index>:<name>", so the 2nd verse is its own section), counted only at
//    1.00× and when ≥ 70 % of the section's notes were judged;
//  - accuracy per technique (bends, slides, hammer-ons, …) and per string;
//  - why notes were missed, single-note vs chord accuracy, recent form and
//    pitch tendency for the live card.
//
// Pure: no DOM, no globals.

import { stringsOf, missReason } from './judgment.js';

export const MIN_JUDGED = 20;
export const COMPLETE_AT = 0.92;
export const PASS_MIN_COVER = 0.7;
export const RECENT_N = 50;
export const MAX_STRINGS = 8;

export const TECH_LABELS = Object.freeze({
    B: 'bends', S: 'slides', H: 'harmonics', h: 'hammer-ons', p: 'pull-offs', t: 'taps',
    PM: 'palm mutes', TR: 'tremolo', A: 'accents', SUS: 'sustains',
});

// Short technique codes of a chart note (core wire format).
export function techFlagsOf(n) {
    if (!n || typeof n !== 'object') return [];
    const out = [];
    if ((Number(n.bn) || 0) > 0) out.push('B');
    if ((typeof n.sl === 'number' && n.sl >= 0) || (typeof n.slu === 'number' && n.slu >= 0)) out.push('S');
    if (n.hm || n.hp) out.push('H');
    if (n.ho) out.push('h');
    if (n.po) out.push('p');
    if (n.tp) out.push('t');
    if (n.pm) out.push('PM');
    if (n.tr) out.push('TR');
    if (n.ac) out.push('A');
    if ((Number(n.sus) || 0) > 0.5) out.push('SUS');
    return out;
}

// Map notedetect's technique names (≥ 1.33) onto the same codes, for when the
// chart note itself can't be found.
const NAME_TO_FLAG = { bend: 'B', slide: 'S', harmonic: 'H', pinchHarmonic: 'H', hammerOn: 'h', pullOff: 'p',
    tap: 't', palmMute: 'PM', tremolo: 'TR', accent: 'A' };
export function techFlagsFromNames(names) {
    const out = new Set();
    for (const n of names || []) if (NAME_TO_FLAG[n]) out.add(NAME_TO_FLAG[n]);
    return [...out];
}

// Chart sections with stable keys, labels ("verse 2" only when a name
// repeats) and note counts.
export function sectionList(sections, notes, chords) {
    const src = (sections || []).filter((s) => s && Number.isFinite(+s.time));
    const list = [];
    const seen = {};
    const countIn = (arr, t0, t1) => {
        let n = 0;
        for (const x of arr || []) if (x && x.t >= t0 && x.t < t1 && !x.mt) n++;
        return n;
    };
    src.forEach((s, i) => {
        const t0 = +s.time, t1 = i + 1 < src.length ? +src[i + 1].time : Infinity;
        const name = String(s.name == null ? '' : s.name);
        seen[name] = (seen[name] || 0) + 1;
        list.push({ key: i + ':' + name, name, nth: seen[name], t0, t1, notes: countIn(notes, t0, t1) + countIn(chords, t0, t1) });
    });
    for (const s of list) s.label = seen[s.name] > 1 ? s.name + ' ' + s.nth : s.name;
    return list;
}

export function sectionAt(list, t) {
    let cur = null;
    for (const s of list || []) { if (s.t0 <= t) cur = s; else break; }
    return cur;
}

export const pct = (h, n) => (n > 0 ? Math.round(100 * h / n) : null);

export function createRun(info) {
    const i = info || {};
    return {
        filename: String(i.filename || ''), arrangement: String(i.arrangement || ''),
        title: String(i.title || ''), artist: String(i.artist || ''),
        bass: /bass/i.test(String(i.arrangement || '')),
        hits: 0, misses: 0, streak: 0, bestStreak: 0,
        maxProgress: 0, minSpeed: 9, looped: false, t0: Number.isFinite(i.now) ? i.now : 0,
        sections: {}, tech: {}, strings: Array.from({ length: MAX_STRINGS }, () => [0, 0]), pass: null,
        recent: [], singles: [0, 0], chords: [0, 0], pitch: [],
        why: { unheard: 0, early: 0, late: 0, pitch: 0, chord: 0 },
    };
}

export function closePass(run) {
    const p = run && run.pass;
    if (!p) return;
    run.pass = null;
    const n = p.h + p.m;
    if (!p.fullSpeed || n < 3 || (p.sec.notes && n < PASS_MIN_COVER * p.sec.notes)) return;
    const acc = pct(p.h, n);
    const prev = run.sections[p.sec.key];
    if (!prev || acc > prev[0]) run.sections[p.sec.key] = [acc, n];
}

/**
 * recordJudgment(run, j, { flags, sections, fullSpeed })
 *   j: normalised judgment; flags: technique codes of the judged chart
 *   note(s); sections: sectionList() of the chart.
 */
export function recordJudgment(run, j, opts) {
    if (!run || !j) return;
    const o = opts || {};
    const hit = !!j.hit;
    if (hit) {
        run.hits++;
        run.streak++;
        if (run.streak > run.bestStreak) run.bestStreak = run.streak;
    } else {
        run.misses++;
        run.streak = 0;
        const why = missReason(j);
        if (why) run.why[why]++;
    }
    run.recent.push(hit);
    if (run.recent.length > RECENT_N) run.recent.shift();
    (j.chord ? run.chords : run.singles)[hit ? 0 : 1]++;
    if (!j.chord && Number.isFinite(j.pitchError)) {
        run.pitch.push(j.pitchError);
        if (run.pitch.length > 24) run.pitch.shift();
    }
    // Strings: per-string verdicts only (a chord-level verdict without them
    // says nothing about any one string).
    for (const x of stringsOf(j)) {
        if (!x.perString || x.s < 0 || x.s >= MAX_STRINGS) continue;
        run.strings[x.s][x.hit ? 0 : 1]++;
    }
    for (const f of o.flags || []) {
        const c = run.tech[f] || (run.tech[f] = [0, 0]);
        c[hit ? 0 : 1]++;
    }
    const sec = sectionAt(o.sections, j.noteTime);
    if (sec) {
        const t = j.noteTime;
        if (!run.pass || run.pass.sec.key !== sec.key || t < run.pass.lastT - 0.5) {
            closePass(run);
            run.pass = { sec, h: 0, m: 0, fullSpeed: true, lastT: t };
        }
        run.pass.lastT = t;
        if (o.fullSpeed === false) run.pass.fullSpeed = false;
        run.pass[hit ? 'h' : 'm']++;
    }
}

// Playback state sampled while the run is live.
export function trackPlayback(run, { progress, speed, looped }) {
    if (!run) return;
    if (Number.isFinite(progress)) run.maxProgress = Math.max(run.maxProgress, Math.min(1, Math.max(0, progress)));
    if (Number.isFinite(speed) && speed > 0) run.minSpeed = Math.min(run.minSpeed, speed);
    if (looped) run.looped = true;
}

export function isComplete(run, reason) {
    return !!run && !run.looped && (reason === 'ended' || run.maxProgress >= COMPLETE_AT);
}

// Weakest techniques first (by accuracy, then by volume).
export function weakSpots(tech, minN = 4, max = 3) {
    return Object.entries(tech || {})
        .map(([k, c]) => ({ k, name: TECH_LABELS[k] || k, h: c[0], n: c[0] + c[1], p: pct(c[0], c[0] + c[1]) }))
        .filter((x) => x.n >= minN)
        .sort((a, b) => a.p - b.p || b.n - a.n)
        .slice(0, max);
}

export function pitchTendency(samples) {
    if (!samples || samples.length < 6) return null;
    const s = samples.slice().sort((a, b) => a - b);
    const m = Math.round(s[s.length >> 1]);
    return { cents: m, word: Math.abs(m) <= 5 ? 'in tune' : m > 0 ? 'sharp' : 'flat' };
}

// The POST /api/plugins/scorecard/run body.
export function runPayload(run, reason, score, nowMs) {
    closePass(run);
    const speed = run.minSpeed > 8 ? 1 : run.minSpeed;
    return {
        filename: run.filename, arrangement: run.arrangement, title: run.title, artist: run.artist,
        hits: run.hits, misses: run.misses, best_streak: run.bestStreak,
        complete: isComplete(run, reason), looped: run.looped, speed,
        progress: +run.maxProgress.toFixed(3),
        played_s: Number.isFinite(nowMs) ? Math.max(0, (nowMs - run.t0) / 1000) : 0,
        score: score && Number.isFinite(score.score) ? score.score : null,
        details: {
            sections: run.sections, tech: run.tech, strings: run.strings,
            why: run.why, singles: run.singles, chords: run.chords,
            ...(score ? { score } : {}),
        },
    };
}
