// The A/V check's Apply is the user's click: it must pass 'manual', or core
// ignores it once the offset is locked (set by hand or by Calibrate).
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const host = await import('../src/host.js');

test("applyAvMs passes 'manual' and reports whether core applied it", () => {
    const calls = [];
    window.setAvOffsetMs = (...a) => { calls.push(a); return true; };
    assert.equal(host.applyAvMs(-23), true);
    assert.deepEqual(calls, [[-23, false, 'manual']]);
    window.setAvOffsetMs = () => false;
    assert.equal(host.applyAvMs(5), false, 'core ignored it');
    delete window.setAvOffsetMs;
    assert.equal(host.applyAvMs(5), false, 'no host setter');
});
