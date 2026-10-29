from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICES_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="YAY_", env_file=".env", extra="ignore")

    data_dir: Path = SERVICES_DIR / "data"
    # rembg model for background removal. isnet-general-use (DIS, Apache-2.0);
    # `u2net_cloth_seg` is deliberately avoided: its training data is non-commercial.
    rembg_model: str = "isnet-general-use"
    # How many product photos to analyse per item (WB cards often have 10+ photos).
    max_photos: int = 8
    # Max side of an image fed to the vision models.
    max_side: int = 1280
    # Enables /dev/* endpoints (benchmark uploads). Never on in production.
    dev_mode: bool = False

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def garments_dir(self) -> Path:
        return self.data_dir / "garments"


settings = Settings()
