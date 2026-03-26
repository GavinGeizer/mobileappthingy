import cors from "cors";
import express from "express";
import multer from "multer";
import OpenAI from "openai";

const DEFAULT_PORT = 3067;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 5000;
const ANALYSIS_MODEL = "gpt-5.4-mini";
const IMAGE_DESCRIPTION_PROMPT = "Describe this image for a user who cannot see it. Keep it concise and mention the most important visual details.";

function loadEnvironment() {
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

loadEnvironment();

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const API_KEY = process.env.OPENAI_API_KEY;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY }) : null;

let nextRequestId = 0;

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logDebug(message, details) {
  const timestamp = new Date().toISOString();

  if (details === undefined) {
    console.log(`[${timestamp}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] ${message}`, details);
}

function summarizeText(value, maxLength = 160) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getRequestTag(req) {
  return `[req ${req.requestId ?? "?"}]`;
}

function getStatusCodeForError(error) {
  if (Number.isInteger(error?.statusCode)) {
    return error.statusCode;
  }

  return error?.message === "OPENAI_API_KEY is not set" ? 503 : 500;
}

function respondWithJsonError(req, res, status, logMessage, payload, details) {
  logDebug(`${getRequestTag(req)} ${logMessage}`, details);
  return res.status(status).json(payload);
}

function respondWithRouteFailure(req, res, routeLabel, error) {
  logDebug(`${getRequestTag(req)} ${routeLabel} failed`, {
    error: getErrorMessage(error),
  });
  console.error(error);
  return res.status(getStatusCodeForError(error)).json({
    error: getErrorMessage(error),
  });
}

function wrapRoute(routeLabel, handler) {
  return async function wrappedRoute(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      return respondWithRouteFailure(req, res, routeLabel, error);
    }
  };
}

// Attach a small request id to every request so the backend logs remain readable
// even when multiple image analyses are happening in parallel.
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

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function getOpenAIClient() {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  return openai;
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Keep the OpenAI request payload construction in one place so prompt updates
// do not need to be repeated across the URL and blob endpoints.
function buildAnalysisInput(imageUrl) {
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

async function analyzeImage(imageUrl, { requestTag = "[req ?]" } = {}) {
  const source = imageUrl.startsWith("data:") ? "blob" : "url";

  logDebug(`${requestTag} Starting OpenAI image analysis`, {
    model: ANALYSIS_MODEL,
    source,
    imageUrl: source === "url" ? summarizeText(imageUrl) : undefined,
    payloadLength: imageUrl.length,
  });

  const response = await getOpenAIClient().responses.create({
    model: ANALYSIS_MODEL,
    input: buildAnalysisInput(imageUrl),
  });

  const description = response.output_text?.trim() || "(no description)";

  logDebug(`${requestTag} OpenAI image analysis completed`, {
    responseId: response.id,
    outputLength: description.length,
  });

  return description;
}

// Probe the URL before sending it to OpenAI so the extension can switch to a
// blob upload immediately when the backend cannot reach the original image.
async function canUseImageUrl(imageUrl, { requestTag = "[req ?]" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

  try {
    logDebug(`${requestTag} Checking image URL accessibility`, {
      imageUrl: summarizeText(imageUrl),
    });

    const response = await fetch(imageUrl, { signal: controller.signal });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const looksLikeImage = contentType === "" || contentType.startsWith("image/");

    await response.body?.cancel?.();

    logDebug(`${requestTag} Image URL fetch completed`, {
      ok: response.ok,
      status: response.status,
      contentType: contentType || "(missing)",
      looksLikeImage,
    });

    return response.ok && looksLikeImage;
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

function createImageDataUrl(file) {
  const mimeType = file.mimetype || "image/jpeg";

  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${file.buffer.toString("base64")}`,
  };
}

// Both endpoints end by asking OpenAI for a description, so keep the response
// formatting and success logging in one shared helper.
async function sendAnalysisResponse(req, res, imageUrl, source) {
  const requestTag = getRequestTag(req);
  const description = await analyzeImage(imageUrl, { requestTag });

  logDebug(`${requestTag} Sending analyze ${source} response`, {
    descriptionLength: description.length,
  });

  return res.json({ description, source });
}

const handleAnalyzeRequest = wrapRoute("Analyze URL request", async (req, res) => {
  const requestTag = getRequestTag(req);
  const imageUrl = req.body?.imageUrl;

  logDebug(`${requestTag} Received analyze URL request`, {
    hasImageUrl: Boolean(imageUrl),
    imageUrl: summarizeText(imageUrl),
  });

  if (!imageUrl) {
    return respondWithJsonError(
      req,
      res,
      400,
      "Rejecting analyze URL request: missing imageUrl",
      { error: "No image URL provided" }
    );
  }

  if (!isHttpUrl(imageUrl)) {
    return respondWithJsonError(
      req,
      res,
      400,
      "Rejecting analyze URL request: invalid protocol",
      { error: "imageUrl must be an http or https URL" },
      { imageUrl: summarizeText(imageUrl) }
    );
  }

  if (!(await canUseImageUrl(imageUrl, { requestTag }))) {
    return respondWithJsonError(
      req,
      res,
      409,
      "Rejecting analyze URL request: image URL inaccessible",
      {
        error: "Server could not access the image URL. Upload the blob instead.",
        needsBlob: true,
      }
    );
  }

  return sendAnalysisResponse(req, res, imageUrl, "url");
});

const handleAnalyzeBlobRequest = wrapRoute("Analyze blob request", async (req, res) => {
  const requestTag = getRequestTag(req);

  logDebug(`${requestTag} Received analyze blob request`, {
    hasFile: Boolean(req.file),
    fileName: req.file?.originalname || null,
    mimeType: req.file?.mimetype || null,
    size: req.file?.size || 0,
  });

  if (!req.file) {
    return respondWithJsonError(
      req,
      res,
      400,
      "Rejecting analyze blob request: no file uploaded",
      { error: "No image uploaded" }
    );
  }

  const { mimeType, dataUrl } = createImageDataUrl(req.file);

  if (!mimeType.startsWith("image/")) {
    return respondWithJsonError(
      req,
      res,
      400,
      "Rejecting analyze blob request: uploaded file is not an image",
      { error: "Uploaded file must be an image" },
      { mimeType }
    );
  }

  logDebug(`${requestTag} Prepared image data URL from upload`, {
    mimeType,
    fileSize: req.file.size,
    dataUrlLength: dataUrl.length,
  });

  return sendAnalysisResponse(req, res, dataUrl, "blob");
});

function handleServerError(error, req, res, next) {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Uploaded image exceeds the 15 MB limit"
      : error.message;

    logDebug(`${getRequestTag(req)} Multer error handled`, {
      code: error.code,
      message,
    });
    return res.status(400).json({ error: message });
  }

  if (error) {
    return respondWithRouteFailure(req, res, "Unhandled server error", error);
  }

  next();
}

function logServerStart() {
  console.log(`Server running at http://localhost:${PORT}`);
  logDebug("Server startup configuration", {
    port: PORT,
    openaiConfigured: Boolean(API_KEY),
    model: ANALYSIS_MODEL,
  });

  if (!API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Image analysis requests will fail until it is configured.");
  }
}

app.post("/analyze", handleAnalyzeRequest);
app.post("/analyze/blob", upload.single("image"), handleAnalyzeBlobRequest);
app.use(handleServerError);

app.listen(PORT, logServerStart);
