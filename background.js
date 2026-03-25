/*
  The purpose of this file is to provide the background script for Server 3.

  Note that this extension uses an endpoint different than the server code given.
  manifest.json must be updated to test your server code.

  author: Terry
*/

const SERVER_URL = "http://mapd.cs-smu.ca:3067";

/**
 * Returns an empty string when a text response cannot be read.
 *
 * @returns {string}
 */
function returnEmptyString() {
  return "";
}

/**
 * Returns a readable error message string.
 *
 * @param {unknown} error - The error to stringify.
 * @returns {string} A normalized error message.
 */
function getErrorMessage(error) {
  return String(error?.message || error);
}

/**
 * Reads a server response and normalizes it into a payload object.
 *
 * @param {Response} response - The server response to parse.
 * @returns {Promise<object>} The parsed JSON payload or a text-based error object.
 */
async function readServerPayload(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  return { error: await response.text().catch(returnEmptyString) };
}

/**
 * Requests image analysis from the server using the original image URL.
 *
 * @param {string} imageUrl - The image URL captured from the page.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByUrl(imageUrl) {
  const serverRes = await fetch(`${SERVER_URL}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl }),
  });

  const data = await readServerPayload(serverRes);

  if (serverRes.ok) {
    return data;
  }

  if (data?.needsBlob) {
    return data;
  }

  throw new Error(`Server failed: ${serverRes.status} ${data?.error || ""}`);
}

/**
 * Safely returns the protocol for a URL-like string.
 *
 * @param {string} url - The URL string to inspect.
 * @returns {string} The parsed protocol or an empty string.
 */
function getUrlProtocol(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

/**
 * Returns whether a value is a finite number.
 *
 * @param {unknown} value - The value to validate.
 * @returns {boolean} `true` when the value is finite.
 */
function isFiniteNumber(value) {
  return Number.isFinite(value);
}

/**
 * Validates the capture metadata sent from the content script.
 *
 * @param {object | undefined} captureArea - The capture metadata to inspect.
 * @returns {boolean} `true` when the capture area can be used.
 */
function isValidCaptureArea(captureArea) {
  return Boolean(captureArea) &&
    isFiniteNumber(captureArea.left) &&
    isFiniteNumber(captureArea.top) &&
    isFiniteNumber(captureArea.width) &&
    isFiniteNumber(captureArea.height) &&
    isFiniteNumber(captureArea.viewportWidth) &&
    isFiniteNumber(captureArea.viewportHeight) &&
    captureArea.width > 0 &&
    captureArea.height > 0 &&
    captureArea.viewportWidth > 0 &&
    captureArea.viewportHeight > 0;
}

/**
 * Clamps a value between a minimum and maximum value.
 *
 * @param {number} value - The value to clamp.
 * @param {number} min - The smallest allowed value.
 * @param {number} max - The largest allowed value.
 * @returns {number} The clamped value.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Captures the visible tab and crops it to the pressed image.
 *
 * @param {{ left: number, top: number, width: number, height: number, viewportWidth: number, viewportHeight: number }} captureArea - The viewport-relative image rectangle.
 * @param {number} windowId - The window that owns the active tab.
 * @returns {Promise<Blob>} The cropped image blob captured from the client device.
 */
async function captureImageBlob(captureArea, windowId) {
  if (!isValidCaptureArea(captureArea)) {
    throw new Error("Missing image capture details from the page");
  }

  const screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const screenshotResponse = await fetch(screenshotUrl);
  const screenshotBlob = await screenshotResponse.blob();
  const screenshotBitmap = await createImageBitmap(screenshotBlob);

  try {
    const scaleX = screenshotBitmap.width / captureArea.viewportWidth;
    const scaleY = screenshotBitmap.height / captureArea.viewportHeight;
    const sourceLeft = clamp(Math.round(captureArea.left * scaleX), 0, screenshotBitmap.width);
    const sourceTop = clamp(Math.round(captureArea.top * scaleY), 0, screenshotBitmap.height);
    const sourceRight = clamp(
      Math.round((captureArea.left + captureArea.width) * scaleX),
      0,
      screenshotBitmap.width
    );
    const sourceBottom = clamp(
      Math.round((captureArea.top + captureArea.height) * scaleY),
      0,
      screenshotBitmap.height
    );
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;

    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new Error("Image is not visible enough to capture");
    }

    const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("Could not create capture canvas");
    }

    ctx.drawImage(
      screenshotBitmap,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight
    );

    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    screenshotBitmap.close();
  }
}

