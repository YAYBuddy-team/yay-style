"""Stage-0 benchmark endpoints (dev mode only: they write files on the server).

Layout under data/bench/:
    garments.json            benchmark garments by category
    persons/persons.json     benchmark "user" photos: [{"id", "file", "sex"}]
    runs/<run>/renders/      try-on composites uploaded by the browser bench page
    runs/<run>/ratings.jsonl one verdict per line
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from yay_worker.settings import settings

router = APIRouter(prefix="/dev/bench", tags=["bench"])

_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
MAX_RENDER_BYTES = 8 * 1024 * 1024


def bench_dir() -> Path:
    return settings.data_dir / "bench"


def _safe(name: str) -> str:
    if not _NAME.match(name) or ".." in name:
        raise HTTPException(400, "Недопустимое имя")
    return name


def _run_dir(run: str) -> Path:
    return bench_dir() / "runs" / _safe(run)


@router.get("/config")
async def config() -> dict:
    garments_file = bench_dir() / "garments.json"
    persons_file = bench_dir() / "persons" / "persons.json"
    if not garments_file.exists() or not persons_file.exists():
        raise HTTPException(404, "Набор для бенчмарка не подготовлен")
    return {
        "garments": json.loads(garments_file.read_text()),
        "persons": json.loads(persons_file.read_text()),
    }


@router.put("/runs/{run}/renders/{name}")
async def save_render(run: str, name: str, request: Request) -> dict:
    body = await request.body()
    if not body or len(body) > MAX_RENDER_BYTES:
        raise HTTPException(413, "Пустой или слишком большой файл")
    out = _run_dir(run) / "renders"
    out.mkdir(parents=True, exist_ok=True)
    (out / _safe(name)).write_bytes(body)
    return {"saved": name}


@router.get("/runs/{run}/renders")
async def list_renders(run: str) -> list[str]:
    out = _run_dir(run) / "renders"
    return sorted(p.name for p in out.glob("*.jpg")) if out.exists() else []


class Rating(BaseModel):
    render: str
    verdict: str = Field(pattern="^(ok|bad)$")
    rater: str = Field(default="anon", max_length=40)


@router.post("/runs/{run}/ratings")
async def add_rating(run: str, rating: Rating) -> dict:
    _safe(rating.render)
    out = _run_dir(run)
    out.mkdir(parents=True, exist_ok=True)
    with (out / "ratings.jsonl").open("a") as f:
        f.write(json.dumps(rating.model_dump() | {"at": time.time()}, ensure_ascii=False) + "\n")
    return {"ok": True}


@router.get("/runs/{run}/ratings")
async def get_ratings(run: str) -> list[dict]:
    path = _run_dir(run) / "ratings.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
