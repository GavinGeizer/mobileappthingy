const LONG_PRESS_MS = 600;
const SUPPRESSION_WINDOW_MS = 1000;
const REQUEST_IMPACT_DURATION_MS = 420;
const REQUEST_IMPACT_SIZE_PX = 18;
const PREFERRED_VOICE_NAME = "Google UK English Female";

// Keep the mutable bits together so the event handlers do not have to manage
// several unrelated globals.
const state = {
  availableVoices: [],
  impactLayer: null,
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
// AI GENERATED CONTENT: The impact layer is a single shared element that the content script
function ensureImpactLayer() {
  if (state.impactLayer?.isConnected) {
    return state.impactLayer;
  }

  const root = document.documentElement;

  if (!root) {
    return null;
  }

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = [
    "all: initial",
    "display: block",
    "position: fixed",
    "inset: 0",
    "pointer-events: none",
    "z-index: 2147483647",
    "contain: strict",
  ].join("; ");

  root.append(layer);
  state.impactLayer = layer;
  return layer;
}

// Keep the visual feedback lightweight and self-contained so the content
// script does not need extra stylesheets or assets.
function showRequestImpact(x, y) {
  const layer = ensureImpactLayer();

  if (!layer) {
    return;
  }

  const impact = document.createElement("div");
  const core = document.createElement("div");
  const halfSize = REQUEST_IMPACT_SIZE_PX / 2;

  impact.style.cssText = [
    "all: initial",
    "display: block",
    "position: absolute",
    `left: ${x}px`,
    `top: ${y}px`,
    `width: ${REQUEST_IMPACT_SIZE_PX}px`,
    `height: ${REQUEST_IMPACT_SIZE_PX}px`,
    `margin-left: -${halfSize}px`,
    `margin-top: -${halfSize}px`,
    "border-radius: 999px",
    "box-sizing: border-box",
    "border: 2px solid rgba(255, 255, 255, 0.95)",
    "background: rgba(255, 255, 255, 0.18)",
    "box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.2), 0 4px 14px rgba(15, 23, 42, 0.18)",
    "transform: scale(0.35)",
    "transform-origin: center",
    "opacity: 0.95",
  ].join("; ");

  core.style.cssText = [
    "all: initial",
    "display: block",
    "position: absolute",
    "left: 50%",
    "top: 50%",
    "width: 6px",
    "height: 6px",
    "margin-left: -3px",
    "margin-top: -3px",
    "border-radius: 999px",
    "background: rgba(255, 255, 255, 0.98)",
    "box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.2)",
    "transform-origin: center",
    "opacity: 0.95",
  ].join("; ");

  impact.append(core);
  layer.append(impact);

  if (typeof impact.animate === "function") {
    impact.animate(
      [
        { transform: "scale(0.35)", opacity: 0.95 },
        { transform: "scale(1)", opacity: 0.45, offset: 0.55 },
        { transform: "scale(2.35)", opacity: 0 },
      ],
      {
        duration: REQUEST_IMPACT_DURATION_MS,
        easing: "cubic-bezier(0.18, 0.8, 0.2, 1)",
        fill: "forwards",
      }
    );

    core.animate(
      [
        { transform: "scale(0.9)", opacity: 0.95 },
        { transform: "scale(1.25)", opacity: 0.5, offset: 0.45 },
        { transform: "scale(0.4)", opacity: 0 },
      ],
      {
        duration: REQUEST_IMPACT_DURATION_MS,
        easing: "ease-out",
        fill: "forwards",
      }
    );
  }

  window.setTimeout(() => {
    impact.remove();
  }, REQUEST_IMPACT_DURATION_MS);
}

//END AI GENERATED CONTENT
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
  const pressPoint = {
    x: event.clientX,
    y: event.clientY,
  };

  state.longPressTimer = setTimeout(() => {
    state.longPressTimer = null;
    armDefaultUiSuppression();
    showRequestImpact(pressPoint.x, pressPoint.y);
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
