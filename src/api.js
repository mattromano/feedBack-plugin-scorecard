// Client for the plugin's own routes (routes.py).

const BASE = '/api/plugins/scorecard';

export async function fetchSong(filename, arrangement) {
    const q = new URLSearchParams({ filename, arrangement: arrangement || '' });
    const r = await fetch(BASE + '/song?' + q.toString());
    if (!r.ok) throw new Error('scorecard: song ' + r.status);
    return r.json();
}

export async function postRun(payload) {
    const r = await fetch(BASE + '/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error('scorecard: run ' + r.status);
    return r.json();
}

// Page closing: fire-and-forget beacon (no response to read).
export function beaconRun(payload) {
    try {
        if (navigator.sendBeacon) {
            return navigator.sendBeacon(BASE + '/run', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        }
    } catch (_) { /* fall through */ }
    try {
        fetch(BASE + '/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true })
            .catch(() => {});
    } catch (_) { /* ignore */ }
    return false;
}
