"""
serve_local.py â€” Kyutai Pocket TTS as a small local HTTP server.

Works around a v3.0.2 bug in `pocket-tts serve` where the module-global model
becomes None in the request handler (probably a uvicorn + typer module-reload
quirk â€” the upstream `main.py` `serve` function sets `tts_model` in the parent
process, then uvicorn's string-import form re-imports the module in a context
where the global is its initial None). This script:

  1. Loads the TTSModel once at startup.
  2. Stashes it on `app.state` instead of a module global.
  3. Defines a /tts endpoint that uses `request.app.state.tts_model`.

The endpoint shape mirrors upstream pocket-tts's /tts (form fields `text`,
`voice_url`, `voice_wav`) so the wire protocol is the same â€” voice_studio.py
and `curl` callers don't need to know we're using a custom server.

Usage:
  python serve_local.py --port 8765 --voice eve
  python serve_local.py --port 8765 --voice ./sarah_sample.wav
"""

from __future__ import annotations

import argparse
import asyncio
import io
import logging
import os
import tempfile
import time
from pathlib import Path
from queue import Queue
from typing import Annotated

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from pocket_tts import TTSModel
from pocket_tts.data.audio import stream_audio_chunks
from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pocket-tts-local")

# A single generation should take well under a minute (the reader asks for
# at most ~600 characters, about 20 s of work). One that runs past this is
# stuck: the process exits and systemd starts a fresh one. On 2026-11-02 the
# server froze for good with generation running on the event loop, so
# /health stopped answering too and nothing ever restarted it.
GENERATION_TIMEOUT_S = float(os.environ.get("POCKET_GENERATION_TIMEOUT_S", "120"))


