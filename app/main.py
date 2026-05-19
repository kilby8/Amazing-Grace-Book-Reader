from __future__ import annotations

import io
from pathlib import Path
from uuid import UUID, uuid4

import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from gtts import gTTS
from gtts.tts import gTTSError
from PIL import Image, UnidentifiedImageError


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "app" / "static"
AUDIO_DIR = BASE_DIR / "generated_audio"
AUDIO_DIR.mkdir(exist_ok=True)

ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".gif"}
app = FastAPI(title="Amazing Grace Book Reader")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/upload")
async def upload_image(file: UploadFile = File(...)) -> dict[str, str]:
    extension = Path(file.filename or "").suffix.lower()
    if extension and extension not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        image = Image.open(io.BytesIO(raw_bytes))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid image file.") from exc

    extracted_text = pytesseract.image_to_string(image).strip()
    if not extracted_text:
        raise HTTPException(status_code=422, detail="No readable text found in image.")

    audio_id = uuid4()
    audio_path = AUDIO_DIR / f"{audio_id}.mp3"

    try:
        tts = gTTS(text=extracted_text, lang="en", slow=False)
        tts.save(str(audio_path))
    except (gTTSError, OSError) as exc:
        raise HTTPException(status_code=502, detail="Failed to generate audio. Please try again later.") from exc

    return {"text": extracted_text, "audio_url": f"/api/audio/{audio_id}"}


@app.get("/api/audio/{audio_id}")
async def get_audio(audio_id: UUID) -> FileResponse:
    audio_candidates = {path.stem: path for path in AUDIO_DIR.glob("*.mp3")}
    audio_path = audio_candidates.get(str(audio_id))
    if audio_path is None:
        raise HTTPException(status_code=404, detail="Audio file not found.")

    return FileResponse(path=str(audio_path), media_type="audio/mpeg", filename=f"{audio_id}.mp3")
