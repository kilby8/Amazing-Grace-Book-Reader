import io

from fastapi.testclient import TestClient
from PIL import Image

from app.main import app


client = TestClient(app)


def _make_test_image_bytes() -> bytes:
    image = Image.new("RGB", (40, 40), color="white")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_process_image_returns_text_and_audio_url(monkeypatch):
    monkeypatch.setattr("app.main.extract_text", lambda _: "Amazing grace how sweet the sound")
    monkeypatch.setattr("app.main.text_to_speech_bytes", lambda _: b"fake-mp3")

    response = client.post(
        "/api/process",
        files={"file": ("page.png", _make_test_image_bytes(), "image/png")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "Amazing grace how sweet the sound"
    assert body["audio_url"].startswith("/api/audio/")


def test_audio_stream_returns_mp3(monkeypatch):
    monkeypatch.setattr("app.main.extract_text", lambda _: "text")
    monkeypatch.setattr("app.main.text_to_speech_bytes", lambda _: b"fake-mp3")

    process_response = client.post(
        "/api/process",
        files={"file": ("page.png", _make_test_image_bytes(), "image/png")},
    )
    audio_url = process_response.json()["audio_url"]

    audio_response = client.get(audio_url)

    assert audio_response.status_code == 200
    assert audio_response.headers["content-type"].startswith("audio/mpeg")
    assert audio_response.content == b"fake-mp3"
