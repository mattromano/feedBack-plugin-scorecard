// The stats card (right of the highway): live accuracy, form, timing gauge,
// and this song's history. Two columns in full mode; in compact mode
// (multiplayer rooms, or by choice) only the accuracy head and the timing
// readout remain (CSS: .sc-root[data-compact]).
//
// update(model) builds small HTML strings and writes a node only when its
// string changed — no layout reads, no queries after mount.

import { COLORS, esc, fmtInt, fmtMs, fmtPct2, levelColor, accuracyColor, el, setHtml, stringBars } from './dom.js';
import { gaugePos, RANGE_MS, MIN_N, DEAD_MS } from '../engine/timing.js';
import { pct, weakSpots, pitchTendency } from '../engine/run.js';

const { gold: GOLD, blue: BLUE, dim: DIM, white: WHITE, early: EARLY, late: LATE, ok: OK, orange: ORANGE } = COLORS;

const row = (label, value, cls) => '<div class="sc-row' + (cls ? ' ' + cls : '') + '"><span class="lbl">' + label + '</span>' + value + '</div>';
const btn = (act, label, v, title) => '<button type="button" class="sc-btn" data-act="' + act + '"' +
    (v != null ? ' data-v="' + v + '"' : '') + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
const timingCol = (ms) => (Math.abs(ms) < DEAD_MS ? OK : ms < 0 ? EARLY : LATE);

function perfHtml(run) {
    const total = run ? run.hits + run.misses : 0;
    const acc = total ? 100 * run.hits / total : null;
    let h = '<div class="sc-head"><div class="sc-acc" style="color:' + accuracyColor(acc == null ? null : Math.floor(acc)) + '">' +
        (acc == null ? '–' : fmtPct2(acc)) + '</div><div class="lbl">' + (run ? run.hits : 0) + ' / ' + total + '<br>notes hit</div></div>';
    if (!run) return h;
    if (run.recent.length >= 10) {
        const f = pct(run.recent.filter(Boolean).length, run.recent.length);
        const d = acc == null ? 0 : f - acc;
        const arrow = d >= 3 ? ' <span style="color:' + GOLD + '">▲</span>' : d <= -3 ? ' <span style="color:' + BLUE + '">▼</span>' : '';
        h += row('last ' + run.recent.length, '<b>' + f + '%</b>' + arrow, 'sc-detail');
    }
    const sp = pct(run.singles[0], run.singles[0] + run.singles[1]);
    const cp = pct(run.chords[0], run.chords[0] + run.chords[1]);
    if (sp != null) h += row('single notes', '<b>' + sp + '%</b>', 'sc-detail');
    if (cp != null) h += row('chords', '<b>' + cp + '%</b>', 'sc-detail');
    const pt = pitchTendency(run.pitch);
    if (pt) {
        const c = pt.word === 'in tune' ? WHITE : pt.cents > 0 ? ORANGE : BLUE;
        h += row('pitch', '<b style="color:' + c + '">' + (pt.word === 'in tune' ? '' : (pt.cents > 0 ? '+' : '') + pt.cents + '¢ ') + pt.word + '</b>', 'sc-detail');
    }
    const w = run.why, parts = [];
    if (w.unheard) parts.push(w.unheard + ' not heard');
    if (w.late) parts.push(w.late + ' late');
    if (w.early) parts.push(w.early + ' early');
    if (w.pitch) parts.push(w.pitch + ' pitch');
    if (w.chord) parts.push(w.chord + ' chord');
    if (parts.length) h += row('misses', '<span class="sc-why">' + parts.join(' · ') + '</span>', 'sc-detail');
    return h;
}

