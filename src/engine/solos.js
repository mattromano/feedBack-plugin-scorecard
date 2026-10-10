// Solo sections: the ones the chart names, plus a heuristic for solos it
// doesn't. Official charts often call a solo "interlude", "bridge", "riff" or
// even "prechorus". A section counts as a solo on the part being played when,
// compared with the rest of the song, it is
//   - mostly single notes (≥ 75 % of its events),
//   - fast (≥ 2.5 single notes per second and ≥ 1.8× the song's median section),
//   - not repeated elsewhere (≥ 60 % of its bars have pitch content found at
//     most twice in the chart),
//   - up the neck (median fret ≥ 6), and
//   - at least 3 bars long.
// Verses, choruses, intros and no-guitar sections never count. On songs that
// do name their solo, this flags a real "solo" section ~86 % of the time.
//
// Pure: takes the highway's chart arrays, returns plain data.

export const SOLO_RE = /solo/i;
const EXCLUDE_RE = /^(verse|chorus)\d*$|noguitar|silence|^intro/i;

const median = (a) => {
    if (!a.length) return 0;
    const q = a.slice().sort((x, y) => x - y), m = q.length >> 1;
    return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2;
};

const sortedSections = (sections) => (sections || [])
    .filter((s) => s && typeof s.time === 'number' && Number.isFinite(s.time))
    .slice().sort((a, b) => a.time - b.time);

// Section indexes (into the time-sorted list) that look like an unnamed solo.
export function detectSolos(notes, chords, sections, beats) {
    const found = new Set();
    const secs = sortedSections(sections);
    const bt = (beats || []).filter((b) => b && b.measure >= 0 && Number.isFinite(b.time));
    if (bt.length < 4 || !secs.length) return found;
    const ev = [];
    for (const n of notes || []) {
        if (n && Number.isFinite(n.t) && !n.mt) ev.push({ t: n.t, single: true, p: [n.s + ':' + n.f], f: n.f });
    }
    for (const c of chords || []) {
        if (c && Number.isFinite(c.t)) ev.push({ t: c.t, single: false, p: (c.notes || []).map((x) => x.s + ':' + x.f), f: null });
    }
    ev.sort((x, y) => x.t - y.t);
    const bars = [];
    for (let i = 0, k = 0; i < bt.length; i++) {
        const a = bt[i].time;
        const b = i + 1 < bt.length ? bt[i + 1].time : a + (a - bt[i - 1].time);
        while (k < ev.length && ev[k].t < a) k++;
        const seg = [];
        for (let j = k; j < ev.length && ev[j].t < b; j++) seg.push(ev[j]);
        const frets = seg.filter((e) => e.single).map((e) => e.f);
        bars.push({ a, b, n: seg.length, singles: frets.length, fret: median(frets),
            sig: [...new Set(seg.flatMap((e) => e.p))].sort().join(',') });
    }
    const counts = new Map();
    for (const x of bars) if (x.n) counts.set(x.sig, (counts.get(x.sig) || 0) + 1);
    const songEnd = bars[bars.length - 1].b;
    const rows = secs.map((s, i) => {
        const end = i + 1 < secs.length ? secs[i + 1].time : songEnd;
        const bs = bars.filter((x) => x.a >= s.time - 0.01 && x.a < end - 0.01);
        const n = bs.reduce((q, x) => q + x.n, 0);
        const singles = bs.reduce((q, x) => q + x.singles, 0);
        return {
            i, name: String(s.name || ''), bars: bs.length, n,
            frac: n ? singles / n : 0,
            uniq: bs.length ? bs.filter((x) => x.n && counts.get(x.sig) <= 2).length / bs.length : 0,
            nps: singles / Math.max(1e-3, end - s.time),
            fret: median(bs.filter((x) => x.singles).map((x) => x.fret)),
        };
    });
    const songMed = median(rows.filter((r) => r.n).map((r) => r.nps));
    for (const r of rows) {
        if (!EXCLUDE_RE.test(r.name) && !SOLO_RE.test(r.name) && r.bars >= 3 && r.frac >= 0.75
            && r.nps >= 2.5 && r.uniq >= 0.6 && r.fret >= 6 && r.nps >= 1.8 * Math.max(songMed, 0.5)) {
            found.add(r.i);
        }
    }
    return found;
}

// Solo windows [{ id, name, start, end, auto }]: sections named "solo", plus
// the auto-detected ones when the chart names none. Adjacent solo sections
// (solo, solo) merge into one.
export function soloWindows(sections, notes, chords, beats) {
    const secs = sortedSections(sections);
    const named = secs.some((s) => SOLO_RE.test(String(s.name || '')));
    const auto = named ? new Set() : detectSolos(notes, chords, secs, beats);
    const out = [];
    secs.forEach((s, i) => {
        const isNamed = SOLO_RE.test(String(s.name || ''));
        if (!isNamed && !auto.has(i)) return;
        const end = i + 1 < secs.length ? secs[i + 1].time : Infinity;
        const prev = out[out.length - 1];
        if (prev && prev.end === s.time) { prev.end = end; return; }
        out.push({ id: out.length, name: isNamed ? String(s.name) : 'Solo (' + String(s.name) + ')',
            start: s.time, end, auto: !isNamed });
    });
    return out;
}
