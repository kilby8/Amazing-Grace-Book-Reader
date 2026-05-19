import io
import uuid
from pathlib import Path

import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from gtts import gTTS
from PIL import Image, UnidentifiedImageError

app = FastAPI(title="Amazing Grace Book Reader")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
AUDIO_CACHE: dict[str, bytes] = {}
MAX_AUDIO_CACHE_ITEMS = 100


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/styles.css")
def styles() -> FileResponse:
    return FileResponse(STATIC_DIR / "styles.css")


@app.get("/app.js")
def app_js() -> FileResponse:
    return FileResponse(STATIC_DIR / "app.js")


def extract_text(image_data: bytes) -> str:
    try:
        image = Image.open(io.BytesIO(image_data))
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Invalid image file.") from exc

    text = pytesseract.image_to_string(image).strip()
    if not text:
        raise HTTPException(status_code=400, detail="No readable text detected in image.")
    return text


def text_to_speech_bytes(text: str) -> bytes:
    audio_buffer = io.BytesIO()
    gTTS(text=text, lang="en", slow=False).write_to_fp(audio_buffer)
    return audio_buffer.getvalue()


def cache_audio(audio_bytes: bytes) -> str:
    if len(AUDIO_CACHE) >= MAX_AUDIO_CACHE_ITEMS:
        oldest_audio_id = next(iter(AUDIO_CACHE))
        AUDIO_CACHE.pop(oldest_audio_id, None)

    audio_id = str(uuid.uuid4())
    AUDIO_CACHE[audio_id] = audio_bytes
    return audio_id


@app.post("/api/process")
async def process_image(file: UploadFile = File(...)) -> dict[str, str]:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload an image file.")

    image_data = await file.read()
    if not image_data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    text = extract_text(image_data)
    audio_bytes = text_to_speech_bytes(text)

    audio_id = cache_audio(audio_bytes)

    return {"text": text, "audio_url": f"/api/audio/{audio_id}"}


@app.get("/api/audio/{audio_id}")
def stream_audio(audio_id: str) -> StreamingResponse:
    audio_data = AUDIO_CACHE.get(audio_id)
    if audio_data is None:
        raise HTTPException(status_code=404, detail="Audio file not found.")

    return StreamingResponse(io.BytesIO(audio_data), media_type="audio/mpeg")
