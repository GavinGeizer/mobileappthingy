import cors from "cors";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { createBlobCacheKey, createScanCache, createUrlCacheKey } from "./scanCache.js";

/* 
Main server application file. Defines the Express app, routes, and core services for analyzing images using OpenAI's API, with caching and error handling.
we use the app.js file as its best practice. we call on this file from the server.js file.

Authors: @gavingeizer, Ajay, Matt

*/

export const DEFAULT_PORT = 3067;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const URL_FETCH_TIMEOUT_MS = 5000;
export const ANALYSIS_MODEL = "gpt-5.4-mini";
export const IMAGE_DESCRIPTION_PROMPT = ` 
Describe this image as if speaking to someone who cannot see it.

Focus on what matters most:
- Main subject or focal point
- Key actions or interactions happening
- Important text, numbers, or symbols visible
- Relevant colors, spatial relationships, or composition

Speak naturally and conversationally. Prioritize information that helps the listener understand the image's purpose and content. Keep it brief—aim for 2-3 sentences unless the image is complex.`;

//load eniroment fuction, self explanitory.
export function loadEnvironment() {
  try {
    process.loadEnvFile(new URL("./.env", import.meta.url));
    console.log("[server] Loaded environment variables from backend/.env");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("[server] No backend/.env file found. Using process environment variables.");
      return;
    }

    console.warn("Could not load backend/.env:", error);
  }
}
// get error message, self explanitory.
export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
// log debug message, self explanitory.
export function logDebug(message, details) {
  const timestamp = new Date().toISOString();

  if (details === undefined) {
    console.log(`[${timestamp}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] ${message}`, details);
}

// Test utilities
function summarizeText(value, maxLength = 160) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

// fun way of getting request tag for logging purposes
function getRequestTag(req) {
  return `[req ${req.requestId ?? "?"}]`;
}

// Determine appropriate HTTP status code for an error, with special handling for known cases
function getStatusCodeForError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }

  if (Number.isInteger(error?.status)) {
    return error.status;
  }

  return error?.message === "OPENAI_API_KEY is not set" ? 503 : 500;
}

// Log a route failure with error details, and print the error stack to the console for debugging
function logRouteFailure(req, routeLabel, error) {
  logDebug(`${getRequestTag(req)} ${routeLabel} failed`, {
    error: getErrorMessage(error),
  });
  console.error(error);
}

// Send a standardized error response to the client, and log the error with a consistent format
function sendErrorResponse(req, res, {
  status,
  clientMessage,
  logMessage,
  details,
}) {
  logDebug(`${getRequestTag(req)} ${logMessage}`, details);
  return res.status(status).json({ error: clientMessage });
}

// Handle unexpected server errors by logging them and sending a generic error response to the client
function sendServerError(req, res, routeLabel, error) {
  logRouteFailure(req, routeLabel, error);
  return res.status(getStatusCodeForError(error)).json({
    error: getErrorMessage(error),
  });
}

// Express middleware to log incoming requests and their outcomes, including method, path, content type, status code, and duration
function attachRequestLogging(app) {
  let nextRequestId = 0;

  app.use((req, res, next) => {
    req.requestId = ++nextRequestId;
    const requestTag = getRequestTag(req);
    const startedAt = Date.now();

    logDebug(`${requestTag} Incoming request`, {
      method: req.method,
      path: req.originalUrl,
      contentType: req.headers["content-type"] || null,
      contentLength: req.headers["content-length"] || null,
    });

    res.on("finish", () => {
      logDebug(`${requestTag} Request completed`, {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });
}

// our implementation to check if url is valid.
export function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// build the request payload for the OpenAI image analysis endpoint, combining a fixed prompt with the provided image URL
export function buildAnalysisInput(imageUrl) {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: IMAGE_DESCRIPTION_PROMPT,
        },
        {
          type: "input_image",
          image_url: imageUrl,
        },
      ],
    },
  ];
}


