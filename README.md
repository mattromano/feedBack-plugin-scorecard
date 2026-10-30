# Scorecard

A Rock Band-style performance HUD for [feedBack](https://github.com/got-feedback/feedBack), built on
the judgments [Note Detection](https://github.com/got-feedback/feedBack-plugin-notedetect) publishes.
It scores your playing, shows how your timing sits, marks hits and misses on the highway, and keeps
a history of every run per song and arrangement.

Requires feedBack **0.3.0-alpha.1** or newer (ES-module plugins) and the Note Detection plugin for real
guitar. Drums and 5-fret controllers come in through [RockHeroSmith](https://github.com/mattromano/feedBack-plugin-rockherosmith)'s
play layer (see **Drums and 5-fret** below). Nothing happens until a note is judged.

## What it shows

**Streak box** (left of the highway)
- Note streak, the ×1–×4 multiplier (one step per 10 notes in a row) with progress pips, run and
  song best streak.
- Score, with tags for a technical run, a solo or a reduced speed/difficulty factor, and a short feed
  of technique bonuses.
- "On fire" glow around the highway at 50 / 100 / 200 in a row, milestone popups, "streak ended"
  when a 25+ streak breaks, "NEW SONG BEST STREAK".

**Stats card** (right)
- Accuracy to two decimals, hits / judged, last-50 form, single-note vs chord accuracy, pitch
  tendency (sharp / flat) and why notes were missed (not heard, early, late, pitch, chord).
- **Timing gauge**: the last 24 timed notes as early/late ticks and their median. When you're
  consistently early or late it suggests the Audio Latency Offset that centres you, with an
  **Apply** button (Note Detection's `applySettings`).
- **A/V check**: play ~12 notes by ear with your eyes off the highway; if you land earlier or later
  by ear than by eye, the audio and video disagree and it suggests the A/V offset that lines them up
  (**Apply** sets core's A/V offset).
- This song: best accuracy and score, last run, pace vs best, a sparkline of recent runs, core's
  play count; the current section's pass vs its best; weak spots (techniques, per-string bars).
- **Compact** in a multiplayer room (only accuracy and timing), automatically with the multiplayer
  plugin's `<html data-mp-room>`, or by choice.
- On Drums arrangements only with RockHeroSmith input (Note Detection's pitch judgments mean nothing on a
  drum chart).

**Solo meter**: on sections named "solo" — or, when the chart names none, sections that look like a
solo (mostly single notes, fast, unique, up the neck, ≥ 3 bars) — a live % meter at the top and a
blue glow; at the end, a solo bonus and a rating (PERFECT / AWESOME / GREAT / GOOD / SOLID / OKAY /
MESSY SOLO).

**Hit / miss marks on the highway** (through core's note-state provider): hits flash white, misses
stay marked while they scroll past, partly played chords light their rung strings amber. Note
Detection's own sustain glow is kept. How each state looks is up to the active renderer — the
built-in 2D highway honours the colours; the 3D highway shows its own hit / miss look.

**End-of-song card**: banner (full combo / new best / practice run), score and where it came from,
solos, technical runs, song best and trend, and this run's sections (vs their bests), weakest
techniques and per-string accuracy. It holds core's return-to-menu until you close it.

## Drums and 5-fret

RockHeroSmith scores drums (MIDI kit or controller) and 5-fret controllers, solo or in a band, and publishes
`play:session-start`, `play:judgment`, `play:rewind`, `play:result` and `play:session-end` on `window.feedBack`.
Scorecard draws its HUD from them; a guitar player in those events is left to Note Detection.

- **Score, streak, multiplier**: RockHeroSmith's (points summed, streak and multiplier from each judgment), not
  the guitar scoring below. Streak box, on-fire glow, milestones, "streak ended" and NEW SONG BEST STREAK work
  as for guitar.
- **Stats card**: accuracy, hits / judged, last-50 form, misses (early, late, missed, overhits / overstrums).
  Guitar-only rows are hidden (single vs chord, pitch, not heard, techniques, strings, sections, solo meter).
- **Timing gauge** from each hit's `offsetMs`. When you're consistently early or late it suggests the input
  offset that centres you; **Apply** sets it live: drums on the kit (the drums plugin's input offset, ±250 ms),
  5-fret per controller (±200 ms, 5 ms steps). Drums controllers have no live setter yet, so they get a hint
  instead of Apply. The A/V check is guitar-only.
- **Band**: follows one local drums / 5-fret player, the first by default; a picker on the card switches when
  there are several. `auto` size is compact in a band.
- **History** per song + part (`drums`, `five_fret:guitar|rhythm|bass`) + difficulty: one run per player from
  `play:result` (practice results are skipped). RockHeroSmith's results screen owns the end of the song, so
  Scorecard shows no end card and holds no exit there.
- **Layout**: clears RockHeroSmith's 48 px top bar, crowd meter and callouts. In a solo the lane HUD shows the
  score, so the streak box has no SCORE row; in a band it shows the followed player's score.
- `setHudHidden(true)` (RockHeroSmith's band mode) hides the guitar HUD only; the drums / 5-fret HUD still shows.

Why Scorecard's own routes and not core's `/api/stats/history`: core's recorder already posts `play:result`
there for XP and career; Scorecard keeps its own history (with the same record shape for guitar and
instruments: sparkline, best streak, pace vs best) and works on a core without the part tables.

## Scoring

| | |
|---|---|
| Hit single note | 50 |
| Hit chord | 50 per string that rang |
| Timing | ≤ 25 ms ×1, ≤ 50 ms ×0.8, else ×0.6 |
| Technique | +25 % bends and slides, +100 % harmonics, +200 % pinch harmonics |
| Technical passage (≥ 6 notes within ±0.5 s) | ×1.5; a run of ≥ 8 reports "TECHNICAL RUN h/n" |
| Streak multiplier | ×1–×4 |
| Speed × difficulty | both capped at 1 |
| Solo bonus | 100 per note hit, ×2 for a perfect solo |

A miss scores nothing and resets the multiplier.

## Run history

A run is saved when the song ends, another song or arrangement loads, Note Detection resets its
stats (restart, seek back), or the page closes — if at least 20 notes were judged. It counts toward
your bests only when complete (song ended or ≥ 92 % reached), unlooped and at 1.00×; everything else
is kept as practice. History lives in `scorecard.db` in feedBack's config directory (included in
Settings → Export).

Core already records plays, accuracy and XP from Note Detection's events, so Scorecard doesn't post
to `/api/stats`; it reads core's play count to show next to its own history.

Routes (`/api/plugins/scorecard/…`): `GET song?filename=&arrangement=` (`&part=&difficulty=` for drums /
5-fret), `POST run` (optional `part`, `difficulty`), `GET bests` (guitar, by arrangement) and
`GET bests?part=drums` (by difficulty). A `scorecard.db` from 1.0 is migrated in place on start.

## Settings

Settings → Mic (Scorecard): stats card size (auto / full / compact / off), hit / miss marks on the
highway, size. The player's **Plugins** popover has quick toggles for the card size and the marks.

Other plugins can read the live state with `window.feedBackScorecard.getScore()` / `getRun()` and
listen for `scorecard:run` on `window.feedBack` after a run is saved.

Other plugins: `setHudHidden(true)` hides the guitar HUD and results card; runs are still saved.
`isHudHidden()` reads the flag. `instruments()` lists what the HUD draws (`guitar`, `drums`, `five_fret`);
`getPlay()` returns the followed drums / 5-fret player's live run.

## Note Detection versions

Note Detection ≥ 1.33 adds per-string chord results, technique names, section, latency and A/V
offset, and `counted` / `isDefault` to its `notedetect:hit` / `notedetect:miss` events. Scorecard
uses them when present. With an older Note Detection it still scores and tracks runs, but per-string
bars only count single notes, partial chords are inferred from the chord's string count, and the
gauge can't suggest a latency value.

## Development

No build step: `screen.js` imports the ES modules in `src/`.

```bash
npm test                                   # node --check every module + node --test tests/*.test.mjs
python -m pytest tests                     # routes (needs fastapi + httpx)
```

The scoring, solo detection, timing and run logic in `src/engine/` is pure and unit-tested; the DOM
lives in `src/ui/`.

## License

MIT — see [LICENSE](LICENSE).
