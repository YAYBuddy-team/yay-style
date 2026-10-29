"""Benchmark dev endpoints, exercised on a throwaway data dir."""

import importlib
import json

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    from yay_worker import settings as settings_mod

    monkeypatch.setattr(settings_mod.settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings_mod.settings, "dev_mode", True)
    from yay_api import main

    importlib.reload(main)  # router is included at import time, depending on dev_mode
    (tmp_path / "bench" / "persons").mkdir(parents=True)
    (tmp_path / "bench" / "garments.json").write_text(json.dumps({"top": [{"id": 1}]}))
    (tmp_path / "bench" / "persons" / "persons.json").write_text(
        json.dumps([{"id": "p1", "file": "p1.jpg", "sex": "f"}])
    )
    with TestClient(main.app) as c:
        yield c
    monkeypatch.setattr(settings_mod.settings, "dev_mode", False)
    importlib.reload(main)


def test_config(client):
    body = client.get("/dev/bench/config").json()
    assert body["garments"]["top"][0]["id"] == 1
    assert body["persons"][0]["id"] == "p1"


def test_render_roundtrip_and_ratings(client):
    r = client.put("/dev/bench/runs/r1/renders/p1__wb-1.jpg", content=b"\xff\xd8jpeg")
    assert r.status_code == 200
    assert client.get("/dev/bench/runs/r1/renders").json() == ["p1__wb-1.jpg"]
    assert client.get("/files/bench/runs/r1/renders/p1__wb-1.jpg").content == b"\xff\xd8jpeg"

    client.post("/dev/bench/runs/r1/ratings", json={"render": "p1__wb-1.jpg", "verdict": "ok"})
    ratings = client.get("/dev/bench/runs/r1/ratings").json()
    assert ratings[0]["verdict"] == "ok" and ratings[0]["render"] == "p1__wb-1.jpg"


@pytest.mark.parametrize("name", ["../x.jpg", "a/b.jpg", "..", "x" * 200])
def test_rejects_unsafe_names(client, name):
    r = client.put(f"/dev/bench/runs/r1/renders/{name}", content=b"x")
    assert r.status_code in (400, 404)


def test_rejects_bad_verdict(client):
    r = client.post("/dev/bench/runs/r1/ratings", json={"render": "a.jpg", "verdict": "maybe"})
    assert r.status_code == 422


def test_disabled_without_dev_mode():
    from yay_api import main

    with TestClient(main.app) as c:
        assert c.get("/dev/bench/config").status_code == 404