// ── drums / 5-fret (RockHeroSmith play:* input) ──
function playPerfHtml(P) {
    let h = '';
    if (P.players.length) {
        h += '<div class="sc-follow"><span class="lbl">following</span>' + P.players.map((p, i) =>
            '<button type="button" class="sc-btn' + (p.active ? ' on' : '') + '" data-act="follow" data-v="' + i + '"' +
            (p.active ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(p.label) + '</button>').join('') + '</div>';
    }
    const r = P.run;
    const total = r.hits + r.misses;
    const acc = total ? 100 * r.hits / total : null;
    h += '<div class="sc-head"><div class="sc-acc" style="color:' + accuracyColor(acc == null ? null : Math.floor(acc)) + '">' +
        (acc == null ? '–' : fmtPct2(acc)) + '</div><div class="lbl">' + r.hits + ' / ' + total + '<br>notes hit</div></div>';
    if (r.recent.length >= 10) {
        const f = pct(r.recent.filter(Boolean).length, r.recent.length);
        const d = acc == null ? 0 : f - acc;
        const arrow = d >= 3 ? ' <span style="color:' + GOLD + '">▲</span>' : d <= -3 ? ' <span style="color:' + BLUE + '">▼</span>' : '';
        h += row('last ' + r.recent.length, '<b>' + f + '%</b>' + arrow, 'sc-detail');
    }
    const w = r.why, parts = [];
    if (w.early) parts.push(w.early + ' early');
    if (w.late) parts.push(w.late + ' late');
    if (w.missed) parts.push(w.missed + ' missed');
    if (w.overhit) parts.push(w.overhit + ' ' + P.missWord);
    if (parts.length) h += row('misses', '<span class="sc-why">' + parts.join(' · ') + '</span>', 'sc-detail');
    return h;
}

function playTimingHtml(P) {
    const s = P.summary;
    let head, ticks = '', med = '', hint = '';
    if (!s || !s.samples) {
        head = 'timing: waiting for hits';
    } else {
        const n = s.errors.length;
        ticks = s.errors.map((ms, i) => '<i style="left:' + (gaugePos(ms) * 100).toFixed(1) + '%;background:' + timingCol(ms) +
            ';opacity:' + (0.25 + 0.75 * (i + 1) / n).toFixed(2) + '"></i>').join('');
        const c = timingCol(s.median);
        med = '<b style="left:' + (gaugePos(s.median) * 100).toFixed(1) + '%;background:' + c + ';box-shadow:0 0 6px ' + c + '"></b>';
        const word = s.cls === 'ontime' ? 'on time' : s.cls === 'early' ? 'EARLY' : 'LATE';
        head = 'timing <span class="sc-tword" style="color:' + c + '">' + (s.cls === 'ontime' ? '' : fmtMs(s.median) + ' ') + word +
            '</span> <span class="lbl">(median of ' + n + ')</span>';
        if (n >= MIN_N) {
            const L = s.latency;
            if (L && L.ok) {
                hint = '<span class="lbl">input offset ' + Math.round(P.offsetMs) + ' ms looks right</span>';
            } else if (L) {
                hint = (L.raise ? '▲ raise' : '▼ lower') + ' input offset ' + Math.round(P.offsetMs) + ' → <b style="color:' + OK + '">' +
                    L.value + ' ms</b>' + (L.atLimit ? ' (limit)' : '') +
                    (L.changes && P.canApply ? btn('off', 'Apply', L.value, 'Set the ' + P.where + ' input offset') : '');
            } else if (s.cls !== 'ontime') {
                const by = Math.abs(Math.round(s.median));
                hint = '<span class="lbl">' + (s.median > 0 ? 'raise' : 'lower') + ' the input offset by ' + by + ' ms (' +
                    esc(P.where) + ' settings)</span>';
            }
        }
    }
    return '<div class="sc-thead">' + head + '</div>' +
        '<div class="sc-gauge"><span class="mid"></span>' + ticks + med + '</div>' +
        '<div class="sc-legend"><span style="color:' + EARLY + '">early</span><span>' + RANGE_MS + ' ms</span><span style="color:' + LATE + '">late</span></div>' +
        (hint ? '<div class="sc-hint">' + hint + '</div>' : '');
}

function timingHtml(m) {
    const s = m.summary;
    let head, ticks = '', med = '', hint = '';
    if (!s || !s.samples) {
        head = s && s.byEar ? 'timing (by ear): waiting for notes' : 'timing: waiting for notes';
    } else {
        const n = s.errors.length;
        ticks = s.errors.map((ms, i) => '<i style="left:' + (gaugePos(ms) * 100).toFixed(1) + '%;background:' + timingCol(ms) +
            ';opacity:' + (0.25 + 0.75 * (i + 1) / n).toFixed(2) + '"></i>').join('');
        const c = timingCol(s.median);
        med = '<b style="left:' + (gaugePos(s.median) * 100).toFixed(1) + '%;background:' + c + ';box-shadow:0 0 6px ' + c + '"></b>';
        const word = s.cls === 'ontime' ? 'on time' : s.cls === 'early' ? 'EARLY' : 'LATE';
        head = (s.byEar ? 'by ear ' : 'timing ') + '<span class="sc-tword" style="color:' + c + '">' +
            (s.cls === 'ontime' ? '' : fmtMs(s.median) + ' ') + word + '</span> <span class="lbl">(median of ' + n + ')</span>';
        if (!s.byEar && n >= MIN_N) {
            if (m.latencyMs == null) {
                hint = '<span class="lbl">update Note Detection to get a latency suggestion</span>';
            } else if (s.latency && s.latency.ok) {
                hint = '<span class="lbl">latency offset ' + m.latencyMs + ' ms looks right</span>';
            } else if (s.latency) {
                const L = s.latency;
                hint = (L.raise ? '▲ raise' : '▼ lower') + ' Audio Latency Offset ' + m.latencyMs + ' → <b style="color:' + OK + '">' +
                    L.value + ' ms</b>' + (L.atLimit ? ' (slider limit)' : '') +
                    (L.changes ? (m.canApplyLatency ? btn('lat', 'Apply', L.value) : ' <span class="lbl">(set it in Note Detection)</span>') : '');
            }
        }
    }
    const av = m.avMs;
    let avHtml;
    const avTxt = 'A/V offset <b style="color:' + OK + '">' + (av == null ? '?' : Math.round(av) + ' ms') + '</b>';
    if (!s || !s.check) {
        avHtml = avTxt + (s && s.canCheck ? btn('check', 'A/V check', null, 'Compare playing by ear with playing by eye')
            : ' <span class="lbl">(A/V check after ' + MIN_N + ' notes)</span>');
    } else if (!s.check.result) {
        avHtml = '<b style="color:' + LATE + '">A/V check:</b> play by ear, eyes off the highway ' +
            s.check.progress + '/' + s.check.need + btn('cancel', 'cancel');
    } else {
        const r = s.check.result;
        if (r.ok) {
            avHtml = avTxt + ' <span class="lbl">ear vs eye ' + fmtMs(r.delta) + ': A/V looks right</span>' + btn('cancel', 'ok');
        } else {
            avHtml = 'by ear you play ' + fmtMs(r.delta) + (r.delta > 0 ? ' later' : ' earlier') + ' than by eye<br>' +
                (r.raise ? '▲ raise' : '▼ lower') + ' A/V offset ' + Math.round(av) + ' → <b style="color:' + OK + '">' + r.value + ' ms</b>' +
                (m.canApplyAv ? btn('av', 'Apply', r.value) : ' <span class="lbl">(set it in Settings)</span>') + btn('cancel', 'skip');
        }
    }
    const lm = m.lastMiss;
    const missHtml = lm ? '<div class="sc-tmiss" style="color:' + (lm.ms < 0 ? EARLY : LATE) + ';opacity:' + (1 - lm.age / 1500).toFixed(2) + '">miss: ' +
        (lm.ms < 0 ? 'EARLY ' : 'LATE ') + fmtMs(lm.ms) + '</div>' : '';
    return '<div class="sc-thead">' + head + '</div>' +
        '<div class="sc-gauge"><span class="mid"></span>' + ticks + med + '</div>' +
        '<div class="sc-legend"><span style="color:' + EARLY + '">early</span><span>' + RANGE_MS + ' ms</span><span style="color:' + LATE + '">late</span></div>' +
        (hint ? '<div class="sc-hint">' + hint + '</div>' : '') +
        '<div class="sc-av">' + avHtml + '</div>' + missHtml;
}

function spark(runs, best) {
    const pts = (runs || []).slice(0, 15).reverse();
    if (pts.length < 2) return '';
    const W = 270, H = 40, lo = Math.max(0, Math.min(...pts.map((r) => r.accuracy)) - 5), hi = 100;
    const x = (k) => 4 + k * (W - 8) / (pts.length - 1);
    const y = (a) => H - 4 - (a - lo) / Math.max(1, hi - lo) * (H - 8);
    const counted = (r) => r.complete && r.speed >= 0.999 && !r.looped;
    let svg = '<svg class="sc-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
    if (best != null) svg += '<line x1="0" x2="' + W + '" y1="' + y(best) + '" y2="' + y(best) + '" stroke="' + GOLD + '" stroke-opacity=".45" stroke-dasharray="3 3"/>';
    svg += '<polyline fill="none" stroke="#cbd5e1" stroke-opacity=".5" stroke-width="1.5" points="' + pts.map((r, k) => x(k) + ',' + y(r.accuracy)).join(' ') + '"/>';
    pts.forEach((r, k) => {
        const c = counted(r) ? (best != null && r.accuracy >= best ? GOLD : WHITE) : DIM;
        svg += '<circle cx="' + x(k) + '" cy="' + y(r.accuracy) + '" r="' + (counted(r) ? 3.2 : 2.2) + '" fill="' + c + '"><title>' +
            esc(r.ts) + ' — ' + r.accuracy + '%' + (counted(r) ? (r.misses ? '' : ' FULL COMBO') : ' (partial or slowed)') + '</title></circle>';
    });
    return svg + '</svg>';
}

// This song's history: best, best score, last run, pace vs best, plays, sparkline.
function historyHtml(run, song, title) {
    const total = run ? run.hits + run.misses : 0;
    const live = total > 0 ? 100 * run.hits / total : null;
    let h = '';
    if (total >= 10 && run.misses === 0) h += '<div class="sc-fc">★ FULL COMBO</div>';
    if (title && !song) h += '<div class="sc-sub">' + title + '</div>';
    if (song) {
        const best = song.best ? song.best.accuracy : null;
        const last = song.runs && song.runs.length ? song.runs[0].accuracy : null;
        h += '<div class="sc-sub">' + (title || 'This song') + '</div>';
        h += row('best', '<b class="sc-big" style="color:' + GOLD + '">' + (best != null ? fmtPct2(best) : '–') + '</b>');
        if (song.best_score) h += row('best score', '<b style="color:' + GOLD + '">' + fmtInt(song.best_score.score) + '</b>');
        if (last != null) h += row('last run', '<b>' + fmtPct2(last) + '</b>');
        if (best != null && live != null && total >= 10) {
            const d = live - best;
            h += row('pace vs best', '<b style="color:' + (d >= 0 ? GOLD : BLUE) + '">' + (d >= 0 ? '▲ +' : '▼ ') + d.toFixed(2) + '%</b>');
        }
        if (song.core && song.core.plays) h += row('plays', '<b>' + fmtInt(song.core.plays) + '</b>');
        h += spark(song.runs || [], best);
    }
    return h;
}

function playSongHtml(P) {
    return historyHtml(P.run, P.song, 'This song · ' + esc(P.label));
}

function songHtml(m) {
    const { run, song, sec, pass } = m;
    const total = run ? run.hits + run.misses : 0;
    const live = total > 0 ? 100 * run.hits / total : null;
    let h = historyHtml(run, song, null);
    if (sec) {
        const sb = song && song.section_best ? song.section_best[sec.key] : null;
        const now = pass ? pct(pass.h, pass.h + pass.m) : null;
        h += '<div class="sc-sub">Section · <span class="sc-secname">' + esc(sec.label) + '</span></div>';
        h += row('this pass', '<b style="color:' + levelColor(now) + '">' + (now != null ? now + '%' : '–') + '</b>');
        h += row('section best', '<b style="color:' + GOLD + '">' + (sb != null ? sb + '%' : '–') + '</b>');
    }
    if (run) {
        const weak = weakSpots(run.tech, 4, 3).filter((x) => live == null || x.p < live - 5);
        const bars = stringBars(run.strings, run.bass, false);
        if (weak.length || bars) h += '<div class="sc-sub">Weak spots</div>';
        for (const x of weak) {
            h += row(esc(x.name), '<b style="color:' + levelColor(x.p) + '">' + x.p + '%</b><span class="lbl sc-small">(' + x.h + '/' + x.n + ')</span>');
        }
        if (bars) h += row('strings', bars, 'sc-bars');
    }
    return h;
}

export function createCard(onAction) {
    const card = el('div', 'sc-card');
    const colA = el('div', 'sc-col sc-col-a');
    const colB = el('div', 'sc-col sc-col-b');
    const perf = el('div', 'sc-perf');
    const timing = el('div', 'sc-timing');
    const song = el('div', 'sc-song');
    colA.append(perf, timing);
    colB.append(song);
    const modeBtn = el('button', 'sc-mode');
    modeBtn.type = 'button';
    modeBtn.dataset.act = 'mode';
    card.append(modeBtn, colA, colB);
    card.addEventListener('click', (ev) => {
        const b = ev.target && ev.target.closest ? ev.target.closest('button[data-act]') : null;
        if (!b || !card.contains(b)) return;
        ev.stopPropagation();
        onAction(b.dataset.act, b.dataset.v != null ? Number(b.dataset.v) : null);
    });
    return {
        el: card,
        update(m) {
            if (m.play) {
                setHtml(perf, playPerfHtml(m.play));
                setHtml(timing, playTimingHtml(m.play));
                setHtml(song, playSongHtml(m.play));
            } else {
                setHtml(perf, perfHtml(m.run));
                setHtml(timing, timingHtml(m));
                setHtml(song, songHtml(m));
            }
            const label = 'card: ' + m.mode;
            if (modeBtn.textContent !== label) {
                modeBtn.textContent = label;
                modeBtn.title = 'Scorecard size. auto = compact while in a multiplayer room, full otherwise. Click to cycle auto → compact → full.';
            }
        },
    };
}
