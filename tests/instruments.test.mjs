// Drums / 5-fret through RockHeroSmith's play:* events: boots main.js against
// fakes (no DOM) and drives the core bus.
import test from 'node:test';
import assert from 'node:assert/strict';

function fakeEl(tag) {
    const listeners = {};
    const store = { tagName: tag, hidden: false, isConnected: false, className: '', textContent: '', innerHTML: '',
        style: { setProperty() {}, getPropertyValue: () => '' }, dataset: {}, attrs: {}, listeners, animate: () => ({}),
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    return new Proxy(store, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'symbol') return undefined;
            if (k === 'append' || k === 'appendChild') return (...a) => { for (const c of a) if (c && typeof c === 'object') c.isConnected = true; return a[0]; };
            if (k === 'addEventListener') return (n, f) => { (listeners[n] ||= []).push(f); };
            if (k === 'toggleAttribute') return (n, on) => { if (on) t.attrs[n] = ''; else delete t.attrs[n]; };
            if (k === 'contains') return () => true;
            if (k === 'querySelector') return () => fakeEl('q');
            if (k === 'firstChild') return (t.firstChild = fakeEl('child'));
            if (k === 'getContext') return () => null;
            if (k === 'querySelectorAll') return () => [];
            return () => undefined;
        },
        set(t, k, v) { t[k] = v; return true; },
    });
}

let seq = 0;
async function boot(opts = {}) {
    const listeners = {};
    const handlers = {};
    const emitted = [];
    const holds = { n: 0 };
    const w = {
        __feedBackScorecard: undefined,
        addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
        innerHeight: 900,
        feedBack: {
            on: (n, f) => { (handlers[n] ||= []).push(f); },
            emit: (n, d) => { emitted.push([n, d]); },
            currentSong: { filename: 'a.sloppak', title: 'T', artist: 'A', arrangement: opts.arrangement || 'Drums' },
            holdAutoExit: () => { holds.n++; return () => {}; },
        },
        ...(opts.win || {}),
    };
    const created = [];
    const player = fakeEl('player');
    player.classList = { add() {}, remove() {}, toggle() {}, contains: (c) => c === 'active' };
    const doc = {
        createElement: (tag) => { const e = fakeEl(tag); created.push(e); return e; },
        getElementById: (id) => (id === 'player' ? player : null),
        querySelector: () => null,
        documentElement: { dataset: {} },
    };
    const calls = [];
    const songRecord = opts.song || { runs: [], best: null, best_streak: 0 };
    const saved = {};
    const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
    set('window', w);
    set('document', doc);
    set('localStorage', { getItem: () => null, setItem() {} });
    set('requestAnimationFrame', (f) => { f(); return 0; });
    set('setInterval', () => 1);
    set('clearInterval', () => {});
    set('fetch', (url, init) => {
        calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
        const json = String(url).includes('/run') ? { ok: true, accuracy: 90, ...songRecord } : songRecord;
        return Promise.resolve({ ok: true, json: async () => json });
    });
    await import('../src/main.js?inst=' + (++seq));
    const bus = (n, d) => { for (const f of handlers[n] || []) f({ detail: d }); };
    const byClass = (c) => created.filter((e) => String(e.className).split(' ').includes(c));
    const html = (c) => byClass(c).map((e) => e.innerHTML).join('');
    const pops = () => byClass('sc-pop').map((e) => e.textContent);
    const root = () => byClass('sc-root')[0];
    const restore = () => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } };
    bus('screen:changed', { id: 'player' });
    return { w, bus, listeners, calls, emitted, holds, html, pops, root, byClass, restore, flush: () => new Promise((r) => setTimeout(r, 5)) };
}

