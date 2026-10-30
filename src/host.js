// Thin, feature-detected reads/writes of the host and Note Detection public
// APIs. Every call is wrapped so an older host or notedetect (or none at all)
// degrades to "unknown" instead of throwing.

const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; } };

export const bus = () => (window.feedBack && typeof window.feedBack.on === 'function') ? window.feedBack : null;
export const hw = () => window.highway || null;
export const nd = () => window.noteDetect || null;

export function currentSong() {
    const cs = safe(() => window.feedBack.currentSong, null);
    const info = safe(() => hw().getSongInfo(), null) || {};
    if (!cs && !info.title) return null;
    return {
        filename: (cs && cs.filename) || info.filename || '',
        title: (cs && cs.title) || info.title || '',
        artist: (cs && cs.artist) || info.artist || '',
        arrangement: (cs && cs.arrangement) || info.arrangement || '',
        duration: Number((cs && cs.duration) || info.duration) || 0,
    };
}

export const chartTime = () => safe(() => hw().getTime(), 0) || 0;
// The renderer's (visual) clock: chart time + A/V offset, the basis gems are
// drawn on and the one notedetect's provider ages its glow against.
export const avOffsetMs = () => { const v = safe(() => hw().getAvOffset(), null); return Number.isFinite(v) ? v : null; };
export const renderTime = () => chartTime() + (avOffsetMs() || 0) / 1000;

export function chart() {
    const h = hw();
    if (!h) return { notes: [], chords: [], sections: [], beats: [] };
    // Filtered arrays: the notes the player is actually shown at the current
    // mastery level (raw arrays when the song has a single difficulty).
    const notes = safe(() => (h.getFilteredNotes ? h.getFilteredNotes() : h.getNotes()), null) || [];
    const chords = safe(() => (h.getFilteredChords ? h.getFilteredChords() : h.getChords()), null) || [];
    return { notes, chords, sections: safe(() => h.getSections(), null) || [], beats: safe(() => h.getBeats(), null) || [] };
}

export const mastery = () => { const m = safe(() => (hw().hasPhraseData && hw().hasPhraseData() ? hw().getMastery() : 1), 1); return Number.isFinite(m) ? m : 1; };

// No public playback-rate getter exists; the documented <audio> element
// carries it in the browser (desktop native playback mirrors the rate there
// for the backing track). Unknown → 1.
export function playbackRate() {
    const a = document.getElementById('audio');
    const r = a ? Number(a.playbackRate) : NaN;
    return Number.isFinite(r) && r > 0 ? r : 1;
}

export const loopActive = () => safe(() => {
    const l = window.feedBack.getLoop({ reason: 'scorecard' });
    return !!l && Number.isFinite(l.loopA) && Number.isFinite(l.loopB);
}, false);

export const isDrums = () => {
    const s = currentSong();
    return !!s && /drum/i.test(s.arrangement || '');
};

export const inRoom = () => !!document.documentElement.dataset.mpRoom;

// ── Note Detection ──
export const ndEnabled = () => !!safe(() => nd().isEnabled(), false);
export const ndStats = () => safe(() => nd().getStats(), null);

export function canApplyLatency() { return !!safe(() => typeof nd().applySettings === 'function', false); }
export function applyLatencyMs(ms) {
    return safe(() => { nd().applySettings({ latencyOffset: ms / 1000 }); return true; }, false);
}
export function canApplyAv() { return typeof window.setAvOffsetMs === 'function'; }
export function applyAvMs(ms) { return safe(() => { window.setAvOffsetMs(ms); return true; }, false); }

// ── v3 player chrome ──
export function playerControlSlot() {
    const fb = window.feedBack;
    return (fb && fb.uiVersion === 'v3' && fb.ui && typeof fb.ui.playerControlSlot === 'function')
        ? safe(() => fb.ui.playerControlSlot(), null) : null;
}

// ── Drums / 5-fret input offset (the timing gauge's Apply) ──
// { where, min, max, get() -> ms | null, set(ms) -> ms | null } for a play:*
// player, or null when that instrument offers no setter (Apply is hidden).
// A public setInputOffset / getInputOffset(canvas) on feedBackDrums /
// feedBackFiveFret wins when present. Otherwise:
//  - drums on the MIDI kit: the drums plugin's calibration hooks
//    (__drumsSetInputOffset, __drumsGetConfig().inputOffsetMs): the same path
//    as its settings field and its early/late Apply, live for every session;
//  - 5-fret: the lane's controller offset through FiveFretProfiles.setOffset
//    plus five_fret:offset-changed (what its quick settings do), live.
// A drums controller lane has no public live setter yet: no Apply.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampTo = (v, lo, hi, step) => Math.max(lo, Math.min(hi, Math.round(v / step) * step));

export function instrumentOffset(p) {
    if (!p) return null;
    const canvas = p.canvas == null ? undefined : p.canvas;
    if (p.instrument === 'drums') {
        const d = window.feedBackDrums;
        if (d && typeof d.setInputOffset === 'function' && typeof d.getInputOffset === 'function') {
            return { where: 'Drums', min: -250, max: 250,
                get: () => num(safe(() => d.getInputOffset(canvas), null)),
                set: (ms) => num(safe(() => d.setInputOffset(clampTo(ms, -250, 250, 1), canvas), null)) };
        }
        if (p.input === 'kit' && typeof window.__drumsSetInputOffset === 'function' && typeof window.__drumsGetConfig === 'function') {
            return { where: 'Drums', min: -250, max: 250,
                get: () => num(safe(() => window.__drumsGetConfig().inputOffsetMs, null)),
                set: (ms) => num(safe(() => window.__drumsSetInputOffset(clampTo(ms, -250, 250, 1)), null)) };
        }
        return null;
    }
    if (p.instrument === 'five_fret') {
        const f = window.feedBackFiveFret;
        if (f && typeof f.setInputOffset === 'function' && typeof f.getInputOffset === 'function') {
            return { where: '5-Fret', min: -200, max: 200,
                get: () => num(safe(() => f.getInputOffset(canvas), null)),
                set: (ms) => num(safe(() => f.setInputOffset(clampTo(ms, -200, 200, 5), canvas), null)) };
        }
        const P = window.FiveFretProfiles;
        const key = safe(() => f.getInstanceState(canvas).controllerKey, null);
        if (!P || typeof P.setOffset !== 'function' || typeof P.loadSettings !== 'function' || typeof key !== 'string' || !key) return null;
        return { where: '5-Fret', min: -200, max: 200,
            get: () => num(safe(() => P.loadSettings().offsetMs[key], null)) ?? 0,
            set: (ms) => {
                const v = clampTo(ms, -200, 200, 5);
                if (safe(() => { P.setOffset(key, v); return true; }, false) !== true) return null;
                safe(() => window.feedBack.emit('five_fret:offset-changed', { controllerKey: key, offsetMs: v }));
                return v;
            } };
    }
    return null;
}
