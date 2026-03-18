/*
  The purpose of this file is to provide a partial server solution for Server 3.

  author: Terry

*/

import express from "express";
import multer from "multer";
import cors from "cors";
// import OpenAi Software Development Kit (SDK)
// to pay for credits and get your own API key
// go to the OpenAI Platform for billing
import OpenAI from "openai";

const PORT = 3067;
const app = express();

// keep uploads in memory and set a file size limit of 15MB
const upload = multer({
  storage: multer.memoryStorage(),
  //                              1024 bytes
  //                       1024 * 1KB
  //                  15 * 1MB
  //                  15MB
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// use your API key to
// openAI supports jpg/jpeg, png, webp, and non-animated gif
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Sends an image input to OpenAI and returns the generated description.
 *
 * @param {string} imageUrl - The remote image URL or data URL to analyze.
 * @returns {Promise<string>} The textual description returned by OpenAI.
 */
async function analyzeImage(imageUrl) {
  const response = await openai.responses.create({
    model: "gpt-5.4",
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

/**
 * Aborts an in-flight fetch controller.
 *
 * @param {AbortController} controller - The controller to abort.
 * @returns {void}
 */
function abortFetch(controller) {
  controller.abort();
}

/**
 * Checks whether the server can access a given image URL directly.
 *
 * @param {string} imageUrl - The image URL to test.
 * @returns {Promise<boolean>} `true` when the server can fetch the image URL.
 */
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

/*
  The purpose of this endpoint is to supply OpenAI with the
  image to analyze and then get a textual description of the image,
  and then send the description to the background script.

  upload.single(image) instructs the endpoint to:
  - upload exactly one image found at the form field "image"

  req - request object
  res - result object
*/
/**
 * Handles URL-based image analysis requests.
 *
 * @param {import("express").Request} req - The Express request object.
 * @param {import("express").Response} res - The Express response object.
 * @returns {Promise<void>}
 */
async function handleAnalyzeRequest(req, res) {
  try {
    const imageUrl = req.body?.imageUrl;

    if (!imageUrl) {
      return res.status(400).json({ error: "No image URL provided" });
    }

    if (!(await canUseImageUrl(imageUrl))) {
      return res.status(409).json({
        error: "Server could not access the image URL. Upload the blob instead.",
        needsBlob: true,
      });
    }

    const description = await analyzeImage(imageUrl);
    res.json({ description, source: "url" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Handles blob upload image analysis requests.
 *
 * @param {import("express").Request} req - The Express request object.
 * @param {import("express").Response} res - The Express response object.
 * @returns {Promise<void>}
 */
async function handleAnalyzeBlobRequest(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const mime = req.file.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
    const description = await analyzeImage(dataUrl);

    res.json({ description, source: "blob" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

/**
 * Logs the server startup URL once the listener is active.
 *
 * @returns {void}
 */
function logServerStart() {
  console.log("✅ Server running at http://mapd.cs-smu.ca:3026");
}

app.post("/analyze", handleAnalyzeRequest);
app.post("/analyze/blob", upload.single("image"), handleAnalyzeBlobRequest);

/*
  The purpose of this function is to listen to PORT.
*/
app.listen(PORT, logServerStart);
