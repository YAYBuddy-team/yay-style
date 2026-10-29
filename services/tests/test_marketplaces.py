import pytest

from yay_worker.marketplaces import (
    GarmentCategory,
    Marketplace,
    ProductNotFound,
    ProductRef,
    UnsupportedInput,
    fetch_card,
    make_client,
    parse_input,
)
from yay_worker.marketplaces.categories import categorize


@pytest.mark.parametrize(
    "text,expected",
    [
        ("https://www.wildberries.ru/catalog/231184961/detail.aspx", 231184961),
        ("https://www.wildberries.ru/catalog/231184961/detail.aspx?size=123&targetUrl=GP", 231184961),
        ("wildberries.by/catalog/165101072/detail.aspx", 165101072),
        ("Смотри: https://wb.ru/catalog/165101072/detail.aspx", 165101072),
        ("  231184961 ", 231184961),
    ],
)
def test_parse_wb(text, expected):
    assert parse_input(text) == ProductRef(Marketplace.WB, expected)


def test_parse_ozon():
    ref = parse_input("https://www.ozon.ru/product/futbolka-zhenskaya-1234567890/?asb=1")
    assert ref == ProductRef(Marketplace.OZON, 1234567890)


@pytest.mark.parametrize("text", ["привет", "https://example.com/item/1", "12"])
def test_parse_garbage(text):
    with pytest.raises(UnsupportedInput):
        parse_input(text)


@pytest.mark.parametrize(
    "subject,name,root,expected",
    [
        ("Футболки", "Футболка с принтом", "Одежда", GarmentCategory.TOP),
        ("Поло", "Футболка поло", "Одежда", GarmentCategory.TOP),
        ("Худи", "", "Одежда", GarmentCategory.TOP),
        ("Платья", "платье рубашка", "Одежда", GarmentCategory.FULL),
        ("Сарафаны", "", "Одежда", GarmentCategory.FULL),
        ("Юбки", "", "Одежда", GarmentCategory.BOTTOM),
        ("Брюки спортивные", "", "Спортивная одежда", GarmentCategory.BOTTOM),
        ("Джинсы", "", "Одежда", GarmentCategory.BOTTOM),
        ("Пиджаки", "", "Одежда", GarmentCategory.OUTERWEAR),
        ("Шубы натуральные", "", "Одежда", GarmentCategory.OUTERWEAR),
        ("Костюмы", "Костюм с брюками и майкой", "Одежда", GarmentCategory.UNSUPPORTED),
        ("Тест-полоски крови", "", "Здоровье", GarmentCategory.UNSUPPORTED),
        ("Полотенца-пончо", "", "Дом", GarmentCategory.UNSUPPORTED),
        ("Купальники", "", "Одежда", GarmentCategory.UNSUPPORTED),
        ("Плавательные жилеты", "Жилет для плавания", "Одежда", GarmentCategory.UNSUPPORTED),
    ],
)
def test_categorize(subject, name, root, expected):
    assert categorize(subject, name, root) == expected


@pytest.mark.network
async def test_fetch_wb_card_live():
    async with make_client() as client:
        card = await fetch_card(client, ProductRef(Marketplace.WB, 231184961))
    assert card.subject == "Футболки"
    assert card.category is GarmentCategory.TOP
    assert card.image_urls and all(u.endswith(".webp") for u in card.image_urls)


@pytest.mark.network
async def test_fetch_wb_missing_live():
    async with make_client() as client:
        with pytest.raises(ProductNotFound):
            await fetch_card(client, ProductRef(Marketplace.WB, 4_999_999_999))


async def test_ozon_not_yet_supported():
    async with make_client() as client:
        with pytest.raises(UnsupportedInput):
            await fetch_card(client, ProductRef(Marketplace.OZON, 1))
