import cors from "cors";
import express from "express";
import multer from "multer";
import OpenAI from "openai";

function loadEnvironment() {
  try {
    process.loadEnvFile(new URL("./.env", import.meta.url));
  } catch (error) {
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

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

async function analyzeImage(imageUrl) {
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

  return response.output_text?.trim() || "(no description)";
}

function abortFetch(controller) {
  controller.abort();
}

async function canUseImageUrl(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(abortFetch, 5000, controller);

  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const looksLikeImage = contentType === "" || contentType.startsWith("image/");

    await response.body?.cancel?.();

    return response.ok && looksLikeImage;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAnalyzeRequest(req, res) {
  try {
    const imageUrl = req.body?.imageUrl;

    if (!imageUrl) {
      return res.status(400).json({ error: "No image URL provided" });
    }

    if (!isHttpUrl(imageUrl)) {
      return res.status(400).json({ error: "imageUrl must be an http or https URL" });
    }

    if (!(await canUseImageUrl(imageUrl))) {
      return res.status(409).json({
        error: "Server could not access the image URL. Upload the blob instead.",
        needsBlob: true,
      });
    }

    const description = await analyzeImage(imageUrl);
    res.json({ description, source: "url" });
  } catch (error) {
    console.error(error);
    res.status(error?.message === "OPENAI_API_KEY is not set" ? 503 : 500).json({
      error: getErrorMessage(error),
    });
  }
}

async function handleAnalyzeBlobRequest(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const mimeType = req.file.mimetype || "image/jpeg";

    if (!mimeType.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image" });
    }

    const dataUrl = `data:${mimeType};base64,${req.file.buffer.toString("base64")}`;
    const description = await analyzeImage(dataUrl);

    res.json({ description, source: "blob" });
  } catch (error) {
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

    return res.status(400).json({ error: message });
  }

  if (error) {
    console.error(error);
    return res.status(500).json({ error: getErrorMessage(error) });
  }

  next();
}

function logServerStart() {
  console.log(`Server running at http://localhost:${PORT}`);

  if (!API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Image analysis requests will fail until it is configured.");
  }
}

app.post("/analyze", handleAnalyzeRequest);
app.post("/analyze/blob", upload.single("image"), handleAnalyzeBlobRequest);
app.use(handleServerError);

app.listen(PORT, logServerStart);
