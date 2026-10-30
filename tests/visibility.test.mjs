import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsHud, claimsResults } from '../src/visibility.js';

const base = { onPlayer: true, mode: 'full', isDrums: false, hasRun: true, frozen: false, ndEnabled: true, hudHidden: false };

test('wantsHud matches the old rule and hudHidden wins', () => {
    assert.equal(wantsHud(base), true);
    assert.equal(wantsHud({ ...base, hudHidden: true }), false);
    assert.equal(wantsHud({ ...base, mode: 'off' }), false);
    assert.equal(wantsHud({ ...base, isDrums: true }), false);
});

test('wantsHud: a followed drums / 5-fret player shows on drums and through hudHidden, not when off', () => {
    assert.equal(wantsHud({ ...base, isDrums: true, playing: true, hasRun: false, ndEnabled: false }), true);
    assert.equal(wantsHud({ ...base, hudHidden: true, playing: true }), true);
    assert.equal(wantsHud({ ...base, mode: 'off', playing: true }), false);
    assert.equal(wantsHud({ ...base, onPlayer: false, playing: true }), false);
});

test('claimsResults needs enough judgments, a mode and no hide', () => {
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'full', hudHidden: false }), true);
    assert.equal(claimsResults({ judged: 4, minJudged: 5, mode: 'full', hudHidden: false }), false);
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'full', hudHidden: true }), false);
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'off', hudHidden: false }), false);
    assert.equal(claimsResults({ judged: 10, minJudged: 5, mode: 'full', hudHidden: false, playSession: true }), false,
        'RockHeroSmith\'s results own the end of a play:* session');
});

// ── behavioural: boot main.js against fakes ──
function fakeEl(tag) {
    const store = { tagName: tag, hidden: false, isConnected: false, style: { setProperty() {}, getPropertyValue: () => '' }, dataset: {}, children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    const p = new Proxy(store, {
        get(t, k) {
            if (k in t) return t[k];
            if (typeof k === 'symbol') return undefined;
            if (k === 'append' || k === 'appendChild') return (...a) => { for (const c of a) if (c && typeof c === 'object') c.isConnected = true; return a[0]; };
            if (k === 'contains') return () => false;
            if (k === 'querySelector' || k === 'getContext') return () => null;
            if (k === 'querySelectorAll') return () => [];
            return () => undefined;
        },
        set(t, k, v) { t[k] = v; return true; },
    });
    return p;
}

let seq = 0;
async function boot() {
    const listeners = {};
    const bus = {};
    const handlers = {};
    const releases = { n: 0 };
    const w = {
        __feedBackScorecard: undefined,
        addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
        innerHeight: 900,
        feedBack: {
            on: (n, f) => { handlers[n] = f; },
            emit() {},
            currentSong: { filename: 'a.psarc', title: 'T', arrangement: 'Lead' },
            holdAutoExit: () => () => { releases.n++; },
        },
    };
    const created = [];
    const body = fakeEl('body');
    const player = fakeEl('player');
    player.classList = { add() {}, remove() {}, toggle() {}, contains: (c) => c === 'active' };
    const doc = {
        createElement: (tag) => { const e = fakeEl(tag); created.push(e); return e; },
        getElementById: (id) => (id === 'player' ? player : null),
        querySelector: () => null,
        body,
        documentElement: { dataset: {} },
    };
    let resolveFetch;
    const saved = {};
    const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
    set('window', w);
    set('document', doc);
    set('localStorage', { getItem: () => null, setItem() {} });
    set('requestAnimationFrame', () => 0);
    set('setInterval', () => 1);
    set('clearInterval', () => {});
    set('fetch', () => new Promise((res) => {
        resolveFetch = () => res({ ok: true, json: async () => ({ ok: true, accuracy: 90 }) });
    }));
    await import('../src/main.js?vis=' + (++seq));
    const detail = (hit, i) => ({ hit, noteTime: i, time: i, counted: true, isDefault: true, note: { s: 0, f: 1 }, timingState: 'OK', pitchState: 'OK', timingError: 0, pitchError: 0 });
    const judge = (n) => { for (let i = 0; i < n; i++) for (const f of listeners['notedetect:hit']) f({ detail: detail(true, i) }); };
    const restore = () => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } };
    const endCard = () => created.find((e) => e.className === 'sc-end');
    return { w, handlers, releases, judge, restore, flush: () => new Promise((r) => setTimeout(r, 5)), resolveFetch: () => resolveFetch(), endCard };
}

test('hide set after the claim: postRun resolves, hold released, no card', async () => {
    const env = await boot();
    try {
        env.handlers['screen:changed']({ detail: { id: 'player' } });
        env.judge(25);
        env.handlers['song:ended']();
        assert.equal(env.releases.n, 0);
        assert.equal(env.w.feedBackScorecard.setHudHidden(true), true);
        env.resolveFetch();
        await env.flush();
        assert.equal(env.releases.n, 1);
        assert.equal(env.endCard().hidden, true);
        assert.equal(env.endCard().isConnected, false);
    } finally { env.restore(); }
});

test('card open, then setHudHidden(true): card closes and the hold is released', async () => {
    const env = await boot();
    try {
        env.handlers['screen:changed']({ detail: { id: 'player' } });
        env.judge(25);
        env.handlers['song:ended']();
        env.resolveFetch();
        await env.flush();
        assert.equal(env.releases.n, 0);   // card showing holds the exit
        assert.equal(env.endCard().hidden, false);
        assert.equal(env.w.feedBackScorecard.setHudHidden(true), true);
        assert.equal(env.endCard().hidden, true);
        assert.equal(env.releases.n, 1);
        assert.equal(env.w.feedBackScorecard.isHudHidden(), true);
    } finally { env.restore(); }
});

test('hidden at song end, shown again (band teardown) before postRun resolves: no card', async () => {
    const env = await boot();
    try {
        env.handlers['screen:changed']({ detail: { id: 'player' } });
        assert.equal(env.w.feedBackScorecard.setHudHidden(true), true);
        env.judge(25);
        env.handlers['song:ended']();
        assert.equal(env.w.feedBackScorecard.setHudHidden(false), true);
        env.resolveFetch();
        await env.flush();
        assert.equal(env.endCard().hidden, true);
        assert.equal(env.endCard().isConnected, false);
        assert.equal(env.releases.n, 0, 'no hold was claimed while hidden');
    } finally { env.restore(); }
});

test('the song changed before postRun resolves: no card, hold released', async () => {
    const env = await boot();
    try {
        env.handlers['screen:changed']({ detail: { id: 'player' } });
        env.judge(25);
        env.handlers['song:ended']();
        env.w.feedBack.currentSong = { filename: 'b.psarc', title: 'U', arrangement: 'Lead' };
        env.resolveFetch();
        await env.flush();
        assert.equal(env.endCard().hidden, true);
        assert.equal(env.releases.n, 1);
    } finally { env.restore(); }
});
