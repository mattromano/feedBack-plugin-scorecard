// Rock Band-style score engine, driven by note detection judgments.
//
//  - a hit single note is worth 50, a chord 50 per string that rang;
//  - timing: within 25 ms ×1, within 50 ms ×0.8, else ×0.6 (unknown ×0.8);
//  - technique bonus: +25 % bends and slides, +100 % harmonics, +200 % pinch
//    harmonics;
//  - technical bonus ×1.5 for single notes in dense passages (≥ 6 notes
//    within ±0.5 s); a run of ≥ 8 such notes reports "TECHNICAL RUN h/n";
//  - streak multiplier ×1–×4 (one step per 10 notes in a row); a miss scores
//    nothing and resets it;
//  - everything scaled by playback speed × difficulty (both capped at 1);
//  - solos: at the end of each solo a bonus of 100 per note hit, doubled for
//    a perfect solo, with a Rock Band-style rating.
//
// Pure: callers pass the clock (`now`, ms) and the chart; no DOM, no globals.

export const BASE_POINTS = 50;
export const MAX_MULTIPLIER = 4;
export const STREAK_PER_STEP = 10;
export const TECH_BONUS = Object.freeze({ bend: 0.25, slide: 0.25, harmonic: 1.0, pinchHarmonic: 2.0 });
export const DENSE_N = 6;
export const DENSE_WINDOW_S = 0.5;
export const DENSE_BONUS = 0.5;
export const RUN_GAP_MS = 700;
export const RUN_MIN = 8;
export const RUN_SETTLE_MS = 900;
export const SOLO_POINTS = 100;

export function multiplierFor(streak) {
    const s = Math.max(0, Math.floor(Number(streak) || 0));
    return Math.min(MAX_MULTIPLIER, 1 + Math.floor(s / STREAK_PER_STEP));
}

// Lit multiplier pips (0–10): progress toward the next step, all ten at ×4.
export function pipsFor(streak) {
    const s = Math.max(0, Math.floor(Number(streak) || 0));
    return multiplierFor(s) === MAX_MULTIPLIER ? STREAK_PER_STEP : s % STREAK_PER_STEP;
}

export function timingFactor(timingErrorMs) {
    if (typeof timingErrorMs !== 'number' || !Number.isFinite(timingErrorMs)) return 0.8;
    const a = Math.abs(timingErrorMs);
    return a <= 25 ? 1 : a <= 50 ? 0.8 : 0.6;
}

// Scoring techniques of a chart note in the core wire format (`bn` bend
// amount, `sl` / `slu` slide-to fret with -1 = none, `hm` / `hp` flags).
export function chartTechniques(n) {
    if (!n || typeof n !== 'object') return [];
    const out = [];
    if ((Number(n.bn) || 0) > 0) out.push('bend');
    if ((typeof n.sl === 'number' && n.sl >= 0) || (typeof n.slu === 'number' && n.slu >= 0)) out.push('slide');
    if (n.hp) out.push('pinchHarmonic');
    else if (n.hm) out.push('harmonic');
    return out;
}

// Keep only techniques that score; a pinch harmonic isn't also a harmonic.
export function scoringTechniques(names) {
    const set = new Set((names || []).filter((t) => Object.prototype.hasOwnProperty.call(TECH_BONUS, t)));
    if (set.has('pinchHarmonic')) set.delete('harmonic');
    return [...set];
}

export function speedDifficultyFactor(speed, mastery) {
    const cap = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1);
    return cap(speed) * cap(mastery);
}

// Note times (ms) of single notes in a dense passage.
export function denseNoteTimes(notes, n = DENSE_N, win = DENSE_WINDOW_S) {
    const T = (notes || []).map((x) => x && x.t).filter((t) => typeof t === 'number' && Number.isFinite(t))
        .sort((a, b) => a - b);
    const dense = new Set();
    for (let i = 0, lo = 0, hi = 0; i < T.length; i++) {
        while (T[lo] < T[i] - win) lo++;
        if (hi < i) hi = i;
        while (hi + 1 < T.length && T[hi + 1] <= T[i] + win) hi++;
        if (hi - lo + 1 >= n) dense.add(Math.round(T[i] * 1000));
    }
    return dense;
}

export function soloRating(pct, perfect) {
    if (perfect) return 'PERFECT SOLO!';
    return pct >= 95 ? 'AWESOME SOLO!' : pct >= 90 ? 'GREAT SOLO!' : pct >= 80 ? 'GOOD SOLO!'
        : pct >= 70 ? 'SOLID SOLO' : pct >= 60 ? 'OKAY SOLO' : 'MESSY SOLO';
}

export function soloBonus(hits, notes, factor = 1) {
    const perfect = notes > 0 && hits === notes;
    return hits * SOLO_POINTS * (perfect ? 2 : 1) * factor;
}

/**
 * createScoreEngine() → engine
 *   setChart({ dense: Set<ms>, solos: [{ id, name, start, end }] })
 *   judge(j, { techniques: string[], factor, now }) → events
 *   closeSolos(chartTime, factor, { all }) → events   (solos that have ended)
 *   closeRun(now, force) → events
 *   soloAt(t), soloProgress(id), snapshot()
 * Events: { type: 'technique' | 'pinch' | 'run' | 'solo', … } for popups.
 */
