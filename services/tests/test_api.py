"""API tests. Those marked `network` hit the real WB CDN and run the vision models
(the first run downloads ~200 MB of model files)."""

import io

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from yay_api.main import app

TEE_ON_MODEL = "https://www.wildberries.ru/catalog/165101072/detail.aspx"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_resolve_rejects_garbage(client):
    r = client.post("/v1/products/resolve", json={"input": "просто текст"})
    assert r.status_code == 422


def test_ozon_not_yet(client):
    r = client.post("/v1/products/resolve", json={"input": "https://www.ozon.ru/product/x-123456/"})
    assert r.status_code == 422
    assert "Ozon" in r.json()["detail"]


def test_upload_rejects_non_image(client):
    r = client.post(
        "/v1/garments/upload",
        files={"file": ("x.png", b"not an image", "image/png")},
        data={"category": "top"},
    )
    assert r.status_code == 400


@pytest.mark.network
def test_resolve_wb(client):
    r = client.post("/v1/products/resolve", json={"input": TEE_ON_MODEL})
    assert r.status_code == 200
    body = r.json()
    assert body["ref"] == {"marketplace": "wb", "product_id": 165101072}
    assert body["category"] == "top"
    assert len(body["image_urls"]) >= 1


@pytest.mark.network
def test_resolve_missing_wb(client):
    r = client.post("/v1/products/resolve", json={"input": "4999999999"})
    assert r.status_code == 404


@pytest.mark.network
def test_prepare_unsupported_category(client):
    # 165036476 is a children's beach poncho towel ("Дом" section).
    r = client.post("/v1/garments/prepare", json={"input": "165036476"})
    assert r.status_code == 422


@pytest.mark.network
def test_prepare_wb_tee(client):
    r = client.post("/v1/garments/prepare", json={"input": TEE_ON_MODEL})
    assert r.status_code == 200
    body = r.json()
    assert body["usable"] and body["category"] == "top"
    best = next(p for p in body["photos"] if p["index"] == body["best_index"])
    assert best["kind"] == "model"
    for name in ("left_shoulder", "right_shoulder", "left_hip", "right_hip"):
        kp = best["keypoints"][name]
        assert 0 <= kp["x"] <= best["width"] and 0 <= kp["y"] <= best["height"]

    # The cutout is served and is a transparent PNG of the declared size.
    path = httpx.URL(best["cutout_url"]).path
    png = client.get(path)
    assert png.status_code == 200
    img = Image.open(io.BytesIO(png.content))
    assert img.mode == "RGBA" and img.size == (best["width"], best["height"])


@pytest.mark.network
def test_upload_photo_of_garment(client):
    """Screenshot fallback: upload a product photo directly."""
    card = client.post("/v1/products/resolve", json={"input": "231184961"}).json()
    photo = httpx.get(card["image_urls"][0]).content
    r = client.post(
        "/v1/garments/upload",
        files={"file": ("tee.webp", photo, "image/webp")},
        data={"category": "top"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["usable"] and body["key"].startswith("upload/")
    assert body["photos"][0]["kind"] == "flatlay"
