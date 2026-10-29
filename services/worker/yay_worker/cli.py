"""Developer CLI.

    python -m yay_worker.cli prepare 231184961 https://www.wildberries.ru/catalog/165101072/detail.aspx
    python -m yay_worker.cli prepare --force --sheet sheet.jpg 231184961 165101072

`--sheet` writes a contact sheet with every photo's debug view (mask + keypoints),
which is the quickest way to eyeball the pipeline on a batch of real products.
"""

from __future__ import annotations

import argparse
import asyncio
import time
from pathlib import Path

from PIL import Image, ImageDraw

from .garment.service import GarmentResult, garment_dir, prepare_product
from .marketplaces import GarmentCategory, fetch_card, make_client, parse_input


async def _prepare(inputs: list[str], force: bool) -> list[tuple[str, GarmentResult | str]]:
    results: list[tuple[str, GarmentResult | str]] = []
    async with make_client() as client:
        for text in inputs:
            t0 = time.time()
            try:
                card = await fetch_card(client, parse_input(text))
            except Exception as e:  # noqa: BLE001 - report and continue the batch
                results.append((text, f"error: {e}"))
                continue
            if card.category is GarmentCategory.UNSUPPORTED:
                results.append((text, f"unsupported: {card.subject}"))
                continue
            res = await prepare_product(client, card, force=force)
            best = next((p for p in res.photos if p.index == res.best_index), None)
            print(
                f"{text}: {card.subject} [{card.category}] photos={len(res.photos)} "
                f"best={res.best_index} score={best.score if best else 0:.2f} "
                f"({time.time() - t0:.1f}s)"
            )
            for p in res.photos:
                mark = "*" if p.index == res.best_index else " "
                print(f"   {mark}{p.index}: {p.kind:8} {p.score:.2f} {'; '.join(p.reasons)}")
            results.append((text, res))
    return results


def _sheet(results: list[tuple[str, GarmentResult | str]], out: Path, thumb: int = 220) -> None:
    rows = [(t, r) for t, r in results if isinstance(r, GarmentResult)]
    cols = max((len(r.photos) for _, r in rows), default=1)
    sheet = Image.new("RGB", (cols * thumb, len(rows) * int(thumb * 1.4)), "white")
    for y, (_, res) in enumerate(rows):
        for x, p in enumerate(res.photos):
            if not p.debug:
                continue
            im = Image.open(garment_dir(res.key) / p.debug)
            im.thumbnail((thumb, int(thumb * 1.4)))
            if p.index == res.best_index:
                ImageDraw.Draw(im).rectangle([0, 0, im.width - 1, im.height - 1], outline="lime", width=6)
            sheet.paste(im, (x * thumb, y * int(thumb * 1.4)))
    sheet.save(out, quality=85)
    print(f"sheet: {out}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="yay_worker.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="prepare garments for products")
    p.add_argument("inputs", nargs="+", help="links or WB articles")
    p.add_argument("--force", action="store_true", help="ignore cache")
    p.add_argument("--sheet", type=Path, help="write a contact sheet of debug images")
    args = parser.parse_args()

    results = asyncio.run(_prepare(args.inputs, args.force))
    if args.sheet:
        _sheet(results, args.sheet)


if __name__ == "__main__":
    main()