const START = { sessionId: 's1', filename: 'a.sloppak', title: null, artist: null, band: false,
    players: [{ player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert', canvas: null }] };
const jd = (o) => ({ sessionId: 's1', filename: 'a.sloppak', player: 'drums', instrument: 'drums', part: 'drums', input: 'kit',
    kind: 'hit', points: 25, multiplier: 1, streak: 1, t: 1, noteTime: 1, offsetMs: 0, timing: 'on', canvas: null, local: true, ...o });
const hits = (env, n, from = 1, o = {}) => { for (let i = from; i < from + n; i++) env.bus('play:judgment', jd({ t: i, streak: i, ...o })); };

test('a drums session shows the HUD from play:judgment, even while RockHeroSmith hides the guitar HUD', async () => {
    const env = await boot();
    try {
        env.w.feedBackScorecard.setHudHidden(true);   // what RHS does at mount
        assert.equal(env.root().hidden, true);
        env.bus('play:session-start', START);
        hits(env, 30);
        assert.equal(env.root().hidden, false);
        const p = env.w.feedBackScorecard.getPlay();
        assert.equal(p.player, 'drums');
        assert.equal(p.streak, 30);
        assert.equal(p.score, 750);
        assert.match(env.html('sc-perf'), /100\.00%/);
        assert.doesNotMatch(env.html('sc-perf'), /pitch|single notes|chords/);
        assert.equal(env.root().attrs['data-play'], '');
        assert.equal(env.root().attrs['data-compact'], '', 'auto is compact on a solo lane too: the full card covered its HUD');
        await env.flush();
        const songCall = env.calls.find((c) => c.url.includes('/song?'));
        assert.match(songCall.url, /part=drums/);
        assert.match(songCall.url, /difficulty=expert/);
        assert.match(env.html('sc-song'), /Drums · Expert/);
    } finally { env.restore(); }
});

test('milestones, streak ended and NEW SONG BEST STREAK come from the play input', async () => {
    const env = await boot({ song: { runs: [], best: { accuracy: 80 }, best_streak: 30 } });
    try {
        env.bus('play:session-start', START);
        await env.flush();
        hits(env, 50);
        assert.ok(env.pops().includes('NEW SONG BEST STREAK!'));
        assert.ok(env.pops().includes('50 NOTE STREAK!'));
        env.bus('play:judgment', jd({ kind: 'miss', points: 0, streak: 0, t: 51, offsetMs: null, timing: null }));
        assert.ok(env.pops().includes('streak ended at 50'));
        assert.match(env.html('sc-song'), /pace vs best/);
    } finally { env.restore(); }
});

test('miss reasons for drums as RockHeroSmith sends them: missed, overhits; no guitar-only reasons', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 10);
        // RockHeroSmith (C1): offsetMs / timing only on hits; misses and overhits carry null.
        env.bus('play:judgment', jd({ kind: 'miss', points: 0, streak: 0, t: 11, offsetMs: null, timing: null }));
        env.bus('play:judgment', jd({ kind: 'miss', points: 0, streak: 0, t: 12, offsetMs: null, timing: null }));
        env.bus('play:judgment', jd({ kind: 'overhit', points: 0, streak: 0, t: 12.5, offsetMs: null, timing: null }));
        const h = env.html('sc-perf');
        assert.match(h, /2 missed/);
        assert.match(h, /1 overhits/);
        assert.doesNotMatch(h, /early|late/);
        assert.doesNotMatch(h, /not heard|pitch|chord/);
    } finally { env.restore(); }
});

test('instruments() lists what the HUD draws', async () => {
    const env = await boot();
    try { assert.deepEqual(env.w.feedBackScorecard.instruments(), ['guitar', 'drums', 'five_fret']); } finally { env.restore(); }
});

test('a guitar player in the session is left to Note Detection', async () => {
    const env = await boot({ arrangement: 'Lead' });
    try {
        env.bus('play:session-start', { ...START, players: [{ player: 'guitar', instrument: 'guitar', part: 'lead', input: 'mic', difficulty: '' }] });
        env.bus('play:judgment', jd({ player: 'guitar', instrument: 'guitar', part: 'lead' }));
        assert.equal(env.w.feedBackScorecard.getPlay(), null);
        // Note Detection still drives the guitar run.
        const detail = (i) => ({ hit: true, noteTime: i, counted: true, isDefault: true, note: { s: 0, f: 1 }, timingState: 'OK', timingError: 0 });
        for (let i = 0; i < 3; i++) for (const f of env.listeners['notedetect:hit']) f({ detail: detail(i) });
        assert.equal(env.w.feedBackScorecard.getRun().hits, 3);
    } finally { env.restore(); }
});

test('band: follows the first local non-guitar player; the picker switches', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', { ...START, band: true, players: [
            { player: 'guitar', instrument: 'guitar', part: 'lead', input: 'mic' },
            { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'hard' },
            { player: 'ctl1', instrument: 'five_fret', part: 'bass', input: 'controller', difficulty: 'expert' },
        ] });
        hits(env, 5);
        env.bus('play:judgment', jd({ player: 'ctl1', instrument: 'five_fret', part: 'bass', input: 'controller', streak: 1, t: 1 }));
        assert.equal(env.w.feedBackScorecard.getPlay().player, 'drums');
        assert.equal(env.root().attrs['data-compact'], '', 'auto is compact in a band');
        assert.match(env.html('sc-perf'), /data-act="follow"/);
        const card = env.byClass('sc-card')[0];
        const btn = { dataset: { act: 'follow', v: '1' } };
        for (const f of card.listeners.click) f({ target: { closest: () => btn }, stopPropagation() {} });
        const p = env.w.feedBackScorecard.getPlay();
        assert.equal(p.player, 'ctl1');
        assert.equal(p.streak, 1);
        await env.flush();
        assert.ok(env.calls.some((c) => c.url.includes('part=five_fret%3Abass')));
        assert.match(env.html('sc-perf'), /overstrums|5-Fret Bass/);
    } finally { env.restore(); }
});

