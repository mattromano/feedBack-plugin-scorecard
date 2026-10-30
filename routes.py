"""Scorecard — run history and bests per song + arrangement (real guitar) or
song + part + difficulty (drums / 5-fret).

Guitar runs are posted by the frontend when a song ends, another song or
arrangement loads, detection resets, or the page closes. Drums and 5-fret
runs are posted from RockHeroSmith's ``play:result`` with a ``part`` key
(``drums``, ``five_fret:<part>``, core's rule) and a ``difficulty``; guitar
runs have ``part`` and ``difficulty`` ``''``. They live in a
small SQLite file under the Host's ``config_dir`` (``scorecard.db``, declared
in ``settings.server_files`` so Settings export/import carries it).

Core already records plays, best accuracy and XP from Note Detection's
events (``POST /api/stats``), so this plugin never posts there; it only reads
core's per-song stats (plays) to show next to its own history.

Routes (all under ``/api/plugins/scorecard/``):
- ``GET  song?filename=&arrangement=&part=&difficulty=`` → history, bests,
  section bests, core plays
- ``POST run``                         → store a run, return the song record +
  what changed (new best, full combo, ...)
- ``GET  bests``                       → ``{filename: {arrangement: best}}`` (guitar)
- ``GET  bests?part=drums``            → ``{filename: {difficulty: best}}``

Databases from 1.0 are migrated in place on start (two added columns with
``''`` defaults and an index; idempotent), so their runs stay guitar runs.
"""

import json
import logging
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_NAME = "scorecard.db"
HISTORY_LIMIT = 40
MAX_DETAILS_BYTES = 64 * 1024
MAX_TEXT = 512
WEEK = timedelta(days=7)
# core's part key format (lib/play_parts.py); '' is real guitar
PART_RE = re.compile(r"^[a-z][a-z0-9_]{0,23}(:[a-z][a-z0-9_]{0,23})?$")
DIFFICULTIES = ("easy", "medium", "hard", "expert")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    arrangement TEXT NOT NULL,
    title TEXT,
    artist TEXT,
    ts TEXT NOT NULL,
    accuracy REAL NOT NULL,
    hits INTEGER NOT NULL,
    misses INTEGER NOT NULL,
    best_streak INTEGER NOT NULL DEFAULT 0,
    score INTEGER,
    complete INTEGER NOT NULL DEFAULT 0,
    looped INTEGER NOT NULL DEFAULT 0,
    speed REAL NOT NULL DEFAULT 1,
    progress REAL NOT NULL DEFAULT 0,
    played_s REAL NOT NULL DEFAULT 0,
    details TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_song ON runs(filename, arrangement);
