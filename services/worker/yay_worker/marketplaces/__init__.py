from __future__ import annotations

import re

import httpx

from .base import (
    GarmentCategory,
    Marketplace,
    ProductCard,
    ProductNotFound,
    ProductRef,
    UnsupportedInput,
)
from .wb import fetch_wb_card, parse_wb

_OZON_RE = re.compile(r"ozon\.ru/(?:product|t)/(?:[\w-]*-)?(\d+)")

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) yay-style/0.1"


def parse_input(text: str) -> ProductRef:
    """Turn a pasted link or bare article number into a product reference."""
    ref = parse_wb(text)
    if ref:
        return ref
    m = _OZON_RE.search(text)
    if m:
        return ProductRef(Marketplace.OZON, int(m.group(1)))
    raise UnsupportedInput("Не удалось распознать ссылку или артикул")


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(10.0),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=80),
    )


async def fetch_card(client: httpx.AsyncClient, ref: ProductRef) -> ProductCard:
    if ref.marketplace is Marketplace.WB:
        return await fetch_wb_card(client, ref.product_id)
    raise UnsupportedInput("Ozon появится на следующем этапе — пока загрузите скриншот вещи")


__all__ = [
    "GarmentCategory",
    "Marketplace",
    "ProductCard",
    "ProductNotFound",
    "ProductRef",
    "UnsupportedInput",
    "fetch_card",
    "make_client",
    "parse_input",
]
