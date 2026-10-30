// Left-side streak / multiplier / score box, the "on fire" highway glow, the
// solo meter + glow, and popups. Elements are created once; updates only
// write cached nodes, and only when a value changed.

import { COLORS, MULT_COLORS, fireColor, el, setHtml, setText, fmtInt } from './dom.js';
import { pipsFor } from '../engine/score.js';

const { gold: GOLD, blue: BLUE, dim: DIM, white: WHITE, orange: ORANGE } = COLORS;

export function createHud() {
    const streak = el('div', 'sc-streak',
        '<div class="sc-num">0</div><div class="sc-cap">NOTE STREAK</div><div class="sc-mult">×1</div>' +
        '<div class="sc-pips">' + '<i></i>'.repeat(10) + '</div><div class="sc-best"></div>' +
        '<div class="sc-score"><div class="sc-pts">0</div><div class="sc-cap2">SCORE</div><div class="sc-tags"></div><div class="sc-feed"></div></div>');
    const fire = el('div', 'sc-fire', '<div></div>');
    const soloGlow = el('div', 'sc-solo-glow');
    const solo = el('div', 'sc-solo', '<div class="sc-solo-lbl">SOLO</div><div class="sc-solo-pct">100%</div>' +
        '<div class="sc-solo-bar"><div></div></div><div class="sc-solo-cnt"></div>');
    const pops = el('div', 'sc-pops');

    const r = {
        num: streak.querySelector('.sc-num'), mult: streak.querySelector('.sc-mult'),
        pips: Array.from(streak.querySelectorAll('.sc-pips i')), best: streak.querySelector('.sc-best'),
        pts: streak.querySelector('.sc-pts'), tags: streak.querySelector('.sc-tags'), feed: streak.querySelector('.sc-feed'),
        fireInner: fire.firstChild,
        soloPct: solo.querySelector('.sc-solo-pct'), soloBar: solo.querySelector('.sc-solo-bar > div'),
        soloCnt: solo.querySelector('.sc-solo-cnt'),
    };
    let last = { streak: -1, fire: null, mult: 0 };

    function updateStreak(s, mult, bestText) {
        if (s !== last.streak || mult !== last.mult) {
            last.streak = s;
            last.mult = mult;
            // ×1–×4 colours; RockHeroSmith's overdrive multipliers (×5+) keep the ×4 colour.
            const mc = MULT_COLORS[Math.max(1, Math.min(MULT_COLORS.length, Math.round(mult) || 1)) - 1];
            const fc = fireColor(s);
            streak.classList.toggle('idle', s === 0);
            setText(r.num, String(s));
            r.num.style.color = fc || (s >= 10 ? mc : WHITE);
            setText(r.mult, '×' + mult);
            r.mult.style.color = mc;
            const lit = pipsFor(s);
            r.pips.forEach((p, i) => {
                p.style.background = i < lit ? mc : '';
                p.style.boxShadow = i < lit ? '0 0 6px ' + mc : '';
            });
            if (fc !== last.fire) {
                last.fire = fc;
                if (fc) {
                    r.fireInner.style.boxShadow = 'inset 0 0 90px 14px ' + fc + 'aa, inset 0 0 22px 2px ' + fc;
                    r.fireInner.style.background = 'linear-gradient(to top, ' + fc + '40, transparent 45%)';
                }
                fire.classList.toggle('on', !!fc);
            }
        }
        setText(r.best, bestText);
    }

    function updateScore(score, tags, feed) {
        setText(r.pts, fmtInt(score));
        setHtml(r.tags, tags.map(([s, c]) => '<span class="sc-tag" style="color:' + c + ';border-color:' + c + '66">' + s + '</span>').join(''));
        setHtml(r.feed, feed.map((x) => '<div style="color:' + x.color + ';opacity:' + x.opacity.toFixed(2) + '">' + x.text + '</div>').join(''));
    }

    function updateSolo(live, inSolo) {
        soloGlow.classList.toggle('on', !!inSolo);
        if (!live) { solo.classList.remove('on'); return; }
        const p = live.n ? 100 * live.h / live.n : 100;
        setText(r.soloPct, Math.round(p) + '%');
        r.soloPct.style.color = p >= 100 ? GOLD : p >= 90 ? '#8fd3ff' : WHITE;
        r.soloBar.style.width = p + '%';
        setText(r.soloCnt, live.n ? live.h + ' / ' + live.n + ' notes' : live.name);
        solo.classList.add('on');
    }

    function popup(text, color, small) {
        const p = el('div', 'sc-pop' + (small ? ' small' : ''));
        p.style.color = color || GOLD;
        p.textContent = text;
        pops.appendChild(p);
        while (pops.childElementCount > 4) pops.firstElementChild.remove();
        if (!p.animate) { setTimeout(() => p.remove(), 1600); return; }
        const a = p.animate(small
            ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }]
            : [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' },
                { opacity: 1, transform: 'translate(-50%,-50%) scale(1.12)', offset: 0.15 },
                { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.3 },
                { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.75 },
                { opacity: 0, transform: 'translate(-50%,-50%) scale(1.05)' }],
            { duration: small ? 1600 : 2000, easing: 'ease-out' });
        a.onfinish = () => p.remove();
    }

    function reset() {
        last = { streak: -1, fire: null, mult: 0 };
        fire.classList.remove('on');
        solo.classList.remove('on');
        soloGlow.classList.remove('on');
        pops.textContent = '';
    }

    return { els: [fire, soloGlow, streak, solo, pops], updateStreak, updateScore, updateSolo, popup, reset,
        colors: { GOLD, BLUE, DIM, WHITE, ORANGE, PURPLE: COLORS.purple } };
}
