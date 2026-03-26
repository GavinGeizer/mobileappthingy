const LONG_PRESS_MS = 600;
const SUPPRESSION_WINDOW_MS = 1000;
const PREFERRED_VOICE_NAME = "Google UK English Female";

// Keep the mutable bits together so the event handlers do not have to manage
// several unrelated globals.
const state = {
  availableVoices: [],
  longPressTimer: null,
  suppressDefaultUiUntil: 0,
};

function loadVoices() {
  state.availableVoices = speechSynthesis.getVoices();
}

function isImageElement(target) {
  return target instanceof HTMLImageElement;
}

function getImageUrl(image) {
  return image.currentSrc || image.src || "";
}

function isUsableImage(target) {
  return isImageElement(target) && Boolean(getImageUrl(target));
}

function isPointWithinRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Only resolve images that are actually under the pointer so a long press on
// the page background does not accidentally target the first image on the page.
function findImageAtPoint(node, x, y) {
  if (isUsableImage(node) && isPointWithinRect(x, y, node.getBoundingClientRect())) {
    return node;
  }

  if (!(node instanceof Element)) {
    return null;
  }

  for (const image of node.querySelectorAll("img")) {
    if (!isUsableImage(image)) {
      continue;
    }

    if (isPointWithinRect(x, y, image.getBoundingClientRect())) {
      return image;
    }
  }

  return null;
}

function getEventImage(event) {
  const path = typeof event.composedPath === "function"
    ? event.composedPath()
    : [event.target];

  for (const node of path) {
    const image = findImageAtPoint(node, event.clientX, event.clientY);

    if (image) {
      return image;
    }
  }

  return null;
}

// Send viewport-relative bounds so the background script can crop the matching
// region out of a screenshot if the original image URL is not directly usable.
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

    console.log("Analysis result:", response.description);
    speak(response.description);
  } catch (error) {
    console.error("Analyze failed:", error);
  }
}

function clearLongPressTimer() {
  if (state.longPressTimer === null) {
    return;
  }

  clearTimeout(state.longPressTimer);
  state.longPressTimer = null;
}

function armDefaultUiSuppression() {
  state.suppressDefaultUiUntil = Date.now() + SUPPRESSION_WINDOW_MS;
}

function shouldSuppressDefaultUi() {
  return Date.now() <= state.suppressDefaultUiUntil;
}

function handlePointerDown(event) {
  state.suppressDefaultUiUntil = 0;

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  const image = getEventImage(event);

  if (!image) {
    return;
  }

  clearLongPressTimer();

  // Delay the analysis so normal taps still behave normally unless the user
  // intentionally holds the press long enough to request narration.
  state.longPressTimer = setTimeout(() => {
    state.longPressTimer = null;
    armDefaultUiSuppression();
    void analyzePressedImage(image);
  }, LONG_PRESS_MS);
}

function handleClick(event) {
  if (!shouldSuppressDefaultUi() || !getEventImage(event)) {
    return;
  }

  state.suppressDefaultUiUntil = 0;
  event.preventDefault();
  event.stopPropagation();
}

function handleContextMenu(event) {
  if (!shouldSuppressDefaultUi()) {
    return;
  }

  state.suppressDefaultUiUntil = 0;
  event.preventDefault();
}

// Speech output is intentionally centralized so voice selection stays
// consistent no matter which analysis path produced the description.
function speak(text) {
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  const preferredVoice = state.availableVoices.find((voice) => (
    voice.name === PREFERRED_VOICE_NAME
  ));

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
