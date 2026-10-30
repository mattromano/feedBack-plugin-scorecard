// Scorecard — boot and wiring.
//
// Inputs: Note Detection's public notedetect:hit / notedetect:miss window
// events (richer payloads on notedetect ≥ 1.33, graceful on older ones) for
// real guitar; RockHeroSmith's play:* bus events (play layer contract) for
// drums and 5-fret; the highway's public getters, and the window.feedBack
// event bus. Outputs: a DOM
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
import { wantsHud, claimsResults } from './visibility.js';
import {
    normalizePlayer, normalizePlayJudgment, isScoredInstrument, createPlayRun, recordPlay, rewindPlay,
    followable, pickFollow, partKey, instrumentLabel, missWord, resultRunPayload,
} from './engine/play.js';
import { el, COLORS, fireColor, fmtInt } from './ui/dom.js';
import { createCard } from './ui/card.js';
import { createHud } from './ui/hud.js';
import { createEndCard } from './ui/endcard.js';

const VERSION = '1.1.0';
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
        prevProvider: null, latencyMs: null, exitRelease: null, lastRun: null, hudHidden: false,
        // Drums / 5-fret (RockHeroSmith play:* events): null, or
        // { id, filename, title, artist, band, players, runs: Map(player → { run, gauge, info }),
        //   follow, song, songFor, bestAnnounced, ended }
        play: null, playRecorded: new Set(),
        // A play:* session ran on this song (set by play:result / session-end, cleared on
        // song:loading): RockHeroSmith may tear the session down in its own song:ended
        // handler before ours runs, and the end of the song is still its results screen's.
        playDone: false,
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
        if (activePlay()) return;   // guitar technique / solo popups stay off the drums / 5-fret HUD
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

    // flags: the object holding bestAnnounced (st for guitar, st.play for drums / 5-fret).
    function streakPopups(prev, s, song, flags) {
        const C = hud.colors;
        if (s > prev && s >= 50 && Math.floor(s / 50) > Math.floor(prev / 50)) {
            hud.popup(Math.floor(s / 50) * 50 + ' NOTE STREAK!', fireColor(s) || C.GOLD);
        } else {
            const songBest = song ? song.best_streak || 0 : 0;
            if (s > songBest && songBest >= 20 && !flags.bestAnnounced) {
                flags.bestAnnounced = true;
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
        // Note Detection on a drum chart judges pitch, which means nothing there; drums come in through play:*.
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
        const evs = engine.judge(j, { techniques, factor, now });
        if (!activePlay()) {   // a drums / 5-fret player owns the HUD: guitar popups stay quiet
            onEngineEvents(evs);
            streakPopups(prevStreak, st.run.streak, st.song, st);
        }
        scheduleRender();
    }

    // ── drums / 5-fret: RockHeroSmith's play:* events ──
    const detailOf = (e) => (e && e.detail && typeof e.detail === 'object' ? e.detail : (e && typeof e === 'object' ? e : null));

    function newPlay(d, players) {
        return {
            id: d.sessionId == null ? '' : String(d.sessionId), filename: String(d.filename || ''),
            title: String(d.title || ''), artist: String(d.artist || ''), band: d.band === true,
            players, runs: new Map(), follow: null, song: null, songFor: '', bestAnnounced: false, ended: false,
        };
    }

    function playEntry(p) {
        const P = st.play;
        let e = P.runs.get(p.player);
        if (!e) {
            const off = host.instrumentOffset(p);
            e = { run: createPlayRun(p), gauge: createTimingGauge(off ? { min: off.min, max: off.max, step: p.instrument === 'five_fret' ? 5 : 1 } : null), info: p };
            P.runs.set(p.player, e);
        }
        return e;
    }

    // The followed player's entry while the instrument HUD is live, else null.
    function activePlay() {
        const P = st.play;
        if (!P || P.ended || !P.follow) return null;
        return P.runs.get(P.follow) || null;
    }

    function loadPlaySong() {
        const P = st.play;
        const e = activePlay();
        if (!P || !e || !P.filename) return;
        const part = partKey(e.info.instrument, e.info.part);
        const key = P.filename + '|' + part + '|' + e.info.difficulty;
        if (P.songFor === key) return;
        P.songFor = key;
        P.song = null;
        P.bestAnnounced = false;
        fetchSong(P.filename, '', part, e.info.difficulty)
            .then((d) => { if (st.play === P && P.songFor === key) { P.song = d; scheduleRender(); } })
            .catch(() => { /* routes unavailable: the live card still works */ });
    }

    function setFollow(player) {
        const P = st.play;
        if (!P) return;
        const next = pickFollow(P.players, player);
        if (next === P.follow) return;
        P.follow = next;
        loadPlaySong();
    }

    function onPlayStart(ev) {
        const d = detailOf(ev);
        if (!d) return;
        const players = (Array.isArray(d.players) ? d.players : []).map(normalizePlayer).filter(Boolean);
        st.play = newPlay(d, players);
        for (const p of followable(players)) playEntry(p);
        setFollow(null);
        updateVisibility();
        scheduleRender();
    }

    function onPlayJudgment(ev) {
        const j = normalizePlayJudgment(detailOf(ev));
        if (!j || !j.local || !isScoredInstrument(j.instrument)) return;
        // No session-start seen (older RockHeroSmith, or a reload mid-song): start one from the judgment.
        if (!st.play || (j.sessionId && st.play.id && j.sessionId !== st.play.id)) {
            st.play = newPlay({ sessionId: j.sessionId, filename: j.filename || (host.currentSong() || {}).filename }, []);
        }
        const P = st.play;
        if (P.ended) return;
        let p = P.players.find((x) => x.player === j.player);
        if (!p) {
            p = normalizePlayer({ player: j.player, instrument: j.instrument, part: j.part, input: j.input, canvas: j.canvas });
            P.players.push(p);
        }
        if (!isScoredInstrument(p.instrument)) return;
        const e = playEntry(p);
        const prev = e.run.streak;
        recordPlay(e.run, j);
        if (j.offsetMs != null && (j.kind === 'hit' || j.kind === 'miss')) {
            const off = host.instrumentOffset(e.info);
            const cur = off ? off.get() : null;
            e.gauge.push({ hit: j.kind === 'hit', timingError: j.offsetMs,
                timingState: j.timing === 'early' ? 'EARLY' : j.timing === 'late' ? 'LATE' : 'OK' },
            { latencyMs: Number.isFinite(cur) ? cur : 0, now: performance.now() });
        }
        if (!P.follow) setFollow(null);
        if (j.player === P.follow) streakPopups(prev, e.run.streak, P.song, P);
        updateVisibility();
        scheduleRender();
    }

    function onPlayRewind(ev) {
        const d = detailOf(ev);
        const P = st.play;
        if (!d || !P || (d.sessionId != null && P.id && String(d.sessionId) !== P.id)) return;
        for (const e of P.runs.values()) rewindPlay(e.run, Number(d.t));
        scheduleRender();
    }

    // RockHeroSmith's results screen owns the end of the song: no Scorecard
    // card or popups, the HUD steps aside, and each drums / 5-fret player's
    // run is recorded once (practice results never).
    function onPlayResult(ev) {
        const d = detailOf(ev);
        if (!d) return;
        const P = st.play && (d.sessionId == null || !st.play.id || String(d.sessionId) === st.play.id) ? st.play : null;
        if (P) P.ended = true;
        st.playDone = true;
        const session = P || { filename: d.filename };
        for (const p of Array.isArray(d.players) ? d.players : []) {
            if (!p || typeof p !== 'object') continue;
            const known = P ? P.players.find((x) => x.player === p.player) : null;
            if (known && !known.local) continue;
            const e = P ? P.runs.get(p.player) : null;
            const body = resultRunPayload(p, d, session, e ? e.run : null);
            if (!body) continue;
            const once = String(d.sessionId == null ? '' : d.sessionId) + '|' + p.player;
            if (d.sessionId != null && st.playRecorded.has(once)) continue;
            st.playRecorded.add(once);
            postRun(body).then((r) => {
                if (!r || !r.ok) return;
                if (P && e && P.follow === p.player) P.song = r;
                try { window.feedBack.emit('scorecard:run', r); } catch (_) { /* bus optional */ }
            }).catch(() => { /* server unavailable: RockHeroSmith and core still keep the result */ });
        }
        updateVisibility();
    }

    function onPlayEnd(ev) {
        const d = detailOf(ev);
        const P = st.play;
        if (!P || (d && d.sessionId != null && P.id && String(d.sessionId) !== P.id)) return;
        st.play = null;
        st.playDone = true;
        hud.reset();
        updateVisibility();
    }

    const inPlaySession = () => !!st.play || st.playDone;

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
        // Hidden at the end (band mode) stays hidden for this run's card, even
        // if the hide is lifted (teardown) before postRun resolves.
        const hidden = st.hudHidden || inPlaySession();   // RockHeroSmith's results own a play:* session's end
        const sections = st.chart ? st.chart.sectionList : [];
        const releaseExit = () => { const r2 = st.exitRelease; st.exitRelease = null; if (r2) { try { r2(); } catch (_) { /* ignore */ } } };
        postRun(payload).then((d) => {
            if (!d || !d.ok) { releaseExit(); return; }
            if (st.songFor === key) st.song = d;
            const C = hud.colors;
            if (!inPlaySession()) {   // a drums / 5-fret session's end isn't this guitar run's
                if (d.full_combo) hud.popup('FULL COMBO!', C.GOLD);
                else if (d.new_best) hud.popup('NEW BEST ' + Number(d.accuracy).toFixed(2) + '%!', C.GOLD);
                if (d.new_best_score) setTimeout(() => hud.popup('NEW BEST SCORE!', C.GOLD), d.full_combo || d.new_best ? 2100 : 0);
            }
            const showCard = !hidden && !st.hudHidden && songKeyOf(host.currentSong()) === key;
            if (reason === 'ended' && getSettings().mode !== 'off' && showCard) end.show(d, payload, sections, root.style.getPropertyValue('--sc-scale'));
            else if (reason === 'ended') releaseExit();   // hidden or moved on: no card will close the hold
            try { window.feedBack.emit('scorecard:run', d); } catch (_) { /* bus optional */ }
            render();
        }).catch(() => { releaseExit(); /* server unavailable: the run is lost, the session isn't */ });
    }

    // ── visibility + rendering ──
    function compactNow() {
        const m = getSettings().mode;
        // auto: compact in a multiplayer room, and in a RockHeroSmith band (its lanes fill the stage).
        return m === 'compact' || (m === 'auto' && (host.inRoom() || !!(activePlay() && st.play.band)));
    }

    function updateVisibility() {
        const playing = !!activePlay();
        const want = wantsHud({
            onPlayer: st.onPlayer, mode: getSettings().mode, isDrums: host.isDrums(), playing,
            hasRun: !!st.run, frozen: st.frozen, ndEnabled: host.ndEnabled(), hudHidden: st.hudHidden,
        });
        if (want && !mount()) return;
        if (root.hidden !== !want || root.hasAttribute('data-play') !== playing) hud.reset();   // input changed: fresh glow / popups
        root.hidden = !want;
        root.toggleAttribute('data-compact', compactNow());
        root.toggleAttribute('data-play', playing);
        // A solo session's lane HUD shows the score already: no SCORE row (CSS). A band's lanes hide theirs.
        root.toggleAttribute('data-play-solo', playing && !st.play.band);
    }

    function scheduleRender() {
        if (st.rafPending) return;
        st.rafPending = true;
        requestAnimationFrame(() => { st.rafPending = false; render(); });
    }

    function renderPlay(e) {
        const P = st.play;
        const now = performance.now();
        const r = e.run;
        const songBest = P.song ? P.song.best_streak || 0 : 0;
        hud.updateStreak(r.streak, r.multiplier, 'run best ' + r.bestStreak + (songBest ? '\nsong best ' + songBest : ''));
        hud.updateScore(r.score, [], []);
        hud.updateSolo(null, false);
        const off = host.instrumentOffset(e.info);
        const cur = off ? off.get() : null;
        const list = followable(P.players);
        card.update({
            mode: getSettings().mode, min: getSettings().cardMin,
            play: {
                run: r, song: P.song, label: instrumentLabel(e.info), missWord: missWord(e.info.instrument),
                players: list.length > 1 ? list.map((p) => ({ label: instrumentLabel(p), active: p.player === P.follow })) : [],
                summary: e.gauge.summary({ latencyMs: Number.isFinite(cur) ? cur : null }),
                offsetMs: Number.isFinite(cur) ? cur : null, canApply: !!off && Number.isFinite(cur), where: off ? off.where : (e.info.instrument === 'drums' ? 'Drums' : '5-Fret'),
                lastMiss: e.gauge.lastMiss(now),
            },
        });
    }

    function render() {
        if (root.hidden) return;
        const pe = activePlay();
        if (pe) { renderPlay(pe); return; }
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
            run: r, song: st.song, sec, pass, mode: getSettings().mode, min: getSettings().cardMin,
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
        const pe = activePlay();
        if (act === 'off' && Number.isFinite(v) && pe) {
            const off = host.instrumentOffset(pe.info);
            if (off) off.set(v);
        } else if (act === 'follow' && Number.isInteger(v) && st.play) {
            const p = followable(st.play.players)[v];
            if (p) { setFollow(p.player); hud.reset(); }
        } else if (act === 'lat' && Number.isFinite(v)) host.applyLatencyMs(v);
        else if (act === 'av' && Number.isFinite(v)) { host.applyAvMs(v); gauge.cancelCheck(); }
        else if (act === 'check') gauge.startCheck();
        else if (act === 'cancel') gauge.cancelCheck();
        else if (act === 'min') setSetting('cardMin', !getSettings().cardMin);
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
        b.on('play:session-start', onPlayStart);
        b.on('play:judgment', onPlayJudgment);
        b.on('play:rewind', onPlayRewind);
        b.on('play:result', onPlayResult);
        b.on('play:session-end', onPlayEnd);
        b.on('song:loading', () => {
            finalize('switch');
            st.play = null;
            st.playDone = false;
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
            // The guitar (arrangement) record only: drums / 5-fret history loads per
            // part + difficulty from play:session-start (loadPlaySong).
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
            if (r && claimsResults({ judged: r.hits + r.misses, minJudged: MIN_JUDGED, mode: getSettings().mode, hudHidden: st.hudHidden, playSession: inPlaySession() })
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
        // The instruments whose HUD Scorecard draws: guitar from Note Detection, drums
        // and 5-fret from RockHeroSmith's play:* events. RockHeroSmith reads it to
        // leave the Scorecard HUD visible in its drums / 5-fret sessions.
        instruments: () => ['guitar', 'drums', 'five_fret'],
        // The followed drums / 5-fret player's live run (RockHeroSmith input), or null.
        getPlay: () => {
            const e = st.play && st.play.follow ? st.play.runs.get(st.play.follow) : null;
            if (!e || st.play.ended) return null;
            const { log, ...r } = e.run;
            return JSON.parse(JSON.stringify(Object.assign(r, { canvas: undefined })));
        },
        // Band mode hides the guitar (Note Detection) HUD and results card; runs are
        // still finalized and posted. The drums / 5-fret HUD (play:* input) shows anyway.
        setHudHidden: (hidden) => {
            if (typeof hidden !== 'boolean') return false;
            st.hudHidden = hidden;
            if (hidden) end.hide();   // an open card goes too; its onClose releases the hold
            updateVisibility();
            return true;
        },
        isHudHidden: () => st.hudHidden,
    };
}
