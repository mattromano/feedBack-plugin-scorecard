# Changelog

## [1.1.2] - 2026-10-31

### Fixed
- The A/V check's Apply works when the A/V offset is locked (set by hand, or by the main menu's Calibrate): it now
  passes core's 'manual' source instead of being silently ignored.

## [1.1.1] - 2026-10-31

### Fixed
- A drums / 5-fret play hides Scorecard's streak box and score in a band too: the lanes keep their own streak, and the
  box sat over the guitar lane showing the drummer's numbers.
- Auto size is compact on a drums / 5-fret solo as well: the full card covered the lane's own score column.

## [1.1.0] - 2026-10-29

### Added
- Minimize for the stats card: a − button collapses it to a small "Stats <accuracy> ▸" pill; click the pill to
  open it again. Remembered across songs (`cardMin` in `scorecard.settings.v1`), for every instrument.
- A drums / 5-fret solo hides Scorecard's streak box and score: the lane HUD shows both. A band keeps them.
- Drums and 5-fret controllers, from RockHeroSmith's `play:*` bus events (`play:session-start`, `play:judgment`,
  `play:rewind`, `play:result`, `play:session-end`). Real guitar stays on Note Detection; `play:*` for a guitar
  player is ignored.
  - Score, streak and multiplier are RockHeroSmith's (sum of `points`; `streak` / `multiplier` from the event).
    Streak box, on-fire glow, milestones, "streak ended" and NEW SONG BEST STREAK follow that input.
  - Stats card: accuracy, last-50 form, misses as early / late / missed / overhits (drums) or overstrums
    (5-fret). Guitar-only rows (single vs chord, pitch, not heard, techniques, strings, sections, solo meter,
    A/V check) are hidden.
  - Timing gauge from `offsetMs`, with an Apply that sets the instrument's input offset: drums on the kit through
    the drums plugin's input-offset hook, 5-fret through the lane controller's offset (+ `five_fret:offset-changed`);
    a public `setInputOffset` / `getInputOffset(canvas)` on either plugin wins. No setter, no Apply (a hint instead).
  - Band sessions follow one local drums / 5-fret player (the first by default) with a picker on the card when
    there are several; `auto` size is compact in a band.
  - Run history, bests and pace vs best per song + part (`drums`, `five_fret:<part>`) + difficulty, recorded once
    per player from `play:result` (never practice). RockHeroSmith's results screen owns the end of the song: no
    Scorecard end card, no auto-exit hold, no guitar popups over the instrument HUD.
  - Layout clears RockHeroSmith's 48 px bar, crowd meter and callouts. In a solo session the lane HUD shows
    the score, so the streak box drops its SCORE row; a band shows the followed player's score.
  - The end of a song that had a `play:*` session stays RockHeroSmith's even when its session ended before
    Scorecard's `song:ended` handler ran (no hold, end card or guitar popups until the next `song:loading`).
- `window.feedBackScorecard.instruments()` → `['guitar', 'drums', 'five_fret']` (RockHeroSmith uses it to leave
  the HUD visible) and `getPlay()` (the followed player's live run).
- Routes: `part` and `difficulty` on `POST run`, `GET song` and `GET bests?part=`. `scorecard.db` from 1.0 is
  migrated in place (two columns with `''` defaults and an index; idempotent), its runs stay guitar runs.
- `window.feedBackScorecard.setHudHidden(hidden)` / `isHudHidden()`: other plugins (RockHeroSmith) can hide the
  guitar HUD and the end-of-song card and its auto-exit hold. Runs are still finalized and saved.

### Changed
- `setHudHidden(true)` hides the Note Detection HUD only; the drums / 5-fret HUD shows during a `play:*` session.
- Drum arrangements are no longer excluded outright: the HUD shows there for RockHeroSmith input (Note
  Detection's judgments on a drum chart are still ignored).
- Docs and tests name RockHeroSmith (formerly Build-a-Band; screen `plugin-rockherosmith`).

## [1.0.0] - 2026-10-09

First release.

- Streak box: note streak, ×1–×4 multiplier with pips, score with technique / technical-run / solo
  tags, "on fire" glow and milestone popups.
- Stats card: two-decimal accuracy, form, single vs chord accuracy, pitch tendency, miss reasons,
  this song's history and the current section's pass vs best, weak techniques and strings; compact in
  multiplayer rooms; hidden on Drums.
- Score engine: timing, technique (bends, slides, harmonics, pinch harmonics), technical passages,
  streak multiplier, speed × difficulty, solo bonus and rating; solo auto-detection when the chart
  names no solo.
- Early/late timing gauge with latency suggestion + Apply, and the A/V (ear vs eye) check.
- Hit / miss marks on the highway through core's note-state provider, composed with Note
  Detection's own.
- Run history and bests per song + arrangement (`scorecard.db`), end-of-song card.
