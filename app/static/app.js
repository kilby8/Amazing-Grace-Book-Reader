const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const uploadButton = document.getElementById("upload-btn");
const extractedText = document.getElementById("extracted-text");
const statusMessage = document.getElementById("status");
const audioPlayer = document.getElementById("audio-player");
const playButton = document.getElementById("play-btn");
const pauseButton = document.getElementById("pause-btn");
const stopButton = document.getElementById("stop-btn");

let selectedFile = null;

const setStatus = (message, isError = false) => {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b91c1c" : "#374151";
};

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] || null;
  setStatus(selectedFile ? `Selected: ${selectedFile.name}` : "No file selected.");
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
  });
});

dropZone.addEventListener("drop", (event) => {
  const droppedFile = event.dataTransfer?.files?.[0];
  selectedFile = droppedFile || null;
  setStatus(selectedFile ? `Selected: ${selectedFile.name}` : "No file selected.");
});

uploadButton.addEventListener("click", async () => {
  if (!selectedFile) {
    setStatus("Please select an image first.", true);
    return;
  }

  setStatus("Processing image...");
  extractedText.textContent = "Extracting text...";
  audioPlayer.removeAttribute("src");
  audioPlayer.load();

  const payload = new FormData();
  payload.append("file", selectedFile);

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      body: payload,
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail || "Upload failed.");
    }

    extractedText.textContent = body.text;
    audioPlayer.src = `${body.audio_url}?t=${Date.now()}`;
    audioPlayer.load();
    try {
      await audioPlayer.play();
      setStatus("Done. Audio generated successfully.");
    } catch {
      setStatus(
        "Audio generated successfully. Press Play to start if autoplay is blocked."
      );
    }
  } catch (error) {
    extractedText.textContent = "No text extracted yet.";
    setStatus(error.message || "Something went wrong.", true);
  }
});

playButton.addEventListener("click", () => {
  if (audioPlayer.src) {
    audioPlayer.play().catch(() => {
      setStatus("Unable to play audio automatically. Try interacting with the page.", true);
    });
  }
});

pauseButton.addEventListener("click", () => {
  audioPlayer.pause();
});

stopButton.addEventListener("click", () => {
  audioPlayer.pause();
  audioPlayer.currentTime = 0;
});
