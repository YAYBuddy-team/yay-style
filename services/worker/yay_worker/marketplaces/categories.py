"""Map marketplace subject names (e.g. WB `subj_name`) to our garment categories."""

from __future__ import annotations

from .base import GarmentCategory

# Matched as lowercase prefixes, so "футболк" covers "Футболки" and "Футболка".
# Order matters: the first matching group wins ("платье-рубашка" must be FULL, not TOP).
_RULES: list[tuple[GarmentCategory, tuple[str, ...]]] = [
    (
        GarmentCategory.UNSUPPORTED,
        (
            "трус", "бюстгальтер", "белье", "бельё", "купальник", "плавк", "носк", "колготк",
            "чулк", "пижам", "халат", "сорочк ноч", "боди", "корсет", "пояс", "шапк", "шарф",
            "перчат", "варежк", "обув", "кроссов", "ботин", "туфл", "сапог", "сумк", "рюкзак",
            "очки", "серьг", "кольц", "часы", "ремн", "ремен",
            # home textiles that would otherwise hit short clothing stems ("поло" → "полотенце")
            "полотен", "одеял", "постел", "плед",
            # sets of several garments ("Костюм с брюками и майкой") need splitting first
            "костюм", "комплект",
            # gear that only shares a word with clothes ("Плавательные жилеты")
            "плавательн", "спасательн", "утяжел",
        ),
    ),
    (GarmentCategory.FULL, ("плать", "сарафан", "комбинезон", "ромпер")),
    (
        GarmentCategory.OUTERWEAR,
        (
            "куртк", "пальто", "пуховик", "парк", "плащ", "тренч", "ветровк", "бомбер",
            "пиджак", "жакет", "блейзер", "жилет", "шуб", "дублен", "косух", "анорак",
        ),
    ),
    (
        GarmentCategory.TOP,
        (
            "футболк", "лонгслив", "рубашк", "блуз", "свитер", "джемпер", "кардиган",
            "толстовк", "худи", "свитшот", "майк", "топ", "водолазк", "поло", "туник",
            "кофт", "пуловер", "кроп", "рубаш",
        ),
    ),
    (
        GarmentCategory.BOTTOM,
        ("брюк", "джинс", "юбк", "шорт", "леггинс", "лосин", "бридж", "кюлот", "джогер", "чинос"),
    ),
]


# Top-level marketplace sections that contain wearable clothes. Anything else
# ("Дом", "Здоровье", ...) is rejected before stem matching, so "Тест-полоски" never
# becomes a top because "полоски" starts with "поло".
_CLOTHING_ROOTS = ("одежд", "спортивн", "белье", "бельё", "женщин", "мужчин", "детям")


def categorize(subject: str, name: str = "", subject_root: str = "") -> GarmentCategory:
    """Classify by subject first (most reliable), then by product name."""
    root = subject_root.lower()
    if root and not any(r in root for r in _CLOTHING_ROOTS):
        return GarmentCategory.UNSUPPORTED
    for text in (subject, name):
        cat = _match(text)
        if cat is not None:
            return cat
    return GarmentCategory.UNSUPPORTED


def _match(text: str) -> GarmentCategory | None:
    words = text.lower().replace("-", " ").split()
    for category, stems in _RULES:
        for word in words:
            if any(word.startswith(stem) for stem in stems):
                return category
    return None
