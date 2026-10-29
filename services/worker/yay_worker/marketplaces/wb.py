"""Wildberries connector.

The public site and `card.wb.ru` sit behind anti-bot protection (403/498 for plain HTTP
clients), but the static CDN (`basket-NN.wbbasket.ru`) serves the card JSON and photos
openly. Each product lives on one basket host chosen by its `vol` (product_id // 100000).
WB adds hosts as the catalogue grows, so instead of hard-coding the vol→host table we
probe the hosts and remember which one answered for each vol.
"""

from __future__ import annotations

import asyncio
import re

import httpx

from .base import Marketplace, ProductCard, ProductNotFound, ProductRef
from .categories import categorize

# 65 hosts existed in Oct 2026; probing a few non-existent ones costs only a DNS miss.
MAX_BASKET = 72
_URL_RE = re.compile(r"(?:wildberries\.(?:ru|by|kz|am|kg|uz)|wb\.ru)/catalog/(\d+)")
_ARTICLE_RE = re.compile(r"^\s*(\d{5,12})\s*$")

_vol_host_cache: dict[int, int] = {}


def parse_wb(text: str) -> ProductRef | None:
    m = _URL_RE.search(text) or _ARTICLE_RE.match(text)
    if not m:
        return None
    return ProductRef(Marketplace.WB, int(m.group(1)))


def _paths(nm: int) -> tuple[int, str]:
    vol, part = nm // 100_000, nm // 1_000
    return vol, f"vol{vol}/part{part}/{nm}"


def _host(n: int) -> str:
    return f"https://basket-{n:02d}.wbbasket.ru"


def _guess_hosts(vol: int) -> list[int]:
    """Hosts are assigned to vol ranges in increasing order, so the host of the nearest
    already-seen vol (and its neighbours) is the most likely answer."""
    if not _vol_host_cache:
        return []
    nearest = min(_vol_host_cache, key=lambda v: abs(v - vol))
    h = _vol_host_cache[nearest]
    step = 1 if vol >= nearest else -1
    return [n for n in (h, h + step, h + 2 * step, h - step) if 1 <= n <= MAX_BASKET]


async def _find_basket(client: httpx.AsyncClient, nm: int) -> tuple[int, dict]:
    vol, path = _paths(nm)

    async def probe(n: int) -> tuple[int, dict] | None:
        try:
            resp = await client.get(f"{_host(n)}/{path}/info/ru/card.json")
        except httpx.HTTPError:
            return None
        return (n, resp.json()) if resp.status_code == 200 else None

    guesses = [_vol_host_cache[vol]] if vol in _vol_host_cache else _guess_hosts(vol)
    rest = [n for n in range(1, MAX_BASKET + 1) if n not in guesses]
    for batch in (guesses, rest):
        if not batch:
            continue
        tasks = [asyncio.create_task(probe(n)) for n in batch]
        try:
            for next_done in asyncio.as_completed(tasks):
                found = await next_done
                if found:
                    _vol_host_cache[vol] = found[0]
                    return found
        finally:
            for t in tasks:
                t.cancel()
    raise ProductNotFound(f"WB article {nm} not found on any basket host")


async def fetch_wb_card(client: httpx.AsyncClient, nm: int) -> ProductCard:
    basket, data = await _find_basket(client, nm)
    _, path = _paths(nm)
    photo_count = int((data.get("media") or {}).get("photo_count") or 0)
    images = [f"{_host(basket)}/{path}/images/big/{i}.webp" for i in range(1, photo_count + 1)]
    name = (data.get("imt_name") or "").strip()
    subject = data.get("subj_name") or ""
    subject_root = data.get("subj_root_name") or ""
    return ProductCard(
        ref=ProductRef(Marketplace.WB, nm),
        name=name,
        subject=subject,
        subject_root=subject_root,
        category=categorize(subject, name, subject_root),
        color=data.get("nm_colors_names") or None,
        composition=[c["name"] for c in data.get("compositions") or [] if c.get("name")],
        image_urls=images,
        product_url=f"https://www.wildberries.ru/catalog/{nm}/detail.aspx",
        extra={"basket": basket, "vendor_code": data.get("vendor_code")},
    )
