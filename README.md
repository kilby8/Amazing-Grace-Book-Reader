# Amazing Grace Book Reader

Amazing Grace Book Reader is a Python web app that lets users upload screenshots of book text, extract readable content with OCR, and listen to the text as MP3 audio.

## Features

- Image upload API (`/api/process`)
- OCR extraction using `pytesseract`
- TTS generation using `gTTS`
- Audio streaming endpoint (`/api/audio/{audio_id}`)
- Simple modern frontend with drag-and-drop upload, extracted text display, and Play/Pause/Stop controls

## Prerequisites

### 1) Python

- Python 3.10+ recommended

### 2) Tesseract OCR (system dependency)

Install Tesseract before running the app.

- **Ubuntu/Debian**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y tesseract-ocr
  ```
- **macOS (Homebrew)**:
  ```bash
  brew install tesseract
  ```
- **Windows**:
  Install from the official Tesseract installer and ensure `tesseract` is on your `PATH`.

## Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run locally

```bash
uvicorn app.main:app --reload
```

Open: [http://127.0.0.1:8000](http://127.0.0.1:8000)

## Run tests

```bash
pytest tests/test_api.py
```

## Project structure

```text
app/
  main.py
  static/
    index.html
    styles.css
    app.js
tests/
  test_api.py
requirements.txt
README.md
```
