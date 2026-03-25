import cors from "cors";
import express from "express";
import multer from "multer";
import OpenAI from "openai";

function loadEnvironment() {
  try {
    process.loadEnvFile(new URL("./.env", import.meta.url));
    console.log("[server] Loaded environment variables from backend/.env");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("[server] No backend/.env file found. Using process environment variables.");
      return;
    }

    if (error?.code !== "ENOENT") {
      console.warn("Could not load backend/.env:", error);
    }
  }
}

loadEnvironment();

const PORT = Number(process.env.PORT) || 3067;
const API_KEY = process.env.OPENAI_API_KEY;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY }) : null;
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

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

async function analyzeImage(imageUrl, context = {}) {
  const source = imageUrl.startsWith("data:") ? "blob" : "url";

  logDebug(`${context.requestTag || "[req ?]"} Starting OpenAI image analysis`, {
    model: "gpt-5.4-mini",
    source,
    imageUrl: source === "url" ? summarizeText(imageUrl) : undefined,
    payloadLength: imageUrl.length,
  });

  const response = await getOpenAIClient().responses.create({
    model: "gpt-5.4-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Describe this image for a user who cannot see it. Keep it concise and mention the most important visual details.",
          },
          {
            type: "input_image",
            image_url: imageUrl,
          },
        ],
      },
    ],
  });

  const description = response.output_text?.trim() || "(no description)";

  logDebug(`${context.requestTag || "[req ?]"} OpenAI image analysis completed`, {
    responseId: response.id,
    outputLength: description.length,
  });

  return description;
}

function abortFetch(controller) {
  controller.abort();
}

async function canUseImageUrl(imageUrl, context = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(abortFetch, 5000, controller);

  try {
    logDebug(`${context.requestTag || "[req ?]"} Checking image URL accessibility`, {
      imageUrl: summarizeText(imageUrl),
    });

    const response = await fetch(imageUrl, { signal: controller.signal });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const looksLikeImage = contentType === "" || contentType.startsWith("image/");

    await response.body?.cancel?.();

    logDebug(`${context.requestTag || "[req ?]"} Image URL fetch completed`, {
      ok: response.ok,
      status: response.status,
      contentType: contentType || "(missing)",
      looksLikeImage,
    });

    return response.ok && looksLikeImage;
  } catch (error) {
    logDebug(`${context.requestTag || "[req ?]"} Image URL fetch failed`, {
      imageUrl: summarizeText(imageUrl),
      error: getErrorMessage(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAnalyzeRequest(req, res) {
  const requestTag = getRequestTag(req);

  try {
    const imageUrl = req.body?.imageUrl;

    logDebug(`${requestTag} Received analyze URL request`, {
      hasImageUrl: Boolean(imageUrl),
      imageUrl: summarizeText(imageUrl),
    });

    if (!imageUrl) {
      logDebug(`${requestTag} Rejecting analyze URL request: missing imageUrl`);
      return res.status(400).json({ error: "No image URL provided" });
    }

    if (!isHttpUrl(imageUrl)) {
      logDebug(`${requestTag} Rejecting analyze URL request: invalid protocol`, {
        imageUrl: summarizeText(imageUrl),
      });
      return res.status(400).json({ error: "imageUrl must be an http or https URL" });
    }

    if (!(await canUseImageUrl(imageUrl, { requestTag }))) {
      logDebug(`${requestTag} Rejecting analyze URL request: image URL inaccessible`);
      return res.status(409).json({
        error: "Server could not access the image URL. Upload the blob instead.",
        needsBlob: true,
      });
    }

    const description = await analyzeImage(imageUrl, { requestTag });
    logDebug(`${requestTag} Sending analyze URL response`, {
      descriptionLength: description.length,
    });
    res.json({ description, source: "url" });
  } catch (error) {
    logDebug(`${requestTag} Analyze URL request failed`, {
      error: getErrorMessage(error),
    });
    console.error(error);
    res.status(error?.message === "OPENAI_API_KEY is not set" ? 503 : 500).json({
      error: getErrorMessage(error),
    });
  }
}

async function handleAnalyzeBlobRequest(req, res) {
  const requestTag = getRequestTag(req);

  try {
    logDebug(`${requestTag} Received analyze blob request`, {
      hasFile: Boolean(req.file),
      fileName: req.file?.originalname || null,
      mimeType: req.file?.mimetype || null,
      size: req.file?.size || 0,
    });

    if (!req.file) {
      logDebug(`${requestTag} Rejecting analyze blob request: no file uploaded`);
      return res.status(400).json({ error: "No image uploaded" });
    }

    const mimeType = req.file.mimetype || "image/jpeg";

    if (!mimeType.startsWith("image/")) {
      logDebug(`${requestTag} Rejecting analyze blob request: uploaded file is not an image`, {
        mimeType,
      });
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    const dataUrl = `data:${mimeType};base64,${req.file.buffer.toString("base64")}`;
    logDebug(`${requestTag} Prepared image data URL from upload`, {
      mimeType,
      fileSize: req.file.size,
      dataUrlLength: dataUrl.length,
    });

    const description = await analyzeImage(dataUrl, { requestTag });

    logDebug(`${requestTag} Sending analyze blob response`, {
      descriptionLength: description.length,
    });

    res.json({ description, source: "blob" });
  } catch (error) {
    logDebug(`${requestTag} Analyze blob request failed`, {
      error: getErrorMessage(error),
    });
    console.error(error);
    res.status(error?.message === "OPENAI_API_KEY is not set" ? 503 : 500).json({
      error: getErrorMessage(error),
    });
  }
}

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
    logDebug(`${getRequestTag(req)} Unhandled server error`, {
      error: getErrorMessage(error),
    });
    console.error(error);
    return res.status(500).json({ error: getErrorMessage(error) });
  }

  next();
}

function logServerStart() {
  console.log(`Server running at http://localhost:${PORT}`);
  logDebug("Server startup configuration", {
    port: PORT,
    openaiConfigured: Boolean(API_KEY),
  });

  if (!API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Image analysis requests will fail until it is configured.");
  }
}

app.post("/analyze", handleAnalyzeRequest);
app.post("/analyze/blob", upload.single("image"), handleAnalyzeBlobRequest);
app.use(handleServerError);

app.listen(PORT, logServerStart);
