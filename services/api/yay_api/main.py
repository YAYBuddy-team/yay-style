from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import UnidentifiedImageError
from pydantic import BaseModel, Field

from yay_worker.garment.service import GarmentResult, prepare_product, prepare_upload
from yay_worker.marketplaces import (
    GarmentCategory,
    ProductNotFound,
    UnsupportedInput,
    fetch_card,
    make_client,
    parse_input,
)
from yay_worker.settings import settings

MAX_UPLOAD_BYTES = 15 * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.garments_dir.mkdir(parents=True, exist_ok=True)
    async with make_client() as client:
        app.state.http = client
        yield


app = FastAPI(title="yay-style API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
settings.garments_dir.mkdir(parents=True, exist_ok=True)
app.mount("/files/garments", StaticFiles(directory=settings.garments_dir), name="garments")

if settings.dev_mode:
    from .bench import bench_dir
    from .bench import router as bench_router

    bench_dir().mkdir(parents=True, exist_ok=True)
    app.include_router(bench_router)
    app.mount("/files/bench", StaticFiles(directory=bench_dir()), name="bench")


class ProductInput(BaseModel):
    input: str = Field(..., description="Ссылка на товар или артикул", min_length=3)


class PrepareInput(ProductInput):
    force: bool = False


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/v1/products/resolve")
async def resolve_product(body: ProductInput, request: Request) -> dict:
    card = await _fetch(body.input, request)
    data = asdict(card)
    data["ref"] = {"marketplace": str(card.ref.marketplace), "product_id": card.ref.product_id}
    return data


@app.post("/v1/garments/prepare")
async def prepare_garment(body: PrepareInput, request: Request) -> dict:
    card = await _fetch(body.input, request)
    if card.category is GarmentCategory.UNSUPPORTED:
        raise HTTPException(
            422, f"Категория «{card.subject}» пока не поддерживается для примерки"
        )
    result = await prepare_product(request.app.state.http, card, force=body.force)
    return _garment_response(result, request) | {
        "product": {"name": card.name, "subject": card.subject, "url": card.product_url}
    }


@app.post("/v1/garments/upload")
async def upload_garment(
    request: Request,
    file: UploadFile = File(...),
    category: GarmentCategory = Form(...),
) -> dict:
    if category is GarmentCategory.UNSUPPORTED:
        raise HTTPException(422, "Выберите категорию вещи")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Файл больше 15 МБ")
    try:
        result = await prepare_upload(data, category)
    except UnidentifiedImageError:
        raise HTTPException(400, "Не удалось открыть изображение") from None
    return _garment_response(result, request)


async def _fetch(text: str, request: Request):
    try:
        ref = parse_input(text)
        return await fetch_card(request.app.state.http, ref)
    except UnsupportedInput as e:
        raise HTTPException(422, str(e)) from None
    except ProductNotFound:
        raise HTTPException(404, "Товар не найден") from None


def _garment_response(result: GarmentResult, request: Request) -> dict:
    base = str(request.base_url).rstrip("/") + f"/files/garments/{result.key}"
    photos = []
    for p in asdict(result)["photos"]:
        p["cutout_url"] = f"{base}/{p['cutout']}" if p["cutout"] else None
        p["debug_url"] = f"{base}/{p['debug']}" if p["debug"] else None
        photos.append(p)
    return {
        "key": result.key,
        "category": result.category,
        "usable": result.usable,
        "best_index": result.best_index,
        "unusable_reason": result.unusable_reason,
        "photos": photos,
    }
