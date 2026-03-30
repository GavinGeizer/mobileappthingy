/*
  The purpose of this file is to provide the background script for Server 3.

  Note that this extension uses an endpoint different than the server code given.
  manifest.json must be updated to test your server code.

  comments for functions in this file are in JSDoc format, which is a common way to document JavaScript code.
  you can find out all the translations here: https://jsdoc.app/tags-param.html - Gavin

  Athor: Terry, Gavin, Ajay, Matt
*/

const SERVER_URL = "http://mapd.cs-smu.ca:3067";

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
  // If the response isn't JSON, attempt to read it as text for error reporting.
  // returns a empty string if response.text() fails for any reason (e.g., body already read, network error)
  return { error: await response.text().catch(() => "") };
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
  // If the server response is not OK, but indicates that a blob upload is needed, return that info instead of throwing an error.
  if (serverRes.ok) {
    return data;
  }
  // If the server response is not OK and does not indicate a blob upload is needed, throw an error to be caught by the caller.
  if (data?.needsBlob) {
    return data;
  }
  // throw an error because the server response is not OK and does not indicate a blob upload is needed, which means the request failed for some reason other than needing a blob upload.
  // reasons this occur could be OpenAI server Failure, Server Code Failure, Network Failure, etc.
  // or special edgecases like av1f image files, canvas images with tainting issues, or CORS issues that prevent the server from accessing the image URL directly. 
  throw new Error(`Server failed: ${serverRes.status} ${data?.error || ""}`);
}

/**
 * Fetches the image data in the extension context and returns it as a blob.
 *
 * @param {string} imageUrl - The image URL to fetch.
 * @returns {Promise<Blob>} The fetched image blob.
 */
async function fetchImageBlob(imageUrl) {
  // Fetch the image data directly in the extension context to bypass CORS issues and other access problems that the server might encounter.
  const imgRes = await fetch(imageUrl);

  // if for whatever reason the image fetch fails (e.g., network error, CORS issue, invalid URL (somehow)), throw an error to be caught by the caller.
  if (!imgRes.ok) {
    throw new Error(`Image fetch failed: ${imgRes.status}`);
  }
  // simply return the image data as a blob.
  return imgRes.blob();
}

/**
 * Requests image analysis from the server using an uploaded blob fallback.
 *
 * @param {string} imageUrl - The image URL to fetch and convert into a blob.
 * @returns {Promise<object>} The server response payload.
 */
async function requestImageAnalysisByBlob(imageAsBlob) {
  const blobRep = await fetchImageBlob(imageAsBlob);
  const form = new FormData();

  // Append the image blob to the form data with the field name "image" and a filename of "image.jpg".
  // we do not need it to specificly be a .jpg file, but some filename is required by the server code to process the upload.
  form.append("image", blobRep, "image.jpg");

  // Send the image blob to the server for analysis using the blob endpoint.
  const serverRes = await fetch(`${SERVER_URL}/analyze/blob`, {
    method: "POST",
    body: form,
  });

  const data = await readServerPayload(serverRes);

  //best practice check.
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
    // First attempt to analyze the image using the original URL. This is more efficient and preserves metadata when it works.

    const url = new URL(msg.url);
    // Check if the URL is a remote URL (http or https). If it's not, we should skip directly to the blob upload method since the server won't be able to access it.
    const isRemoteUrl = url.protocol === "http:" || url.protocol === "https:";
    let data;

    if (isRemoteUrl) {
      data = await requestImageAnalysisByUrl(msg.url);
    }

    if (!isRemoteUrl || data?.needsBlob) {
      data = await requestImageAnalysisByBlob(msg.url);
    }

    // If we have data at this point, it means the analysis succeeded either by URL or blob method. We can send the description back to the content script.
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

// Listen for messages from the content script.
chrome.runtime.onMessage.addListener(onRuntimeMessage);