/**
 * Fetches an image URL in the extension context and returns it as a blob.
 *
 * @param {string} imageUrl - The image URL to fetch from the client side.
 * @returns {Promise<Blob>} The fetched image blob.
 */
async function fetchImageBlob(imageUrl) {
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new Error(`Image fetch failed: ${imageResponse.status}`);
  }

  return imageResponse.blob();
}

/**
 * Requests image analysis from the server using an uploaded blob.
 *
 * @param {Blob} imageBlob - The image captured on the client device.
 * @param {string} fileName - The upload filename to send to the server.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByBlob(imageBlob, fileName) {
  const form = new FormData();

  form.append("image", imageBlob, fileName);

  const serverRes = await fetch(`${SERVER_URL}/analyze/blob`, {
    method: "POST",
    body: form,
  });

  const data = await readServerPayload(serverRes);

  if (!serverRes.ok) {
    throw new Error(`Server failed: ${serverRes.status} ${data?.error || ""}`);
  }

  return data;
}

/**
 * Fetches the image bytes in the client context and uploads them to the server.
 *
 * @param {string} imageUrl - The image URL to fetch.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByFetchedBlob(imageUrl) {
  const imageBlob = await fetchImageBlob(imageUrl);
  return requestImageAnalysisByBlob(imageBlob, "client-image");
}

/**
 * Captures the visible image region from the tab and uploads it to the server.
 *
 * @param {{ left: number, top: number, width: number, height: number, viewportWidth: number, viewportHeight: number } | undefined} captureArea - The image rectangle in the viewport.
 * @param {{ tab?: { windowId?: number } }} sender - Metadata about the tab that sent the request.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByScreenshot(captureArea, sender) {
  const windowId = sender.tab?.windowId;

  if (!Number.isInteger(windowId)) {
    throw new Error("Cannot capture the current tab");
  }

  const capturedImage = await captureImageBlob(captureArea, windowId);
  return requestImageAnalysisByBlob(capturedImage, "client-capture.png");
}

/**
 * Handles the end-to-end image analysis flow for a content script message.
 *
 * @param {{ url: string, captureArea?: { left: number, top: number, width: number, height: number, viewportWidth: number, viewportHeight: number } }} msg - The message sent from the content script.
 * @param {{ tab?: { windowId?: number } }} sender - Metadata about the tab that sent the request.
 * @param {(response: { ok: boolean, description?: string, error?: string }) => void} sendResponse - Sends a result back to the content script.
 * @returns {Promise<void>}
 */
async function handleAnalyzeImageMessage(msg, sender, sendResponse) {
  try {
    const protocol = getUrlProtocol(msg.url);
    const isRemoteUrl = protocol === "http:" || protocol === "https:";
    let data = null;

    if (isRemoteUrl) {
      try {
        data = await requestImageAnalysisByUrl(msg.url);
      } catch {
        data = null;
      }
    }

    if (!data || data.needsBlob) {
      try {
        data = await requestImageAnalysisByFetchedBlob(msg.url);
      } catch (blobError) {
        try {
          data = await requestImageAnalysisByScreenshot(msg.captureArea, sender);
        } catch (screenshotError) {
          throw new Error(
            `Blob fallback failed: ${getErrorMessage(blobError)}. Screenshot fallback failed: ${getErrorMessage(screenshotError)}`
          );
        }
      }
    }

    sendResponse({
      ok: true,
      // if .description is falsy (null, undefined,...) use (no description)
      description: data.description || "(no description)",
    });
    // NETWORK OR CLIENT SIDE FAILURE: example is status equals 400 or 404
  } catch (err) {
    // .error instead of .log so it shows up as an error with a stack trace
    console.error(err);
    // if err is truthy use .message otherwise use err which will be undefined
    // and make sure both are represented as strings
    sendResponse({ ok: false, error: getErrorMessage(err) });
  }
}

/**
 * Receives messages from the content script and keeps the response channel open.
 *
 * @param {{ type?: string, url?: string }} msg - The runtime message payload.
 * @param {object} sender - Metadata about the sender of the message.
 * @param {(response: { ok: boolean, description?: string, error?: string }) => void} sendResponse - Sends a result back to the content script.
 * @returns {boolean|undefined} `true` when the message is handled asynchronously.
 */
function onRuntimeMessage(msg, sender, sendResponse) {
  if (msg?.type !== "ANALYZE_IMAGE_URL") return;

  handleAnalyzeImageMessage(msg, sender, sendResponse);

  // Keeps communication channel to content open.
  // Tells Chrome to wait until sendResponse completes.
  // Then channel closes after sendResponse executes.
  // Without return true; the channel closes right away
  // when it gets to the end of the listener.
  return true;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
