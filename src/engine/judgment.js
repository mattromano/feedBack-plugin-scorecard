// Normalise a notedetect:hit / notedetect:miss event payload.
//
// notedetect ≥ 1.33 enriches every judgment (key, strings, techniques,
// section, latencyMs, avOffsetMs, counted, isDefault, …). Older builds send
// the legacy shape only ({ note, noteTime, hit, timingState, timingError,
// pitchError, detectedMidi, chord, notes, hitStrings, totalStrings,
// chartNote }). Everything below the legacy fields is optional, so a missing
// field reads as "unknown" (null) and the scorecard degrades instead of
// guessing.
//
// Pure: no DOM, no globals — unit-tested under node --test.

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);

function stringVerdicts(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const r of list) {
        if (!r || int(r.s) == null) continue;
        out.push({ s: r.s, f: int(r.f), hit: !!r.hit });
    }
    return out;
}

function chordNotes(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const n of list) if (n && int(n.s) != null) out.push({ s: n.s, f: int(n.f) });
    return out;
}

export function normalizeJudgment(d) {
    if (!d || typeof d !== 'object') return null;
    const noteTime = fin(d.noteTime);
    if (noteTime == null) return null;
    const note = (d.chartNote && typeof d.chartNote === 'object') ? d.chartNote
        : (d.note && typeof d.note === 'object') ? d.note : {};
    const ts = d.timingState;
    return {
        key: typeof d.key === 'string' ? d.key : null,
        hit: !!d.hit,
        chord: !!d.chord,
        noteTime,
        s: int(note.s),
        f: int(note.f),
        timingState: ts === 'OK' || ts === 'EARLY' || ts === 'LATE' ? ts : null,
        timingError: fin(d.timingError),
        pitchError: fin(d.pitchError),
        detectedMidi: fin(d.detectedMidi),
        hitStrings: fin(d.hitStrings),
        totalStrings: fin(d.totalStrings),
        strings: stringVerdicts(d.strings),
        notes: chordNotes(d.notes),
        techniques: Array.isArray(d.techniques) ? d.techniques.filter((t) => typeof t === 'string') : null,
        // undefined = the payload predates the field; null = "no section".
        section: typeof d.section === 'string' ? d.section : (d.section === null ? null : undefined),
        latencyMs: fin(d.latencyMs),
        avOffsetMs: fin(d.avOffsetMs),
        // Older notedetect only emits counted judgments and has no splitscreen
        // flag, so absent means "counts" / "main player".
        counted: d.counted !== false,
        isDefault: d.isDefault !== false,
    };
}

// The strings a judgment covers, each with its own verdict: a chord's
// per-string results when notedetect reports them, else every chord note
// carrying the chord-level verdict, else the single note's string.
export function stringsOf(j) {
    if (!j) return [];
    if (j.chord) {
        if (j.strings && j.strings.length) return j.strings.map((x) => ({ s: x.s, hit: x.hit, perString: true }));
        if (j.notes && j.notes.length) return j.notes.map((x) => ({ s: x.s, hit: j.hit, perString: false }));
        return j.s != null ? [{ s: j.s, hit: j.hit, perString: false }] : [];
    }
    return j.s != null ? [{ s: j.s, hit: j.hit, perString: true }] : [];
}

// Why a note was missed, one bucket per miss (same priority notedetect's
// diagnostic uses: chord → not heard → timing → pitch).
export function missReason(j) {
    if (!j || j.hit) return null;
    if (j.chord) return 'chord';
    if (j.detectedMidi == null) return 'unheard';
    if (j.timingState === 'EARLY') return 'early';
    if (j.timingState === 'LATE') return 'late';
    return 'pitch';
}
