"""Tests for routes.py — run storage, bests, validation and the core stats read."""

import importlib.util
import json
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


def _load_routes():
    spec = importlib.util.spec_from_file_location("scorecard_routes_under_test", ROOT / "routes.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


routes = _load_routes()


class FakeMetaDB:
    def __init__(self, plays=3, fail=False):
        self.plays, self.fail = plays, fail

    def get_song_stats(self, filename):
        if self.fail:
            raise RuntimeError("boom")
        return {"filename": filename, "best_accuracy": 0.9, "best_score": 10, "plays": self.plays, "arrangements": []}


@pytest.fixture
def client(tmp_path):
    app = FastAPI()
    routes.setup(app, {"config_dir": tmp_path, "log": logging.getLogger("test.scorecard"), "meta_db": FakeMetaDB()})
    return TestClient(app)


def run(**kw):
    body = {"filename": "Song.sloppak", "arrangement": "Lead", "title": "Song", "artist": "Band",
            "hits": 90, "misses": 10, "best_streak": 40, "score": 12000, "complete": True,
            "looped": False, "speed": 1.0, "progress": 1.0, "played_s": 200.0,
            "details": {"sections": {"0:intro": [80, 10], "1:verse": [95, 40]}, "strings": [[1, 0]]}}
    body.update(kw)
    return body


def test_import_does_no_work(tmp_path):
    # Importing the module must not touch the filesystem (spec best practice 5).
    assert not (tmp_path / routes.DB_NAME).exists()
    assert routes.DB_NAME == "scorecard.db"


def test_setup_creates_db_in_config_dir(client, tmp_path):
    assert (tmp_path / "scorecard.db").is_file()


def test_empty_song(client):
    r = client.get("/api/plugins/scorecard/song", params={"filename": "Song.sloppak", "arrangement": "Lead"})
    assert r.status_code == 200
    d = r.json()
    assert d["runs"] == [] and d["run_count"] == 0
    assert d["best"] is None and d["best_score"] is None
    assert d["core"] == {"plays": 3, "best_accuracy": 0.9}


def test_first_run_then_new_best(client):
    d = client.post("/api/plugins/scorecard/run", json=run()).json()
    assert d["ok"] and d["counted"] and d["first_full_run"]
    assert d["accuracy"] == 90.0
    assert d["new_best"] is False and d["prev_best"] is None
    assert d["best"]["accuracy"] == 90.0
    assert d["section_best"] == {"0:intro": 80, "1:verse": 95}

    d = client.post("/api/plugins/scorecard/run", json=run(hits=95, misses=5, score=15000,
                    details={"sections": {"0:intro": [90, 10]}})).json()
    assert d["new_best"] and d["prev_best"] == 90.0
    assert d["new_best_score"] and d["prev_best_score"] == 12000
    assert d["prev_section_best"] == {"0:intro": 80, "1:verse": 95}
    assert d["section_best"]["0:intro"] == 90
    assert d["run_count"] == 2
    assert [x["accuracy"] for x in d["runs"]] == [95.0, 90.0]   # newest first


def test_practice_runs_dont_count(client):
    client.post("/api/plugins/scorecard/run", json=run())
    for kw in ({"speed": 0.75, "hits": 100, "misses": 0}, {"complete": False, "hits": 100, "misses": 0},
               {"looped": True, "hits": 100, "misses": 0}):
        d = client.post("/api/plugins/scorecard/run", json=run(**kw)).json()
        assert d["ok"] and not d["counted"] and not d["new_best"] and not d["full_combo"]
    assert d["best"]["accuracy"] == 90.0
    assert d["run_count"] == 4
    assert d["runs"][0]["looped"] is True


def test_full_combo(client):
    d = client.post("/api/plugins/scorecard/run", json=run(hits=50, misses=0)).json()
    assert d["full_combo"] and d["full_combos"] == 1


def test_arrangements_are_separate(client):
    client.post("/api/plugins/scorecard/run", json=run())
    d = client.get("/api/plugins/scorecard/song", params={"filename": "Song.sloppak", "arrangement": "Bass"}).json()
    assert d["run_count"] == 0


def test_bests(client):
    client.post("/api/plugins/scorecard/run", json=run())
    client.post("/api/plugins/scorecard/run", json=run(hits=100, misses=0, score=20000))
    client.post("/api/plugins/scorecard/run", json=run(arrangement="Bass", speed=0.5))
    b = client.get("/api/plugins/scorecard/bests").json()
    assert b == {"Song.sloppak": {"Lead": {"accuracy": 100.0, "score": 20000, "full_combo": True}}}


@pytest.mark.parametrize("bad", [
    {"filename": ""}, {"hits": 0, "misses": 0}, {"hits": -1}, {"hits": True}, {"hits": 1.5},
    {"speed": 0}, {"progress": 2}, {"score": -5}, {"score": "x"}, {"filename": 5},
])
def test_validation(client, bad):
    r = client.post("/api/plugins/scorecard/run", json=run(**bad))
    assert r.status_code == 400
    assert r.json()["ok"] is False


def test_non_object_body_rejected(client):
    r = client.post("/api/plugins/scorecard/run", json=[1, 2])
    assert r.status_code in (400, 422)


def test_oversized_details_dropped(client, tmp_path):
    d = client.post("/api/plugins/scorecard/run", json=run(details={"sections": {}, "blob": "x" * 70_000})).json()
    assert d["ok"]
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / "scorecard.db"))
    try:
        assert conn.execute("SELECT details FROM runs").fetchone()[0] is None
    finally:
        conn.close()


