from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Marketplace(StrEnum):
    WB = "wb"
    OZON = "ozon"


class GarmentCategory(StrEnum):
    TOP = "top"  # футболки, рубашки, свитеры
    BOTTOM = "bottom"  # брюки, джинсы, юбки, шорты
    FULL = "full"  # платья, комбинезоны
    OUTERWEAR = "outerwear"  # куртки, пальто, пиджаки
    UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class ProductRef:
    marketplace: Marketplace
    product_id: int


@dataclass
class ProductCard:
    ref: ProductRef
    name: str
    subject: str
    subject_root: str
    category: GarmentCategory
    color: str | None
    composition: list[str]
    image_urls: list[str]
    product_url: str
    extra: dict = field(default_factory=dict)


class ProductNotFound(Exception):
    pass


class UnsupportedInput(Exception):
    pass