def build_app(tts: TTSModel, default_voice: str | None) -> FastAPI:
    """Build a FastAPI app bound to an already-loaded TTSModel.

    The model is passed via app.state so it's not a module global â€” sidesteps
    the upstream v3.0.2 bug where uvicorn re-imports the module and the global
    resets to None.
    """
    app = FastAPI(title="Pocket TTS (local)", version="0.1.0")
    # Browser clients (the Grace Reader web app) need CORS headers to call
    # this server. The server only listens on 127.0.0.1 by default, so an
    # open CORS policy is the right trade-off for a local dev tool.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.tts_model = tts
    # One generation at a time (the model is not shared safely between
    # threads); it runs in a worker thread so the event loop stays free to
    # answer /health and to notice callers that gave up.
    gen_lock = asyncio.Lock()
    app.state.busy_since = None

    @app.on_event("startup")
    async def _warm_default_voice() -> None:
        # Pre-encode the default voice so the first request is fast.
        # On failure, log and continue â€” the request handler will return 500
        # if a request comes in without a voice_url and there's no default.
        if default_voice is None:
            log.info("no default voice configured; every request must include voice_url or voice_wav")
            return
        try:
            tts.get_state_for_audio_prompt(default_voice)
            log.info("default voice '%s' pre-encoded and cached", default_voice)
        except Exception as exc:
            log.error("failed to pre-encode default voice '%s': %s", default_voice, exc)

    @app.get("/health")
    async def health():
        busy = app.state.busy_since
        if busy is not None and time.monotonic() - busy > GENERATION_TIMEOUT_S:
            return JSONResponse({"status": "stuck", "busy_s": round(time.monotonic() - busy)}, status_code=503)
        return {"status": "healthy", "model": "loaded", "busy": "yes" if busy is not None else "no"}

    @app.get("/")
    async def root() -> dict[str, str]:
        return {
            "service": "Pocket TTS (local)",
            "default_voice": default_voice or "(none)",
            "endpoints": ["/health", "/tts (POST form: text, voice_url?, voice_wav?)"],
        }

    def _write_to_queue(queue: Queue, text: str, model_state: dict) -> None:
        class FileLikeToQueue(io.IOBase):
            def __init__(self, q):
                super().__init__()
                self.queue = q

            def write(self, data):  # type: ignore[override]
                self.queue.put(data)

            def flush(self):  # type: ignore[override]
                pass

            def close(self):  # type: ignore[override]
                self.queue.put(None)

        audio_chunks = tts.generate_audio_stream(
            model_state=model_state, text_to_generate=text
        )
        stream_audio_chunks(FileLikeToQueue(queue), audio_chunks, tts.config.mimi.sample_rate)

    def _build_complete_wav(text: str, model_state: dict) -> bytes:
        """Generate the full audio into memory, then patch the WAV `data` chunk
        size to match reality. The upstream `stream_audio_chunks` writes a
        placeholder `data` size because it streams, which strict clients (most
        browsers) reject with MEDIA_ERR_SRC_NOT_SUPPORTED even though the
        audio data is otherwise valid. Buffering first gives us the real size
        and produces a fully-formed WAV the browser will play.
        """
        buf = io.BytesIO()

        class _Sink(io.IOBase):
            def write(self_, data):  # type: ignore[override]
                buf.write(data)
                return len(data)
            def flush(self_):  # type: ignore[override]
                pass
            def close(self_):  # type: ignore[override]
                pass

        audio_chunks = tts.generate_audio_stream(
            model_state=model_state, text_to_generate=text
        )
        stream_audio_chunks(_Sink(), audio_chunks, tts.config.mimi.sample_rate)

        raw = buf.getvalue()
        import struct
        # Patch the RIFF size (offset 4) and the `data` chunk size (offset 40)
        # so the file declares its true length. Without this, <audio> in
        # Chrome rejects the file with MEDIA_ERR_SRC_NOT_SUPPORTED even though
        # decodeAudioData is lenient enough to accept it.
        if len(raw) >= 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE" and raw[36:40] == b"data":
            real_riff_size = len(raw) - 8
            real_data_size = len(raw) - 44
            raw = bytearray(raw)
            struct.pack_into("<I", raw, 4, real_riff_size & 0xFFFFFFFF)
            struct.pack_into("<I", raw, 40, real_data_size & 0xFFFFFFFF)
            raw = bytes(raw)
        return raw

    def _wav_response(wav: bytes) -> Response:
        return Response(
            content=wav,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=generated_speech.wav",
            },
        )

    def _voice_state(eff_voice_url: str | None, voice_wav_bytes: bytes | None, suffix: str) -> dict:
        if voice_wav_bytes is None:
            log.info("voice_url=%s (using cached or freshly-encoded state)", eff_voice_url)
            return tts.get_state_for_audio_prompt(eff_voice_url)
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(voice_wav_bytes)
            tmp = f.name
        try:
            return tts.get_state_for_audio_prompt(Path(tmp), truncate=True)
        finally:
            Path(tmp).unlink(missing_ok=True)

    async def _run_generation(work, *args):
        """Run blocking model work in a thread; exit the process if it hangs."""
        app.state.busy_since = time.monotonic()
        try:
            return await asyncio.wait_for(asyncio.to_thread(work, *args), timeout=GENERATION_TIMEOUT_S)
        except asyncio.TimeoutError:
            log.critical("generation ran past %ss; exiting so systemd restarts a fresh server", GENERATION_TIMEOUT_S)
            logging.shutdown()
            os._exit(3)
        finally:
            app.state.busy_since = None

    @app.post("/tts")
    async def tts_endpoint(
        request: Request,
        text: Annotated[str, Form(...)],
        voice_url: Annotated[str | None, Form()] = None,
        voice_wav: Annotated[UploadFile | None, File()] = None,
    ) -> StreamingResponse:
        if not text.strip():
            raise HTTPException(status_code=400, detail="text cannot be empty")
        if voice_url is not None and voice_wav is not None:
            raise HTTPException(status_code=400, detail="cannot provide both voice_url and voice_wav")

        # Fall back to the configured default voice
        eff_voice_url = voice_url or default_voice
        if eff_voice_url is None:
            raise HTTPException(
                status_code=400,
                detail="no voice specified and no default voice configured on the server",
            )

        voice_wav_bytes = None
        suffix = ".wav"
        if eff_voice_url is not None and voice_wav is None:
            # Accept a built-in voice name, http(s)://, hf://, or a local path
            if eff_voice_url not in _ORIGINS_OF_PREDEFINED_VOICES and not (
                eff_voice_url.startswith("http://")
                or eff_voice_url.startswith("https://")
                or eff_voice_url.startswith("hf://")
                or Path(eff_voice_url).is_file()
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "voice_url must be a built-in name, an http(s):// URL, "
                        "an hf:// path, or a local file path"
                    ),
                )
        else:
            assert voice_wav is not None
            suffix = Path(voice_wav.filename or "voice.wav").suffix or ".wav"
            voice_wav_bytes = await voice_wav.read()

        async with gen_lock:
            # A caller that gave up while waiting its turn (the reader moved
            # on, or timed out) gets nothing: don't spend the server on it.
            if await request.is_disconnected():
                log.info("caller left before its turn; skipping %d chars", len(text))
                return Response(status_code=499)
            try:
                model_state = await _run_generation(_voice_state, eff_voice_url, voice_wav_bytes, suffix)
            except Exception as exc:
                log.exception("voice setup failed")
                raise HTTPException(status_code=500, detail=f"voice setup failed: {exc}") from exc
            wav = await _run_generation(_build_complete_wav, text, model_state)
        return _wav_response(wav)

    return app


def main() -> int:
    p = argparse.ArgumentParser(description="Local Pocket TTS HTTP server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument(
        "--voice",
        default="eve",
        help="default voice: built-in name (eve, alba, lola, ...), a local .wav path, "
             "or an http(s):// or hf:// URL. Used when requests don't specify one.",
    )
    p.add_argument("--language", default=None, help="language model to load (default: english)")
    p.add_argument("--quantize", action="store_true", help="apply int8 dynamic quantization")
    args = p.parse_args()

    log.info("loading TTSModel (language=%s, quantize=%s)...", args.language, args.quantize)
    tts = TTSModel.load_model(language=args.language, quantize=args.quantize)
    log.info("TTSModel loaded (sample_rate=%s Hz)", tts.config.mimi.sample_rate)

    app = build_app(tts, default_voice=args.voice)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