"""

# 1.1: drums / 5-fret runs. Added columns (not in _SCHEMA) so an old file and a
# new one end up with the same table; each step checks before it runs.
_PART_COLUMNS = (("part", "TEXT NOT NULL DEFAULT ''"), ("difficulty", "TEXT NOT NULL DEFAULT ''"))
_PART_INDEX = "CREATE INDEX IF NOT EXISTS idx_runs_part ON runs(filename, part, difficulty, arrangement)"

_RUN_COLS = ("id", "ts", "accuracy", "hits", "misses", "best_streak", "score", "complete",
             "looped", "speed", "progress", "played_s", "details")


class RunError(ValueError):
    """A posted run failed validation (→ HTTP 400)."""


def check_part(part, difficulty):
    """Validate a part key + difficulty pair: both '' (guitar) or a part key and
    '' / a difficulty. Returns them, or raises RunError."""
    if not isinstance(part, str) or not isinstance(difficulty, str):
        raise RunError("part and difficulty must be strings")
    if part and not PART_RE.match(part):
        raise RunError("bad part")
    if difficulty and difficulty not in DIFFICULTIES:
        raise RunError("bad difficulty")
    if difficulty and not part:
        raise RunError("difficulty needs a part")
    return part, difficulty


def _text(v, limit=MAX_TEXT):
    if v is None:
        return ""
    if not isinstance(v, str):
        raise RunError("expected a string")
    return v[:limit]


def _int(v, lo, hi, name):
    if isinstance(v, bool) or v is None:
        raise RunError(f"{name} must be an integer")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise RunError(f"{name} must be an integer") from None
    if f != f or f in (float("inf"), float("-inf")) or f != int(f):
        raise RunError(f"{name} must be an integer")
    i = int(f)
    if not lo <= i <= hi:
        raise RunError(f"{name} out of range")
    return i


def _float(v, lo, hi, name, default):
    if v is None:
        return default
    if isinstance(v, bool):
        raise RunError(f"{name} must be a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise RunError(f"{name} must be a number") from None
    if f != f or not lo <= f <= hi:
        raise RunError(f"{name} out of range")
    return f


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(ts):
    try:
        return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def is_counted(row):
    """A run counts toward bests when complete, unlooped and at full speed."""
    return bool(row["complete"]) and not row["looped"] and (row["speed"] or 0) >= 0.999


class ScoreStore:
    """SQLite-backed run history. One short-lived connection per call; writes
    are serialised with a lock (the Host may serve requests on many threads)."""

    def __init__(self, path, log=None):
        self.path = Path(path)
        self.log = log or logging.getLogger("feedBack.plugin.scorecard")
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
            self._migrate(conn)
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def _migrate(conn):
        have = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
        for name, decl in _PART_COLUMNS:
            if name not in have:
                try:
                    conn.execute(f"ALTER TABLE runs ADD COLUMN {name} {decl}")
                except sqlite3.OperationalError as e:   # another process added it first
                    if "duplicate column" not in str(e).lower():
                        raise
        conn.execute(_PART_INDEX)

    def _connect(self):
        conn = sqlite3.connect(str(self.path), timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # ── reads ──
    def _rows(self, filename, arrangement, part="", difficulty=""):
        conn = self._connect()
        try:
            return [dict(r) for r in conn.execute(
                "SELECT " + ", ".join(_RUN_COLS) + " FROM runs WHERE filename = ? AND arrangement = ?"
                " AND part = ? AND difficulty = ? ORDER BY id",
                (filename, arrangement, part, difficulty))]
        finally:
            conn.close()

    def song(self, filename, arrangement, exclude_id=None, part="", difficulty=""):
        rows = [r for r in self._rows(filename, arrangement, part, difficulty) if r["id"] != exclude_id]
        counted = [r for r in rows if is_counted(r)]
        best = max(counted, key=lambda r: (r["accuracy"], -r["id"]), default=None)
        best_score = max((r for r in counted if r["score"] is not None),
                         key=lambda r: (r["score"], -r["id"]), default=None)
        section_best = {}
        for r in rows:   # any run: section passes are only recorded at full speed
            try:
                det = json.loads(r["details"]) if r["details"] else None
            except ValueError:
                det = None
            secs = det.get("sections") if isinstance(det, dict) else None
            if not isinstance(secs, dict):
                continue
            for k, v in secs.items():
                if (isinstance(v, list) and v and isinstance(v[0], (int, float))
                        and not isinstance(v[0], bool) and v[0] > section_best.get(k, -1)):
                    section_best[k] = v[0]
        cutoff = datetime.now(timezone.utc) - WEEK
        old = [r["accuracy"] for r in counted if (_parse_ts(r["ts"]) or cutoff) < cutoff]
        runs = [{k: r[k] for k in ("ts", "accuracy", "hits", "misses", "best_streak", "score", "speed", "progress")}
                | {"complete": bool(r["complete"]), "looped": bool(r["looped"])}
                for r in reversed(rows[-HISTORY_LIMIT:])]
        return {
            "filename": filename, "arrangement": arrangement, "part": part, "difficulty": difficulty,
            "runs": runs, "run_count": len(rows),
            "best": {k: best[k] for k in ("ts", "accuracy", "best_streak")} if best else None,
            "best_score": {k: best_score[k] for k in ("ts", "score", "accuracy")} if best_score else None,
            "best_streak": max((r["best_streak"] or 0 for r in rows), default=0),
            "full_combos": sum(1 for r in counted if not r["misses"]),
            "section_best": section_best,
            "week_ago_best": max(old) if old else None,
            "first_counted": counted[0]["accuracy"] if counted else None,
            "practice_s": round(sum(r["played_s"] or 0 for r in rows)),
        }

    def bests(self, part=""):
        """Guitar (part ''): {filename: {arrangement: best}}; a part: {filename: {difficulty: best}}."""
        key = "difficulty" if part else "arrangement"
        conn = self._connect()
        try:
            rows = conn.execute(
                f"SELECT filename, {key} AS k, MAX(accuracy) AS acc, MAX(score) AS score, MIN(misses) AS min_misses"
                " FROM runs WHERE complete = 1 AND looped = 0 AND speed >= 0.999 AND part = ?"
                f" GROUP BY filename, {key}", (part,)).fetchall()
        finally:
            conn.close()
        out = {}
        for r in rows:
            out.setdefault(r["filename"], {})[r["k"]] = {
                "accuracy": r["acc"], "score": r["score"], "full_combo": r["min_misses"] == 0}
        return out

    # ── writes ──
    def add_run(self, d):
        if not isinstance(d, dict):
            raise RunError("expected a JSON object")
        filename = _text(d.get("filename"), 1024)
        if not filename:
            raise RunError("filename required")
        arrangement = _text(d.get("arrangement"), 200)
        part, difficulty = check_part(d.get("part", "") or "", d.get("difficulty", "") or "")
        hits = _int(d.get("hits"), 0, 1_000_000, "hits")
        misses = _int(d.get("misses"), 0, 1_000_000, "misses")
        if hits + misses < 1:
            raise RunError("a run needs at least one judged note")
        score = d.get("score")
        score = None if score is None else _int(round(_float(score, 0, 2 ** 53, "score", 0)), 0, 2 ** 53, "score")
        best_streak = _int(d.get("best_streak", 0) or 0, 0, 1_000_000, "best_streak")
        speed = _float(d.get("speed"), 0.01, 4, "speed", 1.0)
        progress = _float(d.get("progress"), 0, 1, "progress", 0.0)
        played_s = _float(d.get("played_s"), 0, 86_400, "played_s", 0.0)
        details = d.get("details")
        details_json = None
        if isinstance(details, dict):
            details_json = json.dumps(details, separators=(",", ":"))
            if len(details_json) > MAX_DETAILS_BYTES:
                self.log.warning("scorecard: run details too large (%d bytes), dropped", len(details_json))
                details_json = None
        acc = round(100.0 * hits / (hits + misses), 2)
        row = {"complete": 1 if d.get("complete") is True else 0, "looped": 1 if d.get("looped") is True else 0,
               "speed": speed}
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.execute(
                    "INSERT INTO runs (filename, arrangement, title, artist, ts, accuracy, hits, misses, best_streak,"
                    " score, complete, looped, speed, progress, played_s, details, part, difficulty)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (filename, arrangement, _text(d.get("title")), _text(d.get("artist")), _now_iso(), acc, hits,
                     misses, best_streak, score, row["complete"], row["looped"], speed, progress, played_s,
                     details_json, part, difficulty))
                conn.commit()
                run_id = cur.lastrowid
            finally:
                conn.close()
        before = self.song(filename, arrangement, exclude_id=run_id, part=part, difficulty=difficulty)
        out = self.song(filename, arrangement, part=part, difficulty=difficulty)
        counted = is_counted(row)
        prev_best = before["best"]["accuracy"] if before["best"] else None
        prev_best_score = before["best_score"]["score"] if before["best_score"] else None
        out.update(
            id=run_id, accuracy=acc, score=score, counted=counted,
            full_combo=counted and misses == 0,
            prev_best=prev_best, new_best=counted and prev_best is not None and acc > prev_best,
            first_full_run=counted and prev_best is None,
            prev_best_score=prev_best_score,
            new_best_score=counted and score is not None and prev_best_score is not None and score > prev_best_score,
            prev_section_best=before["section_best"],
        )
        return out


def _core_stats(meta_db, filename, log):
    """Core's per-song stats (plays / best accuracy across arrangements), or None."""
    getter = getattr(meta_db, "get_song_stats", None) if meta_db is not None else None
    if getter is None:
        return None
    try:
        s = getter(filename) or {}
    except Exception:   # an older/other core: the scorecard still works without it
        log.debug("scorecard: core song stats unavailable", exc_info=True)
        return None
    return {"plays": int(s.get("plays") or 0), "best_accuracy": s.get("best_accuracy")}


