// Small DOM / formatting helpers shared by the UI modules.

export const COLORS = Object.freeze({
    gold: '#ffc531', blue: '#45c8ff', purple: '#b77bff', orange: '#ff9a40',
    dim: '#8b95a5', white: '#f1f5f9', text: '#cbd5e1', early: '#66c7ff', late: '#ff9a40', ok: '#e5e7eb',
});

// Multiplier colours ×1..×4 and the "on fire" tiers. All off the red-green
// axis so they read with colour blindness.
export const MULT_COLORS = ['#e5e7eb', COLORS.blue, COLORS.gold, COLORS.orange];
const FIRE_TIERS = [[200, COLORS.purple], [100, COLORS.blue], [50, COLORS.gold]];
export function fireColor(streak) {
    for (const [n, c] of FIRE_TIERS) if (streak >= n) return c;
    return null;
}

export function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
export const fmtMs = (ms) => (ms > 0 ? '+' : '') + Math.round(ms) + ' ms';
export const fmtPct2 = (x) => Number(x).toFixed(2) + '%';

export function levelColor(p) {
    return p == null ? COLORS.dim : p >= 90 ? COLORS.gold : p >= 75 ? COLORS.white : p >= 60 ? '#9fd8ff' : COLORS.blue;
}
export function accuracyColor(p) {
    return p == null ? COLORS.dim : p >= 95 ? COLORS.gold : p >= 85 ? COLORS.white : p >= 70 ? '#9fd8ff' : COLORS.dim;
}

export function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
}

// Set innerHTML only when it changed (cheap string compare, no layout).
export function setHtml(node, html) {
    if (node && node.__scHtml !== html) { node.__scHtml = html; node.innerHTML = html; }
}
export function setText(node, text) {
    if (node && node.__scText !== text) { node.__scText = text; node.textContent = text; }
}

const STRING_NAMES_GTR = ['E', 'A', 'D', 'G', 'B', 'e'];
const STRING_NAMES_GTR8 = ['B', 'E', 'A', 'D', 'G', 'B', 'e', 'a'];
export function stringLabels(n, bass) {
    if (bass) return n <= 4 ? ['E', 'A', 'D', 'G'] : ['B', 'E', 'A', 'D', 'G', 'C'].slice(0, n);
    return n <= 6 ? STRING_NAMES_GTR : STRING_NAMES_GTR8.slice(0, n);
}

// Per-string accuracy bars (low string on the left).
export function stringBars(strings, bass, big) {
    let n = bass ? 4 : 6;
    (strings || []).forEach((c, s) => { if (c && c[0] + c[1] > 0 && s + 1 > n) n = s + 1; });
    if (!(strings || []).slice(0, n).some((c) => c && c[0] + c[1] > 0)) return '';
    const labels = stringLabels(n, bass);
    let html = '<div class="sc-strings' + (big ? ' big' : '') + '">';
    for (let s = 0; s < n; s++) {
        const [h, m] = strings[s] || [0, 0];
        const p = h + m > 0 ? Math.round(100 * h / (h + m)) : null;
        const fill = p == null ? 0 : Math.max(6, p);
        html += '<div class="sc-str" title="' + esc(labels[s]) + ' string: ' + (p == null ? 'no notes' : p + '% (' + h + '/' + (h + m) + ')') + '">' +
            '<div class="bar"><div style="height:' + fill + '%;background:' + levelColor(p) + ';opacity:' + (p == null ? 0 : 0.9) + '"></div></div>' +
            '<div class="lbl">' + esc(labels[s]) + '</div>' +
            (big ? '<div class="val" style="color:' + levelColor(p) + '">' + (p == null ? '–' : p + '%') + '</div>' : '') + '</div>';
    }
    return html + '</div>';
}
