// Rock Band-style hit / miss marks on the highway, through core's public
// note-state provider (highway.setNoteStateProvider, feedBack#254).
//
// The provider contract is { state: 'hit' | 'active' | 'miss', alpha, color }
// and the renderer decides the look, so within it:
//  - hit: a short, white-hot flash ('hit', colour #ffffff, alpha 1 → 0 over
//    HIT_S) — the "burst";
//  - miss: 'miss' held at full strength until the note is MISS_HOLD_S past
//    the line, so a missed gem stays marked while it scrolls past instead of
//    a brief wash;
//  - partial chord: the strings that rang are lit amber (#ffa31a) for
//    PARTIAL_S, the ones that didn't are 'miss' — so a partly-played chord
//    reads differently from both a clean chord and a dead one.
// Hit vs miss differs in brightness and duration, not only hue.
//
// Only one provider can be registered, and Note Detection registers its own
// (sustain glow while a held note rings). So the scorecard *composes*: its
// provider asks the previously registered one first and keeps an 'active'
// (held sustain) answer, then applies its own verdict latch.
//
// Pure apart from the injected clock / previous provider.

export const HIT_S = 0.35;
export const PARTIAL_S = 0.9;
export const MISS_HOLD_S = 0.7;
export const KEEP_S = 3;
export const HIT_COLOR = '#ffffff';
export const PARTIAL_COLOR = '#ffa31a';

// Numeric key (chart time to the ms, string) — no per-call string building.
export function verdictKey(t, s) {
    return Math.round(t * 1000) * 16 + ((s | 0) & 15);
}

export function createVerdictStore() {
    const map = new Map();   // key → { v: 'hit' | 'miss' | 'partial', t, at }

    // j: normalised judgment; now: the renderer's chart clock when it landed.
    function record(j, now) {
        if (!j || !Number.isFinite(j.noteTime)) return;
        const at = Number.isFinite(now) ? Math.max(now, j.noteTime) : j.noteTime;
        const set = (s, v) => { if (Number.isInteger(s)) map.set(verdictKey(j.noteTime, s), { v, t: j.noteTime, at }); };
        if (!j.chord) { set(j.s, j.hit ? 'hit' : 'miss'); return; }
        const per = (j.strings && j.strings.length) ? j.strings : null;
        if (per) {
            const rang = per.filter((x) => x.hit).length;
            const chordV = rang === per.length ? 'hit' : rang === 0 ? 'miss' : 'partial';
            for (const x of per) set(x.s, chordV === 'partial' ? (x.hit ? 'partial' : 'miss') : chordV);
            return;
        }
        // Older notedetect: chord-level verdict only. A lenient hit with dead
        // strings (hitStrings < totalStrings) is still a partial chord.
        const notes = (j.notes && j.notes.length) ? j.notes : (Number.isInteger(j.s) ? [{ s: j.s }] : []);
        const partial = j.hit && Number.isFinite(j.hitStrings) && Number.isFinite(j.totalStrings)
            && j.hitStrings < j.totalStrings;
        for (const x of notes) set(x.s, partial ? 'partial' : j.hit ? 'hit' : 'miss');
    }

    function prune(now) {
        if (!Number.isFinite(now)) return;
        for (const [k, e] of map) if (now > e.t + KEEP_S || now < e.t - KEEP_S) map.delete(k);
    }

    // The state for a chart note at the renderer clock `now`, or null.
    function stateFor(note, chartTime, now) {
        if (!note || !Number.isFinite(chartTime) || !map.size) return null;
        const e = map.get(verdictKey(chartTime, note.s));
        if (!e || !Number.isFinite(now)) return null;
        const age = now - e.at;
        if (e.v === 'miss') {
            return now < e.t + MISS_HOLD_S ? { state: 'miss', alpha: 1 } : null;
        }
        const dur = e.v === 'partial' ? PARTIAL_S : HIT_S;
        if (age < 0) return { state: 'hit', alpha: 1, color: e.v === 'partial' ? PARTIAL_COLOR : HIT_COLOR };
        if (age >= dur) return null;
        return { state: 'hit', alpha: 1 - age / dur, color: e.v === 'partial' ? PARTIAL_COLOR : HIT_COLOR };
    }

    return { record, prune, stateFor, clear: () => map.clear(), get size() { return map.size; } };
}

/**
 * composeProvider(store, { getPrev, getNow, isEnabled }) → (note, chartTime) => state
 * Keeps the previous provider's 'active' (held sustain) and any answer for a
 * note the scorecard has no verdict for; otherwise the scorecard's latch wins.
 */
export function composeProvider(store, deps) {
    const { getPrev, getNow, isEnabled } = deps;
    return function scorecardNoteState(note, chartTime) {
        const prev = getPrev();
        let base = null;
        if (typeof prev === 'function') {
            try { base = prev(note, chartTime); } catch (_) { base = null; }
        }
        if (!isEnabled()) return base;
        const bs = base && (typeof base === 'string' ? base : base.state);
        if (bs === 'active') return base;
        const mine = store.stateFor(note, chartTime, getNow());
        return mine || base;
    };
}