test('play:rewind drops judgments after t', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 30);
        env.bus('play:rewind', { sessionId: 's1', t: 10.5 });
        const p = env.w.feedBackScorecard.getPlay();
        assert.equal(p.streak, 10);
        assert.equal(p.hits, 10);
        assert.equal(p.score, 250);
    } finally { env.restore(); }
});

test('play:result records the run per part + difficulty; RockHeroSmith owns the end of the song', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 30);
        env.bus('song:ended');
        assert.equal(env.holds.n, 0, 'no results hold for a drums session');
        const result = { sessionId: 's1', filename: 'a.sloppak', band: false, practice: false, durationSec: 120, players: [
            { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert', score: 750, stars: 5,
                accuracy: 1, hits: 30, misses: 0, overhits: 0, bestStreak: 30, fullCombo: true, failed: false, sections: [] },
            { player: 'guitar', instrument: 'guitar', part: 'lead', input: 'mic', difficulty: '', score: 1, accuracy: 1, hits: 30, misses: 0 },
        ] };
        env.bus('play:result', result);
        env.bus('play:result', result);   // a re-fire is not a second run
        env.bus('play:session-end', { sessionId: 's1', reason: 'results' });   // C1's order
        await env.flush();
        const posts = env.calls.filter((c) => c.url.endsWith('/run'));
        assert.equal(posts.length, 1);
        assert.equal(posts[0].body.part, 'drums');
        assert.equal(posts[0].body.difficulty, 'expert');
        assert.equal(posts[0].body.score, 750);
        assert.equal(posts[0].body.arrangement, '');
        assert.equal(env.byClass('sc-end')[0].hidden, true, 'no Scorecard end card');
        assert.equal(env.root().hidden, true, 'the HUD steps aside for the results screen');
        assert.ok(env.emitted.some(([n]) => n === 'scorecard:run'));
    } finally { env.restore(); }
});

test('practice results are not recorded; session-end hides the instrument HUD', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 30);
        env.bus('play:result', { sessionId: 's1', practice: true, players: [{ player: 'drums', instrument: 'drums', part: 'drums', hits: 30, misses: 0 }] });
        await env.flush();
        assert.equal(env.calls.filter((c) => c.url.endsWith('/run')).length, 0);
        env.bus('play:session-end', { sessionId: 's1', reason: 'left' });
        assert.equal(env.w.feedBackScorecard.getPlay(), null);
        assert.equal(env.root().hidden, true);
    } finally { env.restore(); }
});

test('timing gauge from offsetMs; Apply sets the drums input offset', async () => {
    const sets = [];
    const cfg = { inputOffsetMs: 10 };
    const env = await boot({ win: {
        __drumsSetInputOffset: (ms) => { sets.push(ms); cfg.inputOffsetMs = ms; return ms; },
        __drumsGetConfig: () => ({ ...cfg }),
    } });
    try {
        env.bus('play:session-start', START);
        hits(env, 8, 1, { offsetMs: 30, timing: 'late' });
        const t = env.html('sc-timing');
        assert.match(t, /input offset 10 → <b[^>]*>40 ms/);
        assert.match(t, /data-act="off" data-v="40"/);
        assert.doesNotMatch(t, /A\/V/, 'the A/V check stays guitar-only');
        const card = env.byClass('sc-card')[0];
        const btn = { dataset: { act: 'off', v: '40' } };
        for (const f of card.listeners.click) f({ target: { closest: () => btn }, stopPropagation() {} });
        assert.deepEqual(sets, [40]);
        assert.match(env.html('sc-timing'), /input offset 40 ms looks right/);
    } finally { env.restore(); }
});

test('no offset setter: no Apply, a hint instead', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 8, 1, { offsetMs: -30, timing: 'early' });
        const t = env.html('sc-timing');
        assert.doesNotMatch(t, /data-act="off"/);
        assert.match(t, /lower the input offset by 30 ms/);
    } finally { env.restore(); }
});

