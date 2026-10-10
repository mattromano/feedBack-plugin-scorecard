// Scorecard — boot and wiring.
//
// Inputs: Note Detection's public notedetect:hit / notedetect:miss window
// events (richer payloads on notedetect ≥ 1.33, graceful on older ones), the
// highway's public getters, and the window.feedBack event bus. Outputs: a DOM
// overlay inside #player (stats card, streak / score box, solo meter, popups,
// end-of-song card), the note-state provider (hit / miss marks on the
// highway), and run history through this plugin's routes.
//
// Idempotent (plugin-runtime-idempotent.v1): a second evaluation finds the
// window singleton and installs nothing.

import { normalizeJudgment } from './engine/judgment.js';
import { createScoreEngine, chartTechniques, denseNoteTimes, speedDifficultyFactor, multiplierFor } from './engine/score.js';
import { soloWindows } from './engine/solos.js';
import { createTimingGauge } from './engine/timing.js';
import { createRun, recordJudgment, trackPlayback, runPayload, sectionList, sectionAt, techFlagsOf, techFlagsFromNames, MIN_JUDGED } from './engine/run.js';
import { createVerdictStore, composeProvider, verdictKey } from './engine/verdicts.js';
import * as host from './host.js';
import { getSettings, setSetting, nextMode } from './settings.js';
import { fetchSong, postRun, beaconRun } from './api.js';
import { el, COLORS, fireColor, fmtInt } from './ui/dom.js';
import { createCard } from './ui/card.js';
import { createHud } from './ui/hud.js';
import { createEndCard } from './ui/endcard.js';

const VERSION = '1.0.0';
const TICK_MS = 250;
const FEED_MS = 2500;

const G = (window.__feedBackScorecard ||= { installed: false });
G.version = VERSION;
if (!G.installed) {
    G.installed = true;
    boot();
}

