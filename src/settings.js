// Per-browser preferences (localStorage, prefixed with the plugin id). Read
// once at boot and cached; writes are rare (button clicks).

export const MODES = ['auto', 'compact', 'full', 'off'];
const KEY = 'scorecard.settings.v1';
const DEFAULTS = { mode: 'auto', marks: true, scale: 1 };

let cache = null;

function load() {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { v = null; }
    const s = Object.assign({}, DEFAULTS, v && typeof v === 'object' ? v : {});
    if (!MODES.includes(s.mode)) s.mode = DEFAULTS.mode;
    s.marks = s.marks !== false;
    s.scale = Number.isFinite(+s.scale) && +s.scale >= 0.5 && +s.scale <= 2.5 ? +s.scale : 1;
    return s;
}

export function getSettings() {
    if (!cache) cache = load();
    return cache;
}

export function setSetting(k, v) {
    const s = getSettings();
    s[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* private mode: keep in memory */ }
    return s;
}

export function nextMode(mode) {
    return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}
