# yay-style

Try on clothes from marketplaces (Wildberries now, Ozon next) on your own photo, and put
outfits together. Concept and roadmap: [docs/concept-and-plan.md](docs/concept-and-plan.md).

| Path | What |
|---|---|
| `services/` | Python backend: WB connector, garment preparation (cutout + keypoints), FastAPI. See [services/README.md](services/README.md) |
| `packages/tryon` | Browser try-on engine (TypeScript): MediaPipe person analysis, skeletal skinning, WebGL compositing |
| `apps/web` | Stage-0 try-on stand (React + Vite + Tailwind, PWA manifest) |
| `infra/` | Docker Compose for PostgreSQL/Redis (not used yet) |

## Run locally

```bash
# backend (first run: see services/README.md for venv setup)
services/.venv/bin/uvicorn yay_api.main:app --reload --port 8000 --app-dir services

# frontend
pnpm install
pnpm --filter @yay/web dev     # http://localhost:5173
```

The dev server proxies `/v1` and `/files` to the API, so garment cutouts are same-origin
WebGL textures.

**Shortcut for quick checks and the benchmark:** put a full-body photo into
`apps/web/public/dev/` (git-ignored) and open
`http://localhost:5173/?person=/dev/me.jpg&items=165101072,230915455`.

## How a try-on works

1. **Backend, once per product.** It picks the best photo, cuts the garment out, finds
   the model's joints, and paints over holes left by the model's hands.
2. **Browser, on every change.** MediaPipe finds the user's joints and the masks for
   hair, face and hands.
3. **Skinning.** The garment's torso follows the shoulders and hips; sleeves and trouser
   legs follow each limb segment.
4. **Drawing order, in WebGL:** user photo → garment layers (bottom → top → outerwear) →
   the user's hair, face and hands on top.

The user's photo never leaves the browser.

## Tests

```bash
pnpm --filter @yay/tryon test
cd services && .venv/bin/pytest
```
