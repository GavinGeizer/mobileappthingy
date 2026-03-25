let availableVoices = [];
let longPressTimer = null;
let suppressDefaultUiUntil = 0;

const LONG_PRESS_MS = 600;
const SUPPRESSION_WINDOW_MS = 1000;
const PREFERRED_VOICE_NAME = "Google UK English Female";

function loadVoices() {
  availableVoices = speechSynthesis.getVoices();
}

function isImageElement(target) {
  return target instanceof HTMLImageElement;
}

function getImageUrl(image) {
  return image.currentSrc || image.src || "";
}

function getImageCaptureArea(image) {
  const rect = image.getBoundingClientRect();

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

async function analyzePressedImage(image) {
  try {
    const imageUrl = getImageUrl(image);

    if (!imageUrl) {
      throw new Error("Image has no usable source");
    }

    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE_IMAGE_URL",
      url: imageUrl,
      captureArea: getImageCaptureArea(image),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown error");
    }

    speak(response.description);
  } catch (error) {
    console.error("Analyze failed:", error);
  }
}

function clearLongPressTimer() {
  if (longPressTimer === null) {
    return;
  }

  clearTimeout(longPressTimer);
  longPressTimer = null;
}

function armDefaultUiSuppression() {
  suppressDefaultUiUntil = Date.now() + SUPPRESSION_WINDOW_MS;
}

function shouldSuppressDefaultUi() {
  return Date.now() <= suppressDefaultUiUntil;
}

function handlePointerDown(event) {
  suppressDefaultUiUntil = 0;

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const image = event.target;

  if (!isImageElement(image)) {
    return;
  }

  clearLongPressTimer();
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    armDefaultUiSuppression();
    void analyzePressedImage(image);
  }, LONG_PRESS_MS);
}

function handleClick(event) {
  if (!shouldSuppressDefaultUi()) {
    return;
  }

  const clickedImage = event.composedPath().find(isImageElement);

  if (!clickedImage) {
    return;
  }

  suppressDefaultUiUntil = 0;
  event.preventDefault();
  event.stopPropagation();
}

function handleContextMenu(event) {
  if (!shouldSuppressDefaultUi()) {
    return;
  }

  suppressDefaultUiUntil = 0;
  event.preventDefault();
}

function isPreferredVoice(voice) {
  return voice.name === PREFERRED_VOICE_NAME;
}

function speak(text) {
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  const preferredVoice = availableVoices.find(isPreferredVoice);

  if (preferredVoice) {
    utterance.voice = preferredVoice;
  } else {
    console.log("Voice not found, using default");
  }

  speechSynthesis.speak(utterance);
}

speechSynthesis.onvoiceschanged = loadVoices;
loadVoices();

document.addEventListener("pointerdown", handlePointerDown);
document.addEventListener("pointerup", clearLongPressTimer);
document.addEventListener("pointercancel", clearLongPressTimer);
document.addEventListener("click", handleClick, true);
document.addEventListener("contextmenu", handleContextMenu);
