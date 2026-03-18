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
 * Fetches the image data in the extension context and returns it as a blob.
 *
 * @param {string} imageUrl - The image URL to fetch.
 * @returns {Promise<Blob>} The fetched image blob.
 */
async function fetchImageBlob(imageUrl) {
  const imgRes = await fetch(imageUrl);

  if (!imgRes.ok) {
    throw new Error(`Image fetch failed: ${imgRes.status}`);
  }

  return imgRes.blob();
}

/**
 * Requests image analysis from the server using an uploaded blob fallback.
 *
 * @param {string} imageUrl - The image URL to fetch and convert into a blob.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByBlob(imageUrl) {
  const blobRep = await fetchImageBlob(imageUrl);
  const form = new FormData();

  form.append("image", blobRep, "image.jpg");

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
 * Handles the end-to-end image analysis flow for a content script message.
 *
 * @param {{ url: string }} msg - The message sent from the content script.
 * @param {(response: { ok: boolean, description?: string, error?: string }) => void} sendResponse - Sends a result back to the content script.
 * @returns {Promise<void>}
 */
async function handleAnalyzeImageMessage(msg, sendResponse) {
  try {
    const url = new URL(msg.url);
    const isRemoteUrl = url.protocol === "http:" || url.protocol === "https:";
    let data;

    if (isRemoteUrl) {
      data = await requestImageAnalysisByUrl(msg.url);
    }

    if (!isRemoteUrl || data?.needsBlob) {
      data = await requestImageAnalysisByBlob(msg.url);
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
    sendResponse({ ok: false, error: String(err?.message || err) });
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

  handleAnalyzeImageMessage(msg, sendResponse);

  // Keeps communication channel to content open.
  // Tells Chrome to wait until sendResponse completes.
  // Then channel closes after sendResponse executes.
  // Without return true; the channel closes right away
  // when it gets to the end of the listener.
  return true;
}

chrome.runtime.onMessage.addListener(onRuntimeMessage);
