// Early/late timing gauge model and the A/V check.
//
// notedetect's timingError = (detect time − latency offset) − note time, so
// + is late and raising the Audio Latency Offset by the median centres it.
// Samples are kept latency-independent (error + the latency in effect when the
// note was judged), so moving the latency slider re-centres the gauge at once.
// Notes off by more than the Timing Tolerance are never matched and never
// reach the gauge (they're plain misses).
//
// A/V check. notedetect judges against the highway's (visual) clock, so when
// you play by watching the highway a wrong A/V offset cancels out and never
// shows in these numbers. The check measures it: the running median is the
// "by eye" reference; then ~12 notes played by ear, eyes off the highway. If
// you land later or earlier by ear than by eye, audio and video disagree, and
// the suggested A/V offset lines them up. The sample window resets whenever
// the A/V offset changes.
//
// Pure: no DOM, no globals.

export const WINDOW_N = 24;      // samples shown on the gauge
export const RANGE_MS = 150;     // gauge half-width
export const MIN_N = 6;          // samples before suggesting anything
export const DEAD_MS = 12;       // |median| below this reads "on time"
export const EAR_N = 12;         // hits needed for the A/V check
export const AV_DEAD_MS = 15;    // ear-vs-eye difference below this is fine
export const LATENCY_MAX_MS = 250;   // notedetect's latency slider range (0–250 ms)
export const AV_LIMIT_MS = 1000;     // core's A/V offset range (±1000 ms)

export function median(a) {
    if (!a || !a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function classifyTiming(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return Math.abs(ms) < DEAD_MS ? 'ontime' : ms < 0 ? 'early' : 'late';
}

// Gauge position 0..1 for a timing error (centre = on time).
export function gaugePos(ms) {
    return 0.5 + 0.5 * Math.max(-1, Math.min(1, ms / RANGE_MS));
}

// The Audio Latency Offset that centres a median error, clamped to the slider
// (Note Detection's 0–250 ms; an instrument's input offset passes its own range).
export function latencySuggestion(latencyMs, medianMs, range) {
    const lo = range && Number.isFinite(range.min) ? range.min : 0;
    const hi = range && Number.isFinite(range.max) ? range.max : LATENCY_MAX_MS;
    if (!Number.isFinite(latencyMs) || !Number.isFinite(medianMs)) return null;
    if (Math.abs(medianMs) < DEAD_MS) return { ok: true, value: Math.round(latencyMs) };
    const want = Math.round(latencyMs + medianMs);
    const step = range && range.step > 0 ? range.step : 1;
    const value = Math.max(lo, Math.min(hi, Math.round(want / step) * step));
    return { ok: false, value, atLimit: value !== want, raise: medianMs > 0, changes: value !== Math.round(latencyMs) };
}

// The A/V offset that cancels an ear-vs-eye difference (ms, + = later by ear).
export function avSuggestion(avMs, deltaMs) {
    if (!Number.isFinite(deltaMs)) return null;
    if (!Number.isFinite(avMs) || Math.abs(deltaMs) < AV_DEAD_MS) return { ok: true, delta: deltaMs };
    const value = Math.max(-AV_LIMIT_MS, Math.min(AV_LIMIT_MS, Math.round(avMs - deltaMs)));
    return { ok: false, delta: deltaMs, value, raise: value > avMs };
}

/**
 * createTimingGauge(range?)            range: { min, max } of the offset it suggests
 *   push(j, { latencyMs, avMs, now })   j: normalised judgment
 *   summary({ latencyMs, avMs })        → { samples, errors, median, cls, latency, byEar, check }
 *   startCheck() / cancelCheck() / reset()
 *   lastMiss(now)                       → { ms, age } for 1.5 s after an EARLY/LATE miss
 */
export function createTimingGauge(range) {
    let raw = [];             // latency-free samples (ms)
    let lastAv = null;
    let check = null;         // { base, ear: [], done: { delta } | null }
    let miss = null;          // { ms, at }

    function syncAv(avMs) {
        if (Number.isFinite(avMs) && lastAv != null && avMs !== lastAv) { raw = []; check = null; }
        if (Number.isFinite(avMs)) lastAv = avMs;
    }

    function push(j, ctx) {
        const c = ctx || {};
        syncAv(c.avMs);
        if (!j || !Number.isFinite(j.timingError)) return;
        const L = Number.isFinite(c.latencyMs) ? c.latencyMs : 0;
        const sample = j.timingError + L;
        if (check && !check.done) {
            // The A/V check uses hits only: their timing is the trustworthy part.
            if (j.hit) check.ear.push(sample);
            if (check.ear.length >= EAR_N) check.done = { delta: median(check.ear) - check.base };
        } else {
            raw.push(sample);
            if (raw.length > WINDOW_N) raw.shift();
        }
        if (!j.hit && (j.timingState === 'EARLY' || j.timingState === 'LATE')) {
            miss = { ms: j.timingError, at: Number.isFinite(c.now) ? c.now : 0 };
        }
    }

    function summary(ctx) {
        const c = ctx || {};
        syncAv(c.avMs);
        const L = Number.isFinite(c.latencyMs) ? c.latencyMs : 0;
        const byEar = !!(check && !check.done);
        const shown = byEar ? check.ear : raw;
        const errors = shown.map((r) => r - L);
        const m = median(errors);
        return {
            samples: errors.length,
            errors,
            median: m,
            cls: classifyTiming(m),
            byEar,
            canCheck: !check && raw.length >= MIN_N,
            latency: (!byEar && errors.length >= MIN_N && Number.isFinite(c.latencyMs))
                ? latencySuggestion(c.latencyMs, m, range) : null,
            check: check ? { progress: check.ear.length, need: EAR_N,
                result: check.done ? avSuggestion(c.avMs, check.done.delta) : null } : null,
        };
    }

    function startCheck() {
        if (raw.length < MIN_N) return false;
        check = { base: median(raw), ear: [], done: null };
        return true;
    }

    function lastMiss(now) {
        if (!miss) return null;
        const age = now - miss.at;
        return age >= 0 && age < 1500 ? { ms: miss.ms, age } : null;
    }

    return {
        push, summary, startCheck, lastMiss,
        cancelCheck() { check = null; },
        reset() { raw = []; check = null; miss = null; },
    };
}
