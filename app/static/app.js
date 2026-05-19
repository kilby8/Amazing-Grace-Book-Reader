const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const textOutput = document.getElementById("extracted-text");
const audioPlayer = document.getElementById("audio-player");
const statusEl = document.getElementById("status");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const stopBtn = document.getElementById("stop-btn");

function setStatus(message) {
  statusEl.textContent = message;
}

async function uploadImage(file) {
  const formData = new FormData();
  formData.append("file", file);

  setStatus("Processing image...");

  try {
    const response = await fetch("/api/process", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Failed to process image.");
    }

    textOutput.textContent = payload.text;
    audioPlayer.src = payload.audio_url;
    audioPlayer.load();

    try {
      await audioPlayer.play();
      setStatus("Done! Playing generated audio.");
    } catch {
      setStatus("Done! Audio is ready. Click Play to start.");
    }
  } catch (error) {
    setStatus(error.message);
  }
}

browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) {
    uploadImage(file);
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    uploadImage(file);
  }
});

playBtn.addEventListener("click", () => audioPlayer.play());
pauseBtn.addEventListener("click", () => audioPlayer.pause());
stopBtn.addEventListener("click", () => {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
});
