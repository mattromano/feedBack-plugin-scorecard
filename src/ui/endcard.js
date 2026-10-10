// End-of-song card: banner (full combo / new best / practice run), the score
// and where it came from, solos and technical runs, song best / trend / best
// streak / plays, and this run's sections, techniques and strings.
// d = POST /api/plugins/scorecard/run response, p = the posted payload,
// sections = the chart's sectionList().

import { COLORS, esc, fmtInt, fmtPct2, levelColor, el, stringBars } from './dom.js';
import { weakSpots } from '../engine/run.js';

const { gold: GOLD, blue: BLUE, dim: DIM, white: WHITE } = COLORS;

const fmtDur = (s) => {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + 'm';
};

function scoreHtml(d, p) {
    const sc = p.details && p.details.score;
    if (!sc) return '';
    const isBest = d.new_best_score || (d.counted && d.prev_best_score == null && sc.score > 0);
    const bestLine = d.prev_best_score != null
        ? (d.new_best_score ? 'previous best ' + fmtInt(d.prev_best_score) + '  ▲ +' + fmtInt(sc.score - d.prev_best_score)
            : 'best score ' + fmtInt(d.prev_best_score))
        : (d.counted ? 'first scored run' : 'practice run: not counted toward your best');
    let h = '<div class="sc-end-score"><div class="pts" style="color:' + (isBest ? GOLD : WHITE) + '">' + fmtInt(sc.score) + '</div>' +
        '<div class="sub">' + (isBest ? '<b style="color:' + GOLD + '">NEW BEST SCORE</b> · ' : '') + bestLine +
        ' · accuracy <b>' + fmtPct2(d.accuracy) + '</b>' + (sc.factor < 0.999 ? ' · ×' + sc.factor.toFixed(2) + ' speed/difficulty' : '') + '</div></div>';
    const b = sc.breakdown || {};
    const chip = (label, v, col) => (v ? '<span class="sc-chip" style="color:' + col + '">' + label + ' ' + (v > 0 ? '+' : '') + fmtInt(v) + '</span>' : '');
    const techs = Object.entries(sc.techniques || {}).map(([k, v]) => v + ' ' + k.replace(/([A-Z])/g, ' $1').toLowerCase() + (v > 1 ? 's' : '')).join(', ');
    h += '<div class="sc-chips">' + chip('notes', b.base, WHITE) + chip('timing', b.timing, b.timing < 0 ? BLUE : GOLD) +
        chip('technique' + (techs ? ' (' + esc(techs) + ')' : ''), b.technique, COLORS.purple) +
        chip('technical runs', b.technical, COLORS.orange) + chip('solos', b.solo, BLUE) + '</div>';
    for (const s of sc.solos || []) {
        h += '<div class="sc-end-line" style="color:#9fd0ff">' + esc(s.name) + ': ' + esc(s.rating) + ' ' + fmtPct2(s.pct) + ' (' + s.h + '/' + s.n + ') · +' + fmtInt(s.bonus) + '</div>';
    }
    const runs = sc.runs || [];
    if (runs.length) {
        const hit = runs.reduce((a, r) => a + r.h, 0), tot = runs.reduce((a, r) => a + r.n, 0);
        h += '<div class="sc-end-line" style="color:#ffb877">' + runs.length + ' technical run' + (runs.length > 1 ? 's' : '') + ': ' +
            hit + '/' + tot + ' notes · ' + runs.filter((r) => r.h === r.n).length + ' perfect</div>';
    }
    return h;
}

