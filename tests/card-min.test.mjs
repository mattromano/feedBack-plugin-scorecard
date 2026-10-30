import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
};

const { miniLabel } = await import('../src/ui/card.js');

test('miniLabel: the accuracy so far, or a dash before any judged note', () => {
    assert.equal(miniLabel(null), '–');
    assert.equal(miniLabel({ hits: 0, misses: 0 }), '–');
    assert.equal(miniLabel({ hits: 18, misses: 9 }), '66.67%');
});

test('cardMin: off by default, kept as a boolean, persisted', async () => {
    store.set('scorecard.settings.v1', JSON.stringify({ mode: 'full', cardMin: 'yes' }));
    const { getSettings, setSetting } = await import('../src/settings.js');
    assert.equal(getSettings().cardMin, false);
    setSetting('cardMin', true);
    assert.equal(JSON.parse(store.get('scorecard.settings.v1')).cardMin, true);
    assert.equal(getSettings().mode, 'full');
});
