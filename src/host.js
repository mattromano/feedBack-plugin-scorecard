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