export function endCardHtml(d, p, sections) {
    const acc = d.accuracy;
    let banner;
    if (!d.counted) {
        banner = ['Practice run', DIM, p.speed < 0.999 ? 'played at ' + Math.round(p.speed * 100) + '% speed' : 'partial or looped — not counted toward your best'];
    } else if (d.full_combo) banner = ['FULL COMBO!', GOLD, 'every note hit'];
    else if (d.first_full_run) banner = ['First full run', WHITE, 'this is the score to beat'];
    else if (d.new_best) banner = ['NEW BEST!', GOLD, 'previous ' + fmtPct2(d.prev_best) + '  ▲ +' + (acc - d.prev_best).toFixed(2) + '%'];
    else banner = ['Best ' + fmtPct2(d.prev_best), WHITE, (acc - d.prev_best).toFixed(2) + '% from your best'];
    const parts = [];
    parts.push('<div class="sc-end-banner"><div class="t" style="color:' + banner[1] + '">' + esc(banner[0]) + '</div><div class="sub">' + esc(banner[2]) + '</div></div>');
    parts.push(scoreHtml(d, p));
    const stat = (v, label, col) => '<div><div class="v" style="color:' + (col || WHITE) + '">' + v + '</div><div class="l">' + label + '</div></div>';
    const trend = d.week_ago_best != null ? [acc - d.week_ago_best, 'vs a week ago']
        : (d.first_counted != null && d.run_count > 1 && d.counted ? [acc - d.first_counted, 'vs first full run'] : null);
    parts.push('<div class="sc-end-stats">' +
        stat(d.best ? fmtPct2(d.best.accuracy) : '–', 'song best', GOLD) +
        stat(trend ? (trend[0] >= 0 ? '+' : '') + trend[0].toFixed(2) + '%' : '–', trend ? trend[1] : 'trend', trend ? (trend[0] >= 0 ? GOLD : BLUE) : DIM) +
        stat(fmtInt(d.best_streak), 'best streak ever') +
        stat(d.core && d.core.plays ? fmtInt(d.core.plays) : fmtDur(d.practice_s), d.core && d.core.plays ? 'plays' : 'time on song') + '</div>');
    if (d.full_combos) parts.push('<div class="sc-end-line" style="color:' + GOLD + '">' + d.full_combos + ' full combo' + (d.full_combos > 1 ? 's' : '') + ' on this song</div>');
    const secs = (p.details && p.details.sections) || {};
    const rows = (sections || []).filter((s) => secs[s.key]);
    if (rows.length) {
        let h = '<div class="sc-end-h">Sections (★ = new section best)</div>';
        for (const s of rows) {
            const a = secs[s.key][0];
            const prev = d.prev_section_best ? d.prev_section_best[s.key] : undefined;
            const isNew = prev != null && a > prev;
            const best = d.section_best ? d.section_best[s.key] : null;
            h += '<div class="sc-end-sec"><span class="n">' + esc(s.label) + '</span><div class="bar">' +
                '<div style="width:' + a + '%;background:' + levelColor(a) + '"></div>' +
                (best != null ? '<i title="best ' + best + '%" style="left:' + best + '%"></i>' : '') + '</div>' +
                '<span class="v" style="color:' + levelColor(a) + '">' + (isNew ? '★ ' : '') + a + '%</span></div>';
        }
        parts.push(h);
    }
    const weak = weakSpots((p.details && p.details.tech) || {}, 3, 4);
    if (weak.length) {
        parts.push('<div class="sc-end-h">Techniques (weakest first)</div><div class="sc-chips left">' + weak.map((x) =>
            '<span class="sc-chip" style="color:' + levelColor(x.p) + '">' + esc(x.name) + ' ' + x.p + '% <span style="color:' + DIM + '">(' + x.h + '/' + x.n + ')</span></span>').join('') + '</div>');
    }
    const sb = stringBars((p.details && p.details.strings) || [], /bass/i.test(p.arrangement || ''), true);
    if (sb) parts.push('<div class="sc-end-h">Per string</div><div class="sc-end-strings">' + sb + '</div>');
    return parts.join('');
}

// The card is a body-level dialog (not inside #player): core may leave the
// player when the song ends, and the card should still be there to read.
// It holds core's auto-exit while open (see main.js) and `onClose` releases it.
export function createEndCard(onClose) {
    const card = el('div', 'sc-end');
    card.hidden = true;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Scorecard results');
    const body = el('div', 'sc-end-body');
    const close = el('button', 'sc-end-close', '×');
    close.type = 'button';
    close.title = 'Close';
    const hide = () => { if (!card.hidden) { card.hidden = true; if (onClose) onClose(); } };
    close.addEventListener('click', hide);
    const title = el('div', 'sc-end-title', 'Scorecard');
    card.append(close, title, body);
    return {
        el: card,
        show(d, p, sections, scale) {
            if (!card.isConnected) document.body.appendChild(card);
            if (scale) card.style.setProperty('--sc-scale', scale);
            title.textContent = 'Scorecard' + (p.title ? ' · ' + p.title : '') + (p.arrangement ? ' (' + p.arrangement + ')' : '');
            body.innerHTML = endCardHtml(d, p, sections);
            card.hidden = false;
        },
        hide,
        get open() { return !card.hidden; },
    };
}