function boot() {
    const settings = getSettings();
    const engine = createScoreEngine();
    const gauge = createTimingGauge();
    const verdicts = createVerdictStore();

    const st = {
        run: null, songKey: '', song: null, songFor: '', frozen: false,
        ndTotal: 0, minFactor: 1, feed: [], bestAnnounced: false, lastStreak: 0,
        chart: null, onPlayer: false, timer: 0, rafPending: false,
        prevProvider: null, latencyMs: null, exitRelease: null, lastRun: null,
    };

    // ── DOM (created once, mounted into #player on demand) ──
    const card = createCard(onCardAction);
    const hud = createHud();
    const end = createEndCard(() => {
        // Closing the results lets core leave the player (if we held it).
        const release = st.exitRelease;
        st.exitRelease = null;
        if (release && st.onPlayer) { try { release(); } catch (_) { /* host moved on */ } }
    });
    const root = el('div', 'sc-root');
    root.hidden = true;
    root.append(...hud.els, card.el);

    const modeBtn = el('button', 'sc-ctl');
    modeBtn.type = 'button';
    modeBtn.addEventListener('click', () => setMode(nextMode(getSettings().mode)));
    const marksBtn = el('button', 'sc-ctl');
    marksBtn.type = 'button';
    marksBtn.addEventListener('click', () => { setSetting('marks', !getSettings().marks); syncProvider(); syncControls(); });

    function mount() {
        if (root.isConnected) return true;
        const player = document.getElementById('player');
        if (!player) return false;
        player.appendChild(root);
        return true;
    }
    function mountControls() {
        const slot = host.playerControlSlot();
        if (!slot) return;
        if (!slot.contains(modeBtn)) slot.appendChild(modeBtn);
        if (!slot.contains(marksBtn)) slot.appendChild(marksBtn);
        syncControls();
    }
    function syncControls() {
        const s = getSettings();
        modeBtn.textContent = 'Scorecard: ' + s.mode;
        modeBtn.title = 'Scorecard size: auto (compact in a multiplayer room) → compact → full → off';
        marksBtn.textContent = 'Hit marks: ' + (s.marks ? 'on' : 'off');
        marksBtn.title = 'Rock Band-style hit / miss marks on the highway (needs Note Detection)';
    }
    function setMode(m) {
        setSetting('mode', m);
        syncControls();
        updateVisibility();
        render();
    }

    // Settings panel (settings.html): bound once, values re-synced on entry.
    function bindSettingsPanel() {
        const panel = document.getElementById('plugin-settings-scorecard');
        if (!panel) return;
        const s = getSettings();
        for (const input of panel.querySelectorAll('[data-sc-setting]')) {
            const k = input.dataset.scSetting;
            if (input.type === 'checkbox') input.checked = !!s[k];
            else input.value = String(s[k]);
            if (input.dataset.scBound) continue;
            input.dataset.scBound = '1';
            input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
                const v = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value;
                if (k === 'mode') { setMode(v); return; }
                setSetting(k, v);
                if (k === 'marks') { syncProvider(); syncControls(); }
                if (k === 'scale') applyScale();
            });
        }
    }

    const applyScale = () => {
        const auto = Math.max(1, Math.min(2.8, (window.innerHeight || 900) / 900));
        root.style.setProperty('--sc-scale', (auto * getSettings().scale).toFixed(3));
    };
    applyScale();
    window.addEventListener('resize', applyScale);

    // ── note-state provider (hit / miss marks) ──
    const provider = composeProvider(verdicts, {
        getPrev: () => st.prevProvider,
        getNow: host.renderTime,
        isEnabled: () => getSettings().marks,
    });
    function syncProvider() {
        const h = host.hw();
        if (!h || typeof h.setNoteStateProvider !== 'function' || typeof h.getNoteStateProvider !== 'function') return;
        const cur = h.getNoteStateProvider();
        if (getSettings().marks) {
            if (cur !== provider) { st.prevProvider = cur; h.setNoteStateProvider(provider); }
        } else if (cur === provider) {
            h.setNoteStateProvider(st.prevProvider || null);
            st.prevProvider = null;
        }
    }

    // ── chart info (rebuilt when the highway's arrays change) ──
    function chartInfo() {
        const c = host.chart();
        const prev = st.chart;
        if (prev && prev.notes === c.notes && prev.chords === c.chords && prev.sections === c.sections
            && prev.beats.length === c.beats.length) return prev;
        const raw = new Map();
        for (const n of c.notes) if (n && Number.isFinite(n.t)) raw.set(verdictKey(n.t, n.s), n);
        for (const ch of c.chords) for (const n of (ch && ch.notes) || []) if (n) raw.set(verdictKey(ch.t, n.s), n);
        const info = {
            notes: c.notes, chords: c.chords, sections: c.sections, beats: c.beats, raw,
            sectionList: sectionList(c.sections, c.notes, c.chords),
            solos: soloWindows(c.sections, c.notes, c.chords, c.beats),
            dense: denseNoteTimes(c.notes),
        };
        engine.setChart({ dense: info.dense, solos: info.solos });
        st.chart = info;
        return info;
    }

    // Chart notes behind a judgment (for techniques), by chart time + string.
    function chartNotesOf(j, info) {
        const strings = j.chord
            ? ((j.strings && j.strings.length ? j.strings : j.notes) || []).map((x) => x.s)
            : [j.s];
        const out = [];
        for (const s of strings) {
            if (!Number.isInteger(s)) continue;
            const n = info.raw.get(verdictKey(j.noteTime, s));
            if (n) out.push(n);
        }
        return out;
    }

    // ── runs ──
    function songKeyOf(s) { return s ? s.filename + '|' + s.arrangement : ''; }

    function loadSong(s) {
        const key = songKeyOf(s);
        if (!s || !s.filename || st.songFor === key) return;
        st.songFor = key;
        st.song = null;
        fetchSong(s.filename, s.arrangement)
            .then((d) => { if (st.songFor === key) { st.song = d; render(); } })
            .catch(() => { /* routes unavailable: live card still works */ });
    }

    function startRun(s) {
        engine.reset();
        chartInfo();
        st.minFactor = 1;
        st.feed = [];
        st.bestAnnounced = false;
        st.lastStreak = 0;
        st.run = createRun({ ...s, now: performance.now() });
        st.lastRun = null;
        st.songKey = songKeyOf(s);
        loadSong(s);
    }

    function feed(text, color) {
        st.feed.push({ text, color, at: performance.now() });
        if (st.feed.length > 4) st.feed.shift();
    }

    function onEngineEvents(events) {
        const C = hud.colors;
        for (const e of events) {
            if (e.type === 'technique') {
                feed('+' + fmtInt(e.points) + ' ' + e.techniques.map((t) => t.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' + '), C.PURPLE);
            } else if (e.type === 'pinch') {
                hud.popup('PINCH HARMONIC!  +' + fmtInt(e.points), C.PURPLE, true);
            } else if (e.type === 'run') {
                hud.popup('TECHNICAL RUN ' + e.h + '/' + e.n + '  +' + fmtInt(e.pts), e.perfect ? C.GOLD : C.ORANGE, true);
            } else if (e.type === 'solo') {
                hud.popup(e.rating, e.perfect ? C.GOLD : e.pct >= 90 ? C.BLUE : C.WHITE);
                setTimeout(() => hud.popup(e.pct.toFixed(2) + '%  ·  solo bonus +' + fmtInt(e.bonus), e.perfect ? C.GOLD : C.BLUE, true), 900);
            }
        }
    }

    function streakPopups(prev, s) {
        const C = hud.colors;
        if (s > prev && s >= 50 && Math.floor(s / 50) > Math.floor(prev / 50)) {
            hud.popup(Math.floor(s / 50) * 50 + ' NOTE STREAK!', fireColor(s) || C.GOLD);
        } else {
            const songBest = st.song ? st.song.best_streak || 0 : 0;
            if (s > songBest && songBest >= 20 && !st.bestAnnounced) {
                st.bestAnnounced = true;
                hud.popup('NEW SONG BEST STREAK!', C.GOLD, true);
            }
        }
        if (s < prev && prev >= 25) hud.popup('streak ended at ' + prev, C.DIM, true);
    }

    function onJudgment(ev) {
        const j = normalizeJudgment(ev && ev.detail);
        if (!j || !j.counted || !j.isDefault) return;
        if (j.latencyMs != null) st.latencyMs = j.latencyMs;
        const now = performance.now();
        gauge.push(j, { latencyMs: j.latencyMs, avMs: j.avOffsetMs != null ? j.avOffsetMs : host.avOffsetMs(), now });
        syncProvider();
        verdicts.record(j, host.renderTime());
        verdicts.prune(host.renderTime());
        if (st.frozen || host.isDrums()) { scheduleRender(); return; }

        // Note Detection reset its stats (restart / seek back / re-enable):
        // close this run and start a fresh one.
        const nds = host.ndStats();
        const total = nds ? (nds.hits | 0) + (nds.misses | 0) : null;
        if (st.run && total != null && total < st.ndTotal) finalize('reset');
        if (total != null) st.ndTotal = total;

        const s = host.currentSong();
        if (st.run && songKeyOf(s) !== st.songKey) finalize('switch');
        if (!st.run) {
            if (!s || !s.filename) return;
            startRun(s);
        }
        const info = chartInfo();
        const notes = chartNotesOf(j, info);
        const techniques = notes.length ? [...new Set(notes.flatMap(chartTechniques))] : (j.techniques || []);
        const flags = notes.length ? [...new Set(notes.flatMap(techFlagsOf))] : techFlagsFromNames(j.techniques);
        const speed = host.playbackRate();
        const factor = speedDifficultyFactor(speed, host.mastery());
        st.minFactor = Math.min(st.minFactor, factor);

        const prevStreak = st.run.streak;
        recordJudgment(st.run, j, { flags, sections: info.sectionList, fullSpeed: speed >= 0.999 });
        onEngineEvents(engine.judge(j, { techniques, factor, now }));
        streakPopups(prevStreak, st.run.streak);
        scheduleRender();
    }

    function finalize(reason, beacon) {
        const r = st.run;
        st.run = null;
        if (!r) return;
        st.lastRun = r;   // keeps the card on the finished run until the next one starts
        const t = host.chartTime();
        const factor = st.minFactor;
        const evs = engine.closeSolos(t, factor, { all: reason === 'ended' });
        evs.push(...engine.closeRun(performance.now(), true));
        if (reason === 'ended') onEngineEvents(evs);
        if (r.hits + r.misses < MIN_JUDGED) return;
        const score = Object.assign(engine.snapshot(), { factor });
        const payload = runPayload(r, reason, score, performance.now());
        try {
            const diag = window.feedBack && window.feedBack.diagnostics;
            if (diag && typeof diag.contribute === 'function') {
                diag.contribute('scorecard', { schema: 'scorecard.client_diag.v1', version: VERSION, mode: getSettings().mode,
                    marks: getSettings().marks, composedProvider: !!st.prevProvider,
                    lastRun: { reason, hits: r.hits, misses: r.misses, score: score.score, complete: payload.complete, speed: payload.speed } });
            }
        } catch (_) { /* diagnostics are optional */ }
        if (beacon) { beaconRun(payload); return; }
        const key = songKeyOf(r);
        const sections = st.chart ? st.chart.sectionList : [];
        const releaseExit = () => { const r2 = st.exitRelease; st.exitRelease = null; if (r2) { try { r2(); } catch (_) { /* ignore */ } } };
        postRun(payload).then((d) => {
            if (!d || !d.ok) { releaseExit(); return; }
            if (st.songFor === key) st.song = d;
            const C = hud.colors;
            if (d.full_combo) hud.popup('FULL COMBO!', C.GOLD);
            else if (d.new_best) hud.popup('NEW BEST ' + Number(d.accuracy).toFixed(2) + '%!', C.GOLD);
            if (d.new_best_score) setTimeout(() => hud.popup('NEW BEST SCORE!', C.GOLD), d.full_combo || d.new_best ? 2100 : 0);
            if (reason === 'ended' && getSettings().mode !== 'off') end.show(d, payload, sections, root.style.getPropertyValue('--sc-scale'));
            try { window.feedBack.emit('scorecard:run', d); } catch (_) { /* bus optional */ }
            render();
        }).catch(() => { releaseExit(); /* server unavailable: the run is lost, the session isn't */ });
    }

    // ── visibility + rendering ──
    function compactNow() {
        const m = getSettings().mode;
        return m === 'compact' || (m === 'auto' && host.inRoom());
    }

    function updateVisibility() {
        const want = st.onPlayer && getSettings().mode !== 'off' && !host.isDrums()
            && (!!st.run || st.frozen || host.ndEnabled());
        if (want && !mount()) return;
        root.hidden = !want;
        root.toggleAttribute('data-compact', compactNow());
    }

    function scheduleRender() {
        if (st.rafPending) return;
        st.rafPending = true;
        requestAnimationFrame(() => { st.rafPending = false; render(); });
    }

    function render() {
        if (root.hidden) return;
        const now = performance.now();
        const t = host.chartTime();
        const info = st.chart;
        const snap = engine.snapshot();
        const r = st.run || st.lastRun;
        const s = r ? r.streak : 0;
        const songBest = st.song ? st.song.best_streak || 0 : 0;
        hud.updateStreak(s, multiplierFor(s), 'run best ' + (r ? r.bestStreak : 0) + (songBest ? '\nsong best ' + songBest : ''));

        const tags = [];
        const C = hud.colors;
        if (snap.inRun) tags.push(['TECHNICAL ×1.5', C.ORANGE]);
        const inSolo = r && info ? engine.soloAt(t) : null;
        if (inSolo) tags.push(['SOLO', C.BLUE]);
        if (r && st.minFactor < 0.999) tags.push(['×' + st.minFactor.toFixed(2) + ' speed/difficulty', C.DIM]);
        st.feed = st.feed.filter((x) => now - x.at < FEED_MS);
        hud.updateScore(snap.score, tags, st.feed.map((x) => ({ text: x.text, color: x.color, opacity: 1 - (now - x.at) / FEED_MS })));

        let live = null;
        if (r && info) {
            const sol = info.solos.find((x) => t >= x.start - 0.5 && t < x.end + 1.0);
            if (sol) live = Object.assign({ name: sol.name }, engine.soloProgress(sol.id));
        }
        hud.updateSolo(live, inSolo);

        const sec = info ? sectionAt(info.sectionList, t) : null;
        const pass = r && r.pass && sec && r.pass.sec.key === sec.key ? r.pass : null;
        const avMs = host.avOffsetMs();
        card.update({
            run: r, song: st.song, sec, pass, mode: getSettings().mode,
            summary: gauge.summary({ latencyMs: st.latencyMs, avMs }),
            latencyMs: st.latencyMs, avMs, lastMiss: gauge.lastMiss(now),
            canApplyLatency: host.canApplyLatency(), canApplyAv: host.canApplyAv(),
        });
    }

    function tick() {
        updateVisibility();
        if (root.hidden) return;
        const r = st.run;
        if (r) {
            const s = host.currentSong();
            const t = host.chartTime();
            trackPlayback(r, { progress: s && s.duration > 0 ? t / s.duration : NaN, speed: host.playbackRate(), looped: host.loopActive() });
            onEngineEvents(engine.closeSolos(t, st.minFactor));
            onEngineEvents(engine.closeRun(performance.now(), false));
        }
        render();
    }

    function onCardAction(act, v) {
        if (act === 'lat' && Number.isFinite(v)) host.applyLatencyMs(v);
        else if (act === 'av' && Number.isFinite(v)) { host.applyAvMs(v); gauge.cancelCheck(); }
        else if (act === 'check') gauge.startCheck();
        else if (act === 'cancel') gauge.cancelCheck();
        else if (act === 'mode') { setMode(nextMode(getSettings().mode) === 'off' ? 'auto' : nextMode(getSettings().mode)); return; }
        render();
    }

    function setOnPlayer(on) {
        st.onPlayer = on;
        if (on) {
            mountControls();
            if (!st.timer) st.timer = setInterval(tick, TICK_MS);
        } else if (st.timer) {
            clearInterval(st.timer);
            st.timer = 0;
        }
        updateVisibility();
    }

    // ── wiring ──
    window.addEventListener('notedetect:hit', onJudgment);
    window.addEventListener('notedetect:miss', onJudgment);
    window.addEventListener('multiplayer:room', () => { updateVisibility(); render(); });
    window.addEventListener('beforeunload', () => finalize('closed', true));

    const b = host.bus();
    if (b) {
        b.on('screen:changed', (e) => {
            const id = e && e.detail && e.detail.id;
            setOnPlayer(id === 'player');
            if (id === 'settings') bindSettingsPanel();
        });
        b.on('song:loading', () => {
            finalize('switch');
            st.frozen = false;
            st.chart = null;
            st.ndTotal = 0;
            verdicts.clear();
            st.exitRelease = null;   // a new song: never navigate away from it
            st.lastRun = null;
            end.hide();
            hud.reset();
            engine.reset();
        });
        b.on('song:ready', () => {
            const s = host.currentSong();
            if (s && !host.isDrums()) loadSong(s);
            st.chart = null;
            syncProvider();
            mountControls();
            updateVisibility();
            render();
        });
        b.on('song:arrangement-changed', () => finalize('switch'));
        b.on('song:ended', () => {
            // A results card is coming: hold core's return-to-menu until it's
            // closed (core runs its song:ended handler first, so the timer is
            // already pending and holdAutoExit can cancel it synchronously).
            const r = st.run;
            if (r && r.hits + r.misses >= MIN_JUDGED && getSettings().mode !== 'off'
                && window.feedBack && typeof window.feedBack.holdAutoExit === 'function') {
                try { st.exitRelease = window.feedBack.holdAutoExit(); } catch (_) { st.exitRelease = null; }
            }
            finalize('ended');
            st.frozen = true;
        });
        b.on('song:stop', () => finalize('stopped'));
        b.on('song:play', () => { st.frozen = false; });
        b.on('song:seek', () => { st.frozen = false; });
        b.on('loop:restart', () => { if (st.run) st.run.looped = true; });
    }
    const player = document.getElementById('player');
    setOnPlayer(!!(player && player.classList.contains('active')));
    syncControls();
    bindSettingsPanel();

    // Read-only handle for other plugins / devtools.
    window.feedBackScorecard = {
        version: VERSION,
        getScore: () => Object.assign(engine.snapshot(), { factor: st.minFactor }),
        getRun: () => (st.run ? JSON.parse(JSON.stringify(st.run)) : null),
        getSong: () => st.song,
    };
}
