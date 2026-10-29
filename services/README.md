# yay-style backend

Python 3.11+ · FastAPI · MediaPipe · rembg · OpenCV. Stage 0 keeps state in files under
`services/data/` (no database yet).

## Setup

```bash
cd services
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

The first garment preparation downloads model files (~200 MB): MediaPipe pose and
multiclass segmentation into `services/data/models/`, and the rembg background-removal
model into `~/.rembg/`.

## Run the API

```bash
.venv/bin/uvicorn yay_api.main:app --reload --port 8000
```

Open http://localhost:8000/docs for interactive docs.

| Endpoint | What it does |
|---|---|
| `GET /health` | Liveness |
| `POST /v1/products/resolve` `{"input": "<link or article>"}` | WB product card: name, category, photo URLs |
| `POST /v1/garments/prepare` `{"input": "...", "force": false}` | Analyse every photo of the product, cut the garment out, find anchor keypoints, pick the best photo |
| `POST /v1/garments/upload` (multipart `file`, `category`) | Same for a screenshot or photo the user uploads |
| `GET /files/garments/...` | Cutouts (`<n>.png`) and debug views (`<n>_debug.jpg`) |

Categories: `top`, `bottom`, `full` (dresses, jumpsuits), `outerwear`.

## Developer CLI

```bash
# prepare products and write a contact sheet of debug views (mask + keypoints)
.venv/bin/python -m yay_worker.cli prepare --sheet sheet.jpg 165101072 230915455
```

## Tests

```bash
.venv/bin/pytest                 # everything (needs internet: WB CDN + model download)
.venv/bin/pytest -m "not network"  # offline only
```

## How a garment is prepared

1. **Fetch the card.** WB blocks bots on the site and `card.wb.ru`, but the static CDN
   (`basket-NN.wbbasket.ru`) serves `card.json` and photos. The right host per product
   is found by probing and cached.
2. **Each photo:**
   - **Model photo:** pose (MediaPipe) → multiclass "clothes" mask → isolate the target
     garment using the skeleton, a body envelope, colour split vs. other clothes, and the
     garment's own palette.
   - **Flat-lay photo:** background removal (rembg), then keypoints are estimated from
     the silhouette.
3. **Score and pick the best photo.** Penalties for: back or side view, arms over the
   garment, garment cut by the frame, several people, collages, infographics.
4. **Save.** RGBA cutout and keypoints, in cutout coordinates, for the browser try-on engine.