export function createScoreEngine() {
    let S;
    let chart = { dense: new Set(), solos: [] };
    const reset = () => {
        S = { score: 0, streak: 0, bestStreak: 0, notes: 0, hits: 0,
            base: 0, timing: 0, tech: 0, dense: 0, solo: 0,
            techN: {}, solos: {}, soloDone: [], run: null, runs: [] };
    };
    reset();

    function setChart(c) {
        chart = { dense: (c && c.dense) || new Set(), solos: (c && c.solos) || [] };
    }

    function soloAt(t) {
        for (const s of chart.solos) if (t >= s.start && t < s.end) return s;
        return null;
    }

    function closeRun(now, force) {
        const r = S.run;
        if (!r) return [];
        if (!force && now - r.at < RUN_SETTLE_MS) return [];
        S.run = null;
        if (r.n < RUN_MIN) return [];
        const run = { h: r.h, n: r.n, pts: Math.round(r.pts) };
        S.runs.push(run);
        return [{ type: 'run', ...run, perfect: r.h === r.n }];
    }

    function closeSolo(s, st, factor) {
        if (st.done) return null;
        st.done = true;
        const pct = st.n ? 100 * st.h / st.n : 0;
        const perfect = st.n > 0 && st.h === st.n;
        const bonus = soloBonus(st.h, st.n, factor);
        S.score += bonus;
        S.solo += bonus;
        const done = { name: s.name, h: st.h, n: st.n, pct: Math.round(pct * 100) / 100,
            bonus: Math.round(bonus), rating: soloRating(pct, perfect), perfect };
        S.soloDone.push(done);
        return { type: 'solo', ...done };
    }

    // Close every solo the playhead has left (`all`: song over, close the rest).
    function closeSolos(t, factor = 1, opts) {
        const out = [];
        const all = !!(opts && opts.all);
        for (const s of chart.solos) {
            const st = S.solos[s.id];
            if (st && !st.done && (all || t >= s.end + 1.0)) {
                const e = closeSolo(s, st, factor);
                if (e && e.n > 0) out.push(e);
            }
        }
        return out;
    }

    function judge(j, opts) {
        const o = opts || {};
        const now = Number.isFinite(o.now) ? o.now : 0;
        const f = Number.isFinite(o.factor) ? o.factor : 1;
        const events = [];
        if (!j || !Number.isFinite(j.noteTime)) return events;
        const tms = Math.round(j.noteTime * 1000);
        const mult = multiplierFor(S.streak);
        S.notes++;
        const dense = !j.chord && chart.dense.has(tms);
        let densePts = 0;
        if (j.hit) {
            S.hits++;
            S.streak++;
            if (S.streak > S.bestStreak) S.bestStreak = S.streak;
            const strings = j.chord ? Math.max(1, Number(j.hitStrings) || 0) : 1;
            const base = BASE_POINTS * strings;
            const timed = base * timingFactor(j.timingError);
            const techs = scoringTechniques(o.techniques);
            const techShare = techs.reduce((q, t) => q + TECH_BONUS[t], 0);
            const techPts = timed * techShare;
            const k = mult * f;
            densePts = dense ? (timed + techPts) * DENSE_BONUS * k : 0;
            S.base += base * k;
            S.timing += (timed - base) * k;
            S.tech += techPts * k;
            S.dense += densePts;
            S.score += (timed + techPts) * k + densePts;
            for (const t of techs) S.techN[t] = (S.techN[t] || 0) + 1;
            if (techs.length) {
                events.push({ type: 'technique', techniques: techs, points: Math.round(techPts * k) });
                if (techs.includes('pinchHarmonic')) events.push({ type: 'pinch', points: Math.round(techPts * k) });
            }
        } else {
            S.streak = 0;
        }
        if (dense) {
            if (!S.run || tms - S.run.lastT > RUN_GAP_MS) {
                events.push(...closeRun(now, true));
                S.run = { h: 0, n: 0, pts: 0, lastT: tms, at: now };
            }
            const r = S.run;
            r.n++;
            if (j.hit) r.h++;
            r.pts += densePts;
            r.lastT = tms;
            r.at = now;
        }
        const solo = soloAt(j.noteTime);
        if (solo) {
            const st = S.solos[solo.id] || (S.solos[solo.id] = { h: 0, n: 0, done: false });
            if (!st.done) { st.n++; if (j.hit) st.h++; }
        }
        return events;
    }

    function soloProgress(id) {
        const st = S.solos[id];
        return st ? { h: st.h, n: st.n, done: st.done } : { h: 0, n: 0, done: false };
    }

    function snapshot() {
        const r = Math.round;
        return {
            score: r(S.score), notes: S.notes, hits: S.hits, streak: S.streak, bestStreak: S.bestStreak,
            multiplier: multiplierFor(S.streak),
            breakdown: { base: r(S.base), timing: r(S.timing), technique: r(S.tech), technical: r(S.dense), solo: r(S.solo) },
            techniques: Object.assign({}, S.techN),
            solos: S.soloDone.map((s) => Object.assign({}, s)),
            runs: S.runs.map((x) => Object.assign({}, x)),
            inRun: !!(S.run && S.run.n >= 3),
        };
    }

    return { reset, setChart, judge, closeSolos, closeRun, soloAt, soloProgress, snapshot };
}
