# Amazing Grace Book Reader

A Python/FastAPI web app that accepts screenshot uploads, extracts text using OCR, and reads it back using Text-to-Speech audio.

## Features

- Drag-and-drop image upload UI
- OCR text extraction via Tesseract (`pytesseract`)
- MP3 generation via Google Text-to-Speech (`gTTS`)
- In-browser audio playback with Play/Pause/Stop controls

## Prerequisites

1. **Python 3.10+**
2. **Tesseract OCR** installed and available on your system path.

### Install Tesseract OCR

- **Ubuntu/Debian**
  ```bash
  sudo apt-get update
  sudo apt-get install -y tesseract-ocr
  ```
- **macOS (Homebrew)**
  ```bash
  brew install tesseract
  ```
- **Windows**
  - Install from the official UB Mannheim build or Tesseract installer.
  - Ensure the `tesseract` executable is added to `PATH`.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run Locally

```bash
uvicorn app.main:app --reload
```

Then open: `http://127.0.0.1:8000`

## API Endpoints

- `POST /api/upload`  
  Accepts an image file and returns extracted text plus an audio URL.
- `GET /api/audio/{audio_file}`  
  Returns generated MP3 audio for playback.

## Project Structure

```text
app/
  main.py
  static/
    index.html
    styles.css
    app.js
generated_audio/
requirements.txt
README.md
```