// actually start the server, with the provided app and port, and log the startup configuration
export function createServerServices({
  apiKey = process.env.OPENAI_API_KEY,
  openaiClient = apiKey ? new OpenAI({ apiKey }) : null,
  fetchImpl = globalThis.fetch,
  cache = createScanCache({ logger: logDebug }),
  analysisModel = ANALYSIS_MODEL,
  urlFetchTimeoutMs = URL_FETCH_TIMEOUT_MS,
} = {}) {
  // Helper function to get the OpenAI client, throwing an error if it's not configured
  function getOpenAIClient() {
    if (!openaiClient) {
      throw new Error("OPENAI_API_KEY is not set");
    }

    return openaiClient;
  }
  // Analyze the image at the given URL using OpenAI's API, with logging and error handling
  async function analyzeImage(imageUrl, { requestTag = "[req ?]" } = {}) {
    const source = imageUrl.startsWith("data:") ? "blob" : "url";

    logDebug(`${requestTag} Starting OpenAI image analysis`, {
      model: analysisModel,
      source,
      imageUrl: source === "url" ? summarizeText(imageUrl) : undefined,
      payloadLength: imageUrl.length,
    });

    const response = await getOpenAIClient().responses.create({
      model: analysisModel,
      input: buildAnalysisInput(imageUrl),
    });

    const description = response.output_text?.trim() || "(no description)";

    logDebug(`${requestTag} OpenAI image analysis completed`, {
      responseId: response.id,
      outputLength: description.length,
    });

    return description;
  }

  // Check if the provided image URL is accessible and looks like an image, using a HEAD request with a fallback to a range GET if necessary, and logging the process
  async function canUseImageUrl(imageUrl, { requestTag = "[req ?]" } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), urlFetchTimeoutMs);

    try {
      logDebug(`${requestTag} Checking image URL accessibility`, {
        imageUrl: summarizeText(imageUrl),
      });

      const headResponse = await fetchImpl(imageUrl, {
        method: "HEAD",
        signal: controller.signal,
      });
      const headContentType = (headResponse.headers.get("content-type") || "").toLowerCase();
      const headHasUsefulHeaders = headContentType !== "";
      const headLooksLikeImage = headContentType.startsWith("image/");
      const shouldFallbackToRangeGet =
        headResponse.status === 405 || headResponse.status === 501 || !headHasUsefulHeaders;

      await headResponse.body?.cancel?.();

      logDebug(`${requestTag} Image URL HEAD probe completed`, {
        ok: headResponse.ok,
        status: headResponse.status,
        contentType: headContentType || "(missing)",
        looksLikeImage: headLooksLikeImage,
        shouldFallbackToRangeGet,
      });

      if (headResponse.ok && headLooksLikeImage) {
        return true;
      }

      if (!shouldFallbackToRangeGet) {
        return false;
      }

      const getResponse = await fetchImpl(imageUrl, {
        method: "GET",
        headers: { Range: "bytes=0-1023" },
        signal: controller.signal,
      });
      const getContentType = (getResponse.headers.get("content-type") || "").toLowerCase();
      const getLooksLikeImage = getContentType.startsWith("image/");

      await getResponse.body?.cancel?.();

      logDebug(`${requestTag} Image URL range GET probe completed`, {
        ok: getResponse.ok,
        status: getResponse.status,
        contentType: getContentType || "(missing)",
        looksLikeImage: getLooksLikeImage,
      });

      return getResponse.ok && getLooksLikeImage;
    } catch (error) {
      logDebug(`${requestTag} Image URL fetch failed`, {
        imageUrl: summarizeText(imageUrl),
        error: getErrorMessage(error),
      });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    analyzeImage,
    canUseImageUrl,
    cache,
  };
}
// Helper function to create a data URL from an uploaded file buffer, including the MIME type for use in analysis
function createImageDataUrl(file) {
  const mimeType = file.mimetype || "image/jpeg";

  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${file.buffer.toString("base64")}`,
  };
}
// Safely read a cached response from the cache, with error handling to degrade gracefully if the cache is unavailable or throws an error
function readCachedResponse(cache, { key, requestTag }) {
  if (!cache?.read) {
    return null;
  }

  try {
    return cache.read({ key, requestTag });
  } catch (error) {
    logDebug(`${requestTag} cache degraded`, {
      action: "read",
      key: summarizeText(key),
      error: getErrorMessage(error),
    });
    return null;
  }
}
// Safely write a response to the cache, with error handling to degrade gracefully if the cache is unavailable or throws an error
function writeCachedResponse(cache, { key, entryType, statusCode, payload, requestTag }) {
  if (!cache?.write) {
    return false;
  }

  try {
    return cache.write({
      key,
      entryType,
      statusCode,
      payload,
      requestTag,
    });
  } catch (error) {
    logDebug(`${requestTag} cache degraded`, {
      action: "write",
      key: summarizeText(key),
      error: getErrorMessage(error),
    });
    return false;
  }
}
// Send a cached response to the client, with logging to indicate that the response is being served from cache
function sendCachedResponse(req, res, cachedResponse) {
  logDebug(`${getRequestTag(req)} Sending cached response`, {
    entryType: cachedResponse.entryType,
    statusCode: cachedResponse.statusCode,
  });

  return res.status(cachedResponse.statusCode).json(cachedResponse.payload);
}
// blob fallback request
function buildBlobFallbackPayload() {
  return {
    error: "Server could not access the image URL. Upload the blob instead.",
    needsBlob: true,
  };
}
// also blob fallback response, with logging to indicate that the server is rejecting the URL analysis request and asking for a blob upload instead
function sendBlobFallbackResponse(req, res, payload) {
  logDebug(`${getRequestTag(req)} Rejecting analyze URL request: image URL inaccessible`);
  return res.status(409).json(payload);
}
// multer
function createMulterUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });
}
// URL request handeler, checks cache, validates URL, checks accessibility, analyzes image, and handles errors with appropriate responses and logging
function createAnalyzeUrlHandler({ analyzeImage, canUseImageUrl, cache }) {
  return async function analyzeUrlHandler(req, res) {
    const requestTag = getRequestTag(req);
    const imageUrl = req.body?.imageUrl;

    logDebug(`${requestTag} Received analyze URL request`, {
      hasImageUrl: Boolean(imageUrl),
      imageUrl: summarizeText(imageUrl),
    });

    if (!imageUrl) {
      return sendErrorResponse(req, res, {
        status: 400,
        clientMessage: "No image URL provided",
        logMessage: "Rejecting analyze URL request: missing imageUrl",
      });
    }

    if (!isHttpUrl(imageUrl)) {
      return sendErrorResponse(req, res, {
        status: 400,
        clientMessage: "imageUrl must be an http or https URL",
        logMessage: "Rejecting analyze URL request: invalid protocol",
        details: { imageUrl: summarizeText(imageUrl) },
      });
    }

    const cacheKey = createUrlCacheKey(imageUrl);
    const cachedResponse = readCachedResponse(cache, { key: cacheKey, requestTag });

    if (cachedResponse) {
      return sendCachedResponse(req, res, cachedResponse);
    }

    try {
      const urlIsUsable = await canUseImageUrl(imageUrl, { requestTag });

      if (!urlIsUsable) {
        const payload = buildBlobFallbackPayload();

        writeCachedResponse(cache, {
          key: cacheKey,
          entryType: "url",
          statusCode: 409,
          payload,
          requestTag,
        });

        return sendBlobFallbackResponse(req, res, payload);
      }

      const description = await analyzeImage(imageUrl, { requestTag });
      const payload = { description, source: "url" };

      writeCachedResponse(cache, {
        key: cacheKey,
        entryType: "url",
        statusCode: 200,
        payload,
        requestTag,
      });

      logDebug(`${requestTag} Sending analyze url response`, {
        descriptionLength: description.length,
      });

      return res.json(payload);
    } catch (error) {
      return sendServerError(req, res, "Analyze URL request", error);
    }
  };
}
// Blob request handler, checks cache, validates upload, prepares data URL, analyzes image, and handles errors with appropriate responses and logging
function createAnalyzeBlobHandler({ analyzeImage, cache }) {
  return async function analyzeBlobHandler(req, res) {
    const requestTag = getRequestTag(req);

    logDebug(`${requestTag} Received analyze blob request`, {
      hasFile: Boolean(req.file),
      fileName: req.file?.originalname || null,
      mimeType: req.file?.mimetype || null,
      size: req.file?.size || 0,
    });

    if (!req.file) {
      return sendErrorResponse(req, res, {
        status: 400,
        clientMessage: "No image uploaded",
        logMessage: "Rejecting analyze blob request: no file uploaded",
      });
    }

    const { mimeType, dataUrl } = createImageDataUrl(req.file);

    if (!mimeType.startsWith("image/")) {
      return sendErrorResponse(req, res, {
        status: 400,
        clientMessage: "Uploaded file must be an image",
        logMessage: "Rejecting analyze blob request: uploaded file is not an image",
        details: { mimeType },
      });
    }

    const cacheKey = createBlobCacheKey(req.file.buffer);
    const cachedResponse = readCachedResponse(cache, { key: cacheKey, requestTag });

    if (cachedResponse) {
      return sendCachedResponse(req, res, cachedResponse);
    }

    logDebug(`${requestTag} Prepared image data URL from upload`, {
      mimeType,
      fileSize: req.file.size,
      dataUrlLength: dataUrl.length,
    });

    try {
      const description = await analyzeImage(dataUrl, { requestTag });
      const payload = { description, source: "blob" };

      writeCachedResponse(cache, {
        key: cacheKey,
        entryType: "blob",
        statusCode: 200,
        payload,
        requestTag,
      });

      logDebug(`${requestTag} Sending analyze blob response`, {
        descriptionLength: description.length,
      });

      return res.json(payload);
    } catch (error) {
      return sendServerError(req, res, "Analyze blob request", error);
    }
  };
}

// Express middleware to handle errors thrown by multer during file upload, translating them into appropriate HTTP responses and logging the error details
function handleUploadError(error, req, res, next) {
  if (!(error instanceof multer.MulterError)) {
    next(error);
    return;
  }

  const message = error.code === "LIMIT_FILE_SIZE"
    ? "Uploaded image exceeds the 15 MB limit"
    : error.message;

  logDebug(`${getRequestTag(req)} Multer error handled`, {
    code: error.code,
    message,
  });
  res.status(400).json({ error: message });
}

// Main function to create the Express app, defining the routes and attaching the necessary middleware and handlers for analyzing images via URL or blob upload, with caching support
export function createApp({
  analyzeImage,
  canUseImageUrl,
  cache = null,
} = {}) {
  if (typeof analyzeImage !== "function") {
    throw new TypeError("createApp requires an analyzeImage function");
  }

  if (typeof canUseImageUrl !== "function") {
    throw new TypeError("createApp requires a canUseImageUrl function");
  }

  const app = express();
  const upload = createMulterUpload();

  attachRequestLogging(app);

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.post("/analyze", createAnalyzeUrlHandler({ analyzeImage, canUseImageUrl, cache }));
  app.post("/analyze/blob", upload.single("image"), createAnalyzeBlobHandler({ analyzeImage, cache }));

  app.use(handleUploadError);
  app.use((error, req, res, _next) => sendServerError(req, res, "Unhandled server error", error));

  return app;
}

// log the server startup configuration, including port, OpenAI configuration status, cache path, and analysis model, with a warning if OpenAI is not configured
export function logServerStart({
  port,
  openaiConfigured,
  cachePath,
  model = ANALYSIS_MODEL,
}) {
  console.log(`Server running at http://localhost:${port}`);
  logDebug("Server startup configuration", {
    port,
    openaiConfigured,
    cachePath: cachePath || null,
    model,
  });

  if (!openaiConfigured) {
    console.warn("OPENAI_API_KEY is not set. Image analysis requests will fail until it is configured.");
  }
}
// actually start the server, with the provided app and port, and log the startup configuration
export function startServer(app, port, onListen) {
  return app.listen(port, onListen);
}
