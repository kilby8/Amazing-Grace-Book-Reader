import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import AUDIO_CACHE


@pytest.fixture(autouse=True)
def clear_audio_cache():
    AUDIO_CACHE.clear()
    yield
    AUDIO_CACHE.clear()