def test_score_may_be_absent(client):
    d = client.post("/api/plugins/scorecard/run", json=run(score=None)).json()
    assert d["ok"] and d["score"] is None and d["best_score"] is None


def test_corrupt_details_ignored(client, tmp_path):
    client.post("/api/plugins/scorecard/run", json=run())
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / "scorecard.db"))
    conn.execute("UPDATE runs SET details = ?", ("not json",))
    conn.execute("INSERT INTO runs (filename, arrangement, ts, accuracy, hits, misses, details)"
                 " VALUES ('Song.sloppak', 'Lead', '2026-01-01T00:00:00Z', 50, 1, 1, ?)", (json.dumps([1, 2]),))
    conn.commit()
    conn.close()
    d = client.get("/api/plugins/scorecard/song", params={"filename": "Song.sloppak", "arrangement": "Lead"}).json()
    assert d["section_best"] == {}
    assert d["run_count"] == 2


def test_week_ago_best(client, tmp_path):
    client.post("/api/plugins/scorecard/run", json=run())
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / "scorecard.db"))
    conn.execute("UPDATE runs SET ts = '2020-01-01T00:00:00Z'")
    conn.commit()
    conn.close()
    d = client.post("/api/plugins/scorecard/run", json=run(hits=99, misses=1)).json()
    assert d["week_ago_best"] == 90.0


def test_core_stats_optional(tmp_path):
    for meta in (None, FakeMetaDB(fail=True), object()):
        app = FastAPI()
        routes.setup(app, {"config_dir": tmp_path, "log": logging.getLogger("t"), "meta_db": meta})
        d = TestClient(app).get("/api/plugins/scorecard/song", params={"filename": "a"}).json()
        assert d["core"] is None


def test_bad_query(client):
    r = client.get("/api/plugins/scorecard/song", params={"filename": "x" * 2000})
    assert r.status_code == 400


# ── parts (drums / 5-fret runs from RockHeroSmith's play:result) ──

def drum_run(**kw):
    body = run(arrangement="", part="drums", difficulty="expert", details={"sections": {}})
    body.update(kw)
    return body


def test_part_runs_are_separate_from_guitar(client):
    client.post("/api/plugins/scorecard/run", json=run())
    d = client.post("/api/plugins/scorecard/run", json=drum_run(hits=80, misses=20)).json()
    assert d["ok"] and d["part"] == "drums" and d["difficulty"] == "expert"
    assert d["run_count"] == 1 and d["first_full_run"] and d["best"]["accuracy"] == 80.0
    g = client.get("/api/plugins/scorecard/song", params={"filename": "Song.sloppak", "arrangement": "Lead"}).json()
    assert g["run_count"] == 1 and g["best"]["accuracy"] == 90.0 and g["part"] == "" and g["difficulty"] == ""
    p = client.get("/api/plugins/scorecard/song",
                   params={"filename": "Song.sloppak", "part": "drums", "difficulty": "expert"}).json()
    assert p["run_count"] == 1 and p["best"]["accuracy"] == 80.0


