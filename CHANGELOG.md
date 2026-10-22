# Changelog

## [Unreleased]

- `window.feedBackScorecard.setHudHidden(hidden)` / `isHudHidden()`: other plugins (Build-a-Band) can hide the
  HUD and the end-of-song card and its auto-exit hold. Runs are still finalized and saved.

### Changed
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
