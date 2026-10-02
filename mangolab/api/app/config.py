"""Settings. Reads the MangoLab .env and, for AUTH_SECRET only, falls back to the MangoGPT app's .env so one login works for both."""
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]  # mangolab/
REPO = ROOT.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=[REPO / ".env", ROOT / ".env"], extra="ignore")

    database_url: str = Field(alias="MANGOLAB_DATABASE_URL")
    auth_secret: str = Field(alias="AUTH_SECRET", min_length=16)
    data_dir: Path = Field(default=Path.home() / "mangolab-data", alias="MANGOLAB_DATA_DIR")
    ollama_base_url: str = Field(default="http://127.0.0.1:11434", alias="OLLAMA_BASE_URL")
    session_cookie: str = "oc_session"  # same cookie the MangoGPT app sets
    api_prefix: str = "/lab-api/v1"
    max_total_runtimes: int = Field(default=6, alias="MANGOLAB_MAX_RUNTIMES")  # across all users: the GPU and RAM are shared
    runtime_start_timeout_s: int = 60
    sample_interval_s: int = 5
    sweep_interval_s: int = Field(default=30, alias="MANGOLAB_SWEEP_S")  # how often idle/ownership checks run

    @property
    def runtimes_dir(self) -> Path:
        return self.data_dir / "runtimes"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