def test_part_difficulties_and_parts_are_separate(client):
    client.post("/api/plugins/scorecard/run", json=drum_run())
    for params in ({"part": "drums", "difficulty": "hard"}, {"part": "five_fret:bass", "difficulty": "expert"}):
        d = client.get("/api/plugins/scorecard/song", params={"filename": "Song.sloppak", **params}).json()
        assert d["run_count"] == 0
    d = client.post("/api/plugins/scorecard/run", json=drum_run(part="five_fret:bass")).json()
    assert d["run_count"] == 1 and d["part"] == "five_fret:bass"


def test_part_bests(client):
    client.post("/api/plugins/scorecard/run", json=run())
    client.post("/api/plugins/scorecard/run", json=drum_run(hits=100, misses=0, score=5000))
    client.post("/api/plugins/scorecard/run", json=drum_run(difficulty="hard"))
    b = client.get("/api/plugins/scorecard/bests").json()
    assert b == {"Song.sloppak": {"Lead": {"accuracy": 90.0, "score": 12000, "full_combo": False}}}   # unchanged shape
    p = client.get("/api/plugins/scorecard/bests", params={"part": "drums"}).json()
    assert p == {"Song.sloppak": {"expert": {"accuracy": 100.0, "score": 5000, "full_combo": True},
                                  "hard": {"accuracy": 90.0, "score": 12000, "full_combo": False}}}


@pytest.mark.parametrize("bad", [
    {"part": "Drums"}, {"part": "drums:"}, {"part": "a:b:c"}, {"part": 5}, {"difficulty": "insane"},
    {"difficulty": "expert", "part": ""},
])
def test_part_validation(client, bad):
    r = client.post("/api/plugins/scorecard/run", json=drum_run(**bad))
    assert r.status_code == 400


def test_part_query_validation(client):
    for params in ({"part": "Bad!"}, {"part": "drums", "difficulty": "nope"}):
        r = client.get("/api/plugins/scorecard/song", params={"filename": "a", **params})
        assert r.status_code == 400
    assert client.get("/api/plugins/scorecard/bests", params={"part": "Bad!"}).status_code == 400


def test_migrates_an_old_db_idempotently(tmp_path):
    import sqlite3
    path = tmp_path / "scorecard.db"
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, arrangement TEXT NOT NULL,
            title TEXT, artist TEXT, ts TEXT NOT NULL, accuracy REAL NOT NULL, hits INTEGER NOT NULL,
            misses INTEGER NOT NULL, best_streak INTEGER NOT NULL DEFAULT 0, score INTEGER,
            complete INTEGER NOT NULL DEFAULT 0, looped INTEGER NOT NULL DEFAULT 0, speed REAL NOT NULL DEFAULT 1,
            progress REAL NOT NULL DEFAULT 0, played_s REAL NOT NULL DEFAULT 0, details TEXT);
        CREATE INDEX idx_runs_song ON runs(filename, arrangement);
        INSERT INTO runs (filename, arrangement, ts, accuracy, hits, misses, complete)
            VALUES ('Song.sloppak', 'Lead', '2026-01-01T00:00:00Z', 75, 75, 25, 1);
    """)
    conn.commit()
    conn.close()
    for _ in range(2):   # opening twice must not fail or duplicate anything
        store = routes.ScoreStore(path)
    d = store.song("Song.sloppak", "Lead")
    assert d["run_count"] == 1 and d["best"]["accuracy"] == 75.0
    assert store.song("Song.sloppak", "", part="drums", difficulty="expert")["run_count"] == 0
    conn = sqlite3.connect(str(path))
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(runs)")]
        assert cols.count("part") == 1 and cols.count("difficulty") == 1
        assert conn.execute("SELECT part, difficulty FROM runs").fetchone() == ("", "")
    finally:
        conn.close()
