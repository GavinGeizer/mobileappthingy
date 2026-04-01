const SERVER_URL = "http://mapd.cs-smu.ca:3067";
const ANALYZE_IMAGE_MESSAGE = "ANALYZE_IMAGE_URL";

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function getServerUnavailableMessage() {
  return `Could not reach the backend at ${SERVER_URL}. Start the backend server and make sure it is listening on that port.`;
}

function collapseErrors(messages) {
  return [...new Set(messages.filter(Boolean))].join(". ");
}

function buildServerError(status, data) {
  return new Error(`Server failed: ${status} ${data?.error || ""}`.trim());
}

async function fetchServer(path, init) {
  try {
    return await fetch(`${SERVER_URL}${path}`, init);
  } catch {
    throw new Error(getServerUnavailableMessage());
  }
}

async function readServerData(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({ error: "Server returned invalid JSON" }));
  }

  return {
    error: await response.text().catch(() => ""),
  };
}

async function sendServerRequest(path, init) {
  const response = await fetchServer(path, init);
  const data = await readServerData(response);

  return { response, data };
}

function requireSuccessfulResponse(response, data, { allowBlobFallback = false } = {}) {
  if (response.ok) {
    return data;
  }

  if (allowBlobFallback && data?.needsBlob) {
    return data;
  }

  throw buildServerError(response.status, data);
}

function isRemoteUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isValidCaptureArea(captureArea) {
  const numericFields = [
    "left",
    "top",
    "width",
    "height",
    "viewportWidth",
    "viewportHeight",
  ];

  return Boolean(captureArea) &&
    numericFields.every((field) => Number.isFinite(captureArea[field])) &&
    captureArea.width > 0 &&
    captureArea.height > 0 &&
    captureArea.viewportWidth > 0 &&
    captureArea.viewportHeight > 0;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getScaledCaptureBounds(captureArea, screenshotBitmap) {
  const scaleX = screenshotBitmap.width / captureArea.viewportWidth;
  const scaleY = screenshotBitmap.height / captureArea.viewportHeight;
  const left = clamp(Math.round(captureArea.left * scaleX), 0, screenshotBitmap.width);
  const top = clamp(Math.round(captureArea.top * scaleY), 0, screenshotBitmap.height);
  const right = clamp(
    Math.round((captureArea.left + captureArea.width) * scaleX),
    0,
    screenshotBitmap.width
  );
  const bottom = clamp(
    Math.round((captureArea.top + captureArea.height) * scaleY),
    0,
    screenshotBitmap.height
  );

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

async function requestImageAnalysisByUrl(imageUrl) {
  const { response, data } = await sendServerRequest("/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl }),
  });

  return requireSuccessfulResponse(response, data, { allowBlobFallback: true });
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

  const { response, data } = await sendServerRequest("/analyze/blob", {
    method: "POST",
    body: form,
  });

  return requireSuccessfulResponse(response, data);
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
    // The DOM rectangle is in viewport coordinates, so scale it to the actual
    // screenshot size before cropping.
    const bounds = getScaledCaptureBounds(captureArea, screenshotBitmap);

    if (bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("Image is not visible enough to capture");
    }

    const canvas = new OffscreenCanvas(bounds.width, bounds.height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Could not create capture canvas");
    }

    context.drawImage(
      screenshotBitmap,
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height
    );

    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    screenshotBitmap.close();
  }
}

async function requestImageAnalysisByScreenshot(captureArea, sender) {
  const windowId = sender.tab?.windowId;

  if (!Number.isInteger(windowId)) {
    throw new Error("Cannot capture the current tab");
  }

  const screenshotBlob = await captureImageBlob(captureArea, windowId);
  return requestImageAnalysisByBlob(screenshotBlob, "client-capture.png");
}

function createAnalysisSteps(message, sender) {
  const steps = [];

  // Try the cheapest backend path first. If the server cannot reach the image,
  // fall back to uploading bytes from the browser.
  if (isRemoteUrl(message.url)) {
    steps.push({
      label: "backend URL analysis",
      run: async () => {
        const data = await requestImageAnalysisByUrl(message.url);

        if (data?.needsBlob) {
          throw new Error(data.error || "Server requested a blob upload");
        }

        return data;
      },
    });
  }

  steps.push({
    label: "extension image fetch upload",
    run: async () => {
      const imageBlob = await fetchImageBlob(message.url);
      return requestImageAnalysisByBlob(imageBlob, "client-image");
    },
  });

  steps.push({
    label: "tab screenshot upload",
    run: async () => requestImageAnalysisByScreenshot(message.captureArea, sender),
  });

  return steps;
}

async function resolveImageAnalysis(message, sender) {
  if (typeof message?.url !== "string" || !message.url) {
    throw new Error("Missing image URL");
  }

  const errors = [];

  for (const step of createAnalysisSteps(message, sender)) {
    try {
      return await step.run();
    } catch (error) {
      const stepError = `${step.label}: ${getErrorMessage(error)}`;
      console.warn(`[background] ${stepError}`);
      errors.push(stepError);
    }
  }

  throw new Error(collapseErrors(errors));
}

async function handleAnalyzeImageMessage(message, sender, sendResponse) {
  try {
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
  if (message?.type !== ANALYZE_IMAGE_MESSAGE) {
    return;
  }

  void handleAnalyzeImageMessage(message, sender, sendResponse);
  return true;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
