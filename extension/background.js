const SERVER_URL = "http://localhost:3067";

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getServerUnavailableMessage() {
  return `Could not reach the backend at ${SERVER_URL}. Start the backend server and make sure it is listening on that port.`;
}

async function requestServer(path, init) {
  try {
    return await fetch(`${SERVER_URL}${path}`, init);
  } catch (error) {
    throw new Error(getServerUnavailableMessage());
  }
}

function collapseErrors(errors) {
  const messages = [...new Set(errors.map(getErrorMessage).filter(Boolean))];
  return messages.join(". ");
}

async function readServerPayload(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({ error: "Server returned invalid JSON" }));
  }

  return {
    error: await response.text().catch(() => ""),
  };
}

async function requestImageAnalysisByUrl(imageUrl) {
  const serverResponse = await requestServer("/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl }),
  });

  const data = await readServerPayload(serverResponse);

  if (serverResponse.ok || data?.needsBlob) {
    return data;
  }

  throw new Error(`Server failed: ${serverResponse.status} ${data?.error || ""}`.trim());
}

function getUrlProtocol(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function isRemoteUrl(url) {
  const protocol = getUrlProtocol(url);
  return protocol === "http:" || protocol === "https:";
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function captureImageBlob(captureArea, windowId) {
  if (!isValidCaptureArea(captureArea)) {
    throw new Error("Missing image capture details from the page");
  }

  const screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const screenshotResponse = await fetch(screenshotUrl);
  const screenshotBlob = await screenshotResponse.blob();
  const screenshotBitmap = await createImageBitmap(screenshotBlob);

  try {
    // Scale the viewport-relative DOM rectangle into screenshot pixels.
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
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create capture canvas");
    }

    context.drawImage(
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

async function fetchImageBlob(imageUrl) {
  let imageResponse;

  try {
    imageResponse = await fetch(imageUrl);
  } catch (error) {
    throw new Error(`Extension could not fetch the image directly: ${getErrorMessage(error)}`);
  }

  if (!imageResponse.ok) {
    throw new Error(`Image fetch failed: ${imageResponse.status}`);
  }

  const contentType = (imageResponse.headers.get("content-type") || "").toLowerCase();

  if (contentType && !contentType.startsWith("image/")) {
    throw new Error(`Fetched resource is not an image: ${contentType}`);
  }

  return imageResponse.blob();
}

async function requestImageAnalysisByBlob(imageBlob, fileName) {
  const form = new FormData();

  form.append("image", imageBlob, fileName);

  const serverResponse = await requestServer("/analyze/blob", {
    method: "POST",
    body: form,
  });

  const data = await readServerPayload(serverResponse);

  if (!serverResponse.ok) {
    throw new Error(`Server failed: ${serverResponse.status} ${data?.error || ""}`.trim());
  }

  return data;
}

async function requestImageAnalysisByFetchedBlob(imageUrl) {
  const imageBlob = await fetchImageBlob(imageUrl);
  return requestImageAnalysisByBlob(imageBlob, "client-image");
}

async function requestImageAnalysisByScreenshot(captureArea, sender) {
  const windowId = sender.tab?.windowId;

  if (!Number.isInteger(windowId)) {
    throw new Error("Cannot capture the current tab");
  }

  const capturedImage = await captureImageBlob(captureArea, windowId);
  return requestImageAnalysisByBlob(capturedImage, "client-capture.png");
}

async function resolveImageAnalysis(message, sender) {
  if (typeof message?.url !== "string" || !message.url) {
    throw new Error("Missing image URL");
  }

  const errors = [];

  if (isRemoteUrl(message.url)) {
    try {
      const data = await requestImageAnalysisByUrl(message.url);

      if (!data?.needsBlob) {
        return data;
      }

      errors.push(new Error(data.error || "Server requested a blob upload"));
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    return await requestImageAnalysisByFetchedBlob(message.url);
  } catch (error) {
    errors.push(error);
  }

  try {
    return await requestImageAnalysisByScreenshot(message.captureArea, sender);
  } catch (error) {
    errors.push(error);
  }

  throw new Error(collapseErrors(errors));
}

async function handleAnalyzeImageMessage(message, sender, sendResponse) {
  try {
    // Prefer the original URL, then fall back to client-side upload paths.
    const data = await resolveImageAnalysis(message, sender);

    sendResponse({
      ok: true,
      description: data.description || "(no description)",
    });
  } catch (error) {
    console.error(error);
    sendResponse({
      ok: false,
      error: getErrorMessage(error),
    });
  }
}

function onRuntimeMessage(message, sender, sendResponse) {
  if (message?.type !== "ANALYZE_IMAGE_URL") {
    return;
  }

  void handleAnalyzeImageMessage(message, sender, sendResponse);
  return true;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
