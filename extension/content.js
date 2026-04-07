/*
This content script is responsible for detecting long presses on images within web pages, sending the image URL to the background script for analysis, and providing visual feedback and narration of the analysis results. It listens for pointer events to identify long presses, checks if the target element is an image, and manages a temporary overlay animation to indicate when an analysis request has been triggered. The script also handles speech synthesis to read out the analysis results using a preferred voice if available.
authors: @gavingeizer, matt, ajay.
*/

const ANALYZE_IMAGE_MESSAGE = "ANALYZE_IMAGE_URL";
const LONG_PRESS_MS = 600;
const SUPPRESSION_WINDOW_MS = 1000;
const REQUEST_IMPACT_DURATION_MS = 420;
const REQUEST_IMPACT_SIZE_PX = 18;
const PREFERRED_VOICE_NAME = "Google UK English Female";

const state = {
  availableVoices: [],
  impactLayer: null,
  longPressTimer: null,
  suppressDefaultUiUntil: 0,
};
//self explanitory
function loadVoices() {
  state.availableVoices = speechSynthesis.getVoices();
}
//self explanitory
function isImageElement(target) {
  return target instanceof HTMLImageElement;
}
// self explanitory
function getImageUrl(image) {
  return image.currentSrc || image.src || "";
}
// self explanitory
function isUsableImage(target) {
  return isImageElement(target) && Boolean(getImageUrl(target));
}
//self explanitory, checks if a point is within the bounding rectangle of an element
function isPointWithinRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// Traverses the event's composed path to find an image element at the point of interaction, checking both the event target and any nested images within it, to determine if a long press should trigger an analysis request for that image.
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

// Uses the event's composed path to find the topmost image element at the point of interaction, which allows for accurate detection of long presses on images even when they are nested within other elements or have overlapping content.
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

// Retrieves the bounding rectangle of the image element to provide context for the analysis request, including the position and size of the image as well as the viewport dimensions, which can be used by the server to optimize analysis or provide more relevant descriptions.
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
// This is all AI generated, I swear. It adds a visual effect to indicate when an image analysis request has been triggered, by creating a temporary overlay with an expanding circle animation at the point of interaction. The effect is designed to be subtle and non-intrusive, while providing feedback to the user that their long press has been recognized and the analysis is underway.
function ensureImpactLayer() {
  if (state.impactLayer?.isConnected) {
    return state.impactLayer;
  }

  const root = document.documentElement;

  if (!root) {
    return null;
  }

  // Reuse one top-level container so each request can add a tiny temporary
  // animation without polluting the page with permanent DOM nodes.
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
// End AI generated code
// Handles the long press interaction on an image, sending a message to the background script to request analysis of the image URL, and then speaking the resulting description using the Web Speech API. It also includes error handling to catch any issues that arise during the process and log them to the console.
async function analyzePressedImage(image) {
  try {
    const imageUrl = getImageUrl(image);

    if (!imageUrl) {
      throw new Error("Image has no usable source");
    }

    const response = await chrome.runtime.sendMessage({
      type: ANALYZE_IMAGE_MESSAGE,
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
// self explanitory, clears the long press timer to prevent unintended analysis requests if the user releases the press or cancels it before the LONG_PRESS_MS threshold is reached.
function clearLongPressTimer() {
  if (state.longPressTimer === null) {
    return;
  }

  clearTimeout(state.longPressTimer);
  state.longPressTimer = null;
}
// Arms the suppression of the default image UI for a short window, which is used to prevent the browser's context menu or other default interactions from interfering with the custom long press behavior when an analysis request has been triggered.
function armDefaultUiSuppression() {
  state.suppressDefaultUiUntil = Date.now() + SUPPRESSION_WINDOW_MS;
}
// Determines whether the default image UI should be suppressed based on the current time and the suppression window, allowing the content script to conditionally prevent default interactions like context menus when a long press has recently triggered an analysis request.
function shouldSuppressDefaultUi() {
  return Date.now() <= state.suppressDefaultUiUntil;
}
// Handles the pointer down event to detect long presses on images, initiating the analysis process and visual feedback when a long press is recognized, while also ensuring that normal taps and non-image interactions are not affected.
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

  const pressPoint = {
    x: event.clientX,
    y: event.clientY,
  };

  // Normal taps should pass through untouched. Only a held press should kick
  // off narration and suppress the page's default image UI.
  state.longPressTimer = setTimeout(() => {
    state.longPressTimer = null;
    armDefaultUiSuppression();
    showRequestImpact(pressPoint.x, pressPoint.y);
    void analyzePressedImage(image);
  }, LONG_PRESS_MS);
}

// Handles click events to suppress the default image UI when a long press has triggered an analysis request, ensuring that the browser's context menu or other default interactions do not interfere with the custom behavior of the extension during the suppression window.
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

//self explanitory, uses the Web Speech API to speak the provided text, selecting a preferred voice if available and configuring the speech parameters for a natural and clear narration of the image analysis results.
function speak(text) {
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-GB";
  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;

  const preferredVoice = state.availableVoices.find((voice) => voice.name === PREFERRED_VOICE_NAME);

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
