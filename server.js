/*
  The purpose of this file is to provide a server solution for Phase 2.\
  
  comments for functions in this file are in JSDoc format, which is a common way to document JavaScript code.
  you can find out all the translations here: https://jsdoc.app/tags-param.html - Gavin

  author: Terry, Gavin, Ajay, Matt

*/

import express from "express";
import multer from "multer";
import cors from "cors";
import OpenAI from "openai";

const PORT = 3067; //TODO: maybe we should move this to the .env file as well, its not sensitive but helps with  deployments and scailing - Gavin
const app = express();

// keep uploads in memory and set a file size limit of 15MB, 15MB is an arbitrary limit that should be large enough for most images while preventing abuse of the blob upload endpoint.
const upload = multer({
  storage: multer.memoryStorage(),
  //                              1024 bytes
  //                       1024 * 1KB
  //                  15 * 1MB
  //                  15MB
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(cors());
// we limit max json size to prevent abuse.
app.use(express.json({ limit: "1mb" }));

// use your API key to
// openAI supports jpg/jpeg, png, webp, and non-animated gif

// if your getting errors around the .env access, you need to inject the enviroment file into node. run the additional arguement "--env-file=.env" when you start the server.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Sends an image input to OpenAI and returns the generated description.
 *
 * @param {string} imageUrl - The remote image URL or data URL to analyze.
 * @returns {Promise<string>} The textual description returned by OpenAI.
 */
async function analyzeImage(imageUrl) { // maybe we make the ai think? might burn more tokens but be able to identify people better.
  const response = await openai.responses.create({
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

/**
 * Aborts an in-flight fetch controller.
 * more descriptive function name, just wraping the .abort method.
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
  //we use the abort controller to protect against slow servers or large files that could tie up our server resources. 5 seconds is an arbitrary timeout.
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
    // basic verification that its us, if they use a different mime type we know its not us.
    const mime = req.file.mimetype || "image/jpeg";
    //inline conversion of the data to a data URL.
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
  console.log("[LOG]: Server running at http://mapd.cs-smu.ca:3067");
}

app.post("/analyze", handleAnalyzeRequest);
app.post("/analyze/blob", upload.single("image"), handleAnalyzeBlobRequest);

/*
  The purpose of this function is to listen to PORT.
*/
app.listen(PORT, logServerStart);