test('5-fret Apply goes through the controller offset and tells the renderers', async () => {
    const saved = {};
    const env = await boot({ win: {
        feedBackFiveFret: { getInstanceState: () => ({ controllerKey: 'gp#1' }) },
        FiveFretProfiles: { loadSettings: () => ({ offsetMs: { ...saved } }), setOffset: (k, v) => { saved[k] = v; } },
    } });
    try {
        env.bus('play:session-start', { ...START, players: [{ player: 'ctl1', instrument: 'five_fret', part: 'guitar', input: 'controller', difficulty: 'expert' }] });
        for (let i = 1; i <= 8; i++) env.bus('play:judgment', jd({ player: 'ctl1', instrument: 'five_fret', part: 'guitar', input: 'controller', t: i, streak: i, offsetMs: 22, timing: 'late' }));
        assert.match(env.html('sc-timing'), /data-act="off" data-v="20"/, 'rounded to the 5 ms step');
        const card = env.byClass('sc-card')[0];
        for (const f of card.listeners.click) f({ target: { closest: () => ({ dataset: { act: 'off', v: '20' } }) }, stopPropagation() {} });
        assert.equal(saved['gp#1'], 20);
        assert.ok(env.emitted.some(([n, d]) => n === 'five_fret:offset-changed' && d.controllerKey === 'gp#1' && d.offsetMs === 20));
    } finally { env.restore(); }
});

test('a Note Detection guitar run inside a RockHeroSmith session never claims the end of the song', async () => {
    const env = await boot({ arrangement: 'Lead' });
    try {
        env.bus('play:session-start', { ...START, band: true, players: [
            { player: 'guitar', instrument: 'guitar', part: 'lead', input: 'mic' },
            { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert' },
        ] });
        const detail = (i) => ({ hit: true, noteTime: i, counted: true, isDefault: true, note: { s: 0, f: 1 }, timingState: 'OK', timingError: 0 });
        for (let i = 0; i < 25; i++) for (const f of env.listeners['notedetect:hit']) f({ detail: detail(i) });
        env.bus('song:ended');
        await env.flush();
        assert.equal(env.holds.n, 0);
        assert.equal(env.byClass('sc-end')[0].hidden, true);
        assert.ok(env.calls.some((c) => c.url.endsWith('/run') && c.body.arrangement === 'Lead'), 'the guitar run is still saved');
    } finally { env.restore(); }
});

test('RHS ends the session before Scorecard sees song:ended: still no hold, card or guitar popups', async () => {
    const env = await boot({ arrangement: 'Lead' });
    try {
        env.bus('play:session-start', { ...START, band: true, players: [
            { player: 'guitar', instrument: 'guitar', part: 'lead', input: 'mic' },
            { player: 'drums', instrument: 'drums', part: 'drums', input: 'kit', difficulty: 'expert' },
        ] });
        hits(env, 5);
        const detail = (i) => ({ hit: true, noteTime: i, counted: true, isDefault: true, note: { s: 0, f: 1 }, timingState: 'OK', timingError: 0 });
        for (let i = 0; i < 25; i++) for (const f of env.listeners['notedetect:hit']) f({ detail: detail(i) });
        // RHS's own song:ended handler ran first.
        env.bus('play:result', { sessionId: 's1', practice: false, players: [] });
        env.bus('play:session-end', { sessionId: 's1', reason: 'results' });
        env.bus('song:ended');
        await env.flush();
        assert.equal(env.holds.n, 0);
        assert.equal(env.byClass('sc-end')[0].hidden, true);
        assert.ok(!env.pops().some((t) => /FULL COMBO|NEW BEST/.test(t)));
        // The next song is a plain guitar song again.
        env.bus('song:loading');
        for (let i = 0; i < 25; i++) for (const f of env.listeners['notedetect:hit']) f({ detail: detail(i) });
        env.bus('song:ended');
        assert.equal(env.holds.n, 1);
    } finally { env.restore(); }
});

test('solo session: no SCORE row (the lane HUD shows it); band: the followed player\'s score shows', async () => {
    const env = await boot();
    try {
        env.bus('play:session-start', START);
        hits(env, 3);
        assert.equal(env.root().attrs['data-play-solo'], '');
        env.bus('play:session-start', { ...START, sessionId: 's2', band: true, players: [
            ...START.players, { player: 'ctl1', instrument: 'five_fret', part: 'bass', input: 'controller', difficulty: 'expert' }] });
        hits(env, 3, 1, { sessionId: 's2' });
        assert.equal(env.root().attrs['data-play-solo'], undefined);
    } finally { env.restore(); }
});

for (const order of ['before', 'after']) {
    test(`setHudHidden(true) ${order} session-start keeps the drums HUD`, async () => {
        const env = await boot();
        try {
            if (order === 'before') env.w.feedBackScorecard.setHudHidden(true);
            env.bus('play:session-start', START);
            if (order === 'after') env.w.feedBackScorecard.setHudHidden(true);
            hits(env, 3);
            if (order === 'after') env.w.feedBackScorecard.setHudHidden(true);
            assert.equal(env.root().hidden, false);
            assert.equal(env.w.feedBackScorecard.getPlay().streak, 3);
            env.w.feedBackScorecard.setHudHidden(false);
            assert.equal(env.root().hidden, false);
        } finally { env.restore(); }
    });
}