def setup(app, context):
    from fastapi import Body
    from fastapi.responses import JSONResponse

    log = context.get("log") or logging.getLogger("feedBack.plugin.scorecard")
    store = ScoreStore(Path(context["config_dir"]) / DB_NAME, log)   # validates the DB before any route mounts
    meta_db = context.get("meta_db")

    @app.get("/api/plugins/scorecard/song")
    def song(filename: str, arrangement: str = "", part: str = "", difficulty: str = ""):
        if not filename or len(filename) > 1024 or len(arrangement) > 200:
            return JSONResponse({"error": "bad filename or arrangement"}, status_code=400)
        try:
            check_part(part, difficulty)
        except RunError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        out = store.song(filename, arrangement, part=part, difficulty=difficulty)
        out["core"] = _core_stats(meta_db, filename, log)
        return out

    @app.post("/api/plugins/scorecard/run")
    def add_run(data: dict = Body(...)):
        try:
            out = store.add_run(data)
        except RunError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=400)
        out["core"] = _core_stats(meta_db, out["filename"], log)
        return {"ok": True, **out}

    @app.get("/api/plugins/scorecard/bests")
    def bests(part: str = ""):
        try:
            check_part(part, "")
        except RunError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        return store.bests(part)

    log.info("scorecard: run history at %s", store.path)
