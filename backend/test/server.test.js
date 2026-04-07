import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createApp } from "../app.js";
import { createScanCache } from "../scanCache.js";

// Small Test file to make sure we dont go insane, const are required to be in functions.
// Author: @gavingeizer

async function createTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function startTestServer(app) {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    response,
    data: await response.json(),
  };
}

async function postBlob(baseUrl, bytes, { fileName = "upload.png", type = "image/png" } = {}) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type }), fileName);

  const response = await fetch(`${baseUrl}/analyze/blob`, {
    method: "POST",
    body: form,
  });

  return {
    response,
    data: await response.json(),
  };
}

async function setupCachedApp(t, overrides = {}) {
  const tempDir = await createTempDir("server-cache-");
  const cache = overrides.cache ?? createScanCache({
    dbPath: path.join(tempDir, "cache.sqlite"),
    logger: () => {},
  });
  const app = createApp({
    analyzeImage: overrides.analyzeImage ?? (async () => "A described image"),
    canUseImageUrl: overrides.canUseImageUrl ?? (async () => true),
    cache,
  });
  const server = await startTestServer(app);

  t.after(async () => {
    await server.close();
    cache.close?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  return {
    baseUrl: server.baseUrl,
    cache,
    tempDir,
  };
}

test("URL requests are served from cache after the first successful lookup", async (t) => {
  let analyzeCalls = 0;
  let probeCalls = 0;
  const { baseUrl } = await setupCachedApp(t, {
    analyzeImage: async () => {
      analyzeCalls += 1;
      return "A cached description";
    },
    canUseImageUrl: async () => {
      probeCalls += 1;
      return true;
    },
  });

  const first = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/image.png",
  });
  const second = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/image.png",
  });

  assert.equal(first.response.status, 200);
  assert.deepEqual(first.data, {
    description: "A cached description",
    source: "url",
  });
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.data, first.data);
  assert.equal(analyzeCalls, 1);
  assert.equal(probeCalls, 1);
});

test("cached needsBlob failures return without probing or analyzing again", async (t) => {
  let analyzeCalls = 0;
  let probeCalls = 0;
  const { baseUrl } = await setupCachedApp(t, {
    analyzeImage: async () => {
      analyzeCalls += 1;
      return "should not be used";
    },
    canUseImageUrl: async () => {
      probeCalls += 1;
      return false;
    },
  });

  const first = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/protected.png",
  });
  const second = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/protected.png",
  });

  assert.equal(first.response.status, 409);
  assert.deepEqual(first.data, {
    error: "Server could not access the image URL. Upload the blob instead.",
    needsBlob: true,
  });
  assert.equal(second.response.status, 409);
  assert.deepEqual(second.data, first.data);
  assert.equal(analyzeCalls, 0);
  assert.equal(probeCalls, 1);
});

test("repeated blob uploads with identical bytes are served from cache", async (t) => {
  let analyzeCalls = 0;
  const { baseUrl } = await setupCachedApp(t, {
    analyzeImage: async () => {
      analyzeCalls += 1;
      return "Blob description";
    },
  });

  const bytes = Buffer.from("same-uploaded-bytes");
  const first = await postBlob(baseUrl, bytes);
  const second = await postBlob(baseUrl, bytes);

  assert.equal(first.response.status, 200);
  assert.deepEqual(first.data, {
    description: "Blob description",
    source: "blob",
  });
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.data, first.data);
  assert.equal(analyzeCalls, 1);
});

test("cache read and write failures fall back to the live path", async (t) => {
  let analyzeCalls = 0;
  let probeCalls = 0;
  const { baseUrl } = await setupCachedApp(t, {
    cache: {
      read() {
        throw new Error("read failure");
      },
      write() {
        throw new Error("write failure");
      },
    },
    analyzeImage: async () => {
      analyzeCalls += 1;
      return "Live fallback description";
    },
    canUseImageUrl: async () => {
      probeCalls += 1;
      return true;
    },
  });

  const first = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/live.png",
  });
  const second = await postJson(baseUrl, "/analyze", {
    imageUrl: "https://example.com/live.png",
  });

  assert.equal(first.response.status, 200);
  assert.deepEqual(first.data, {
    description: "Live fallback description",
    source: "url",
  });
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.data, first.data);
  assert.equal(analyzeCalls, 2);
  assert.equal(probeCalls, 2);
});

test("malformed requests return validation errors and are not cached", async (t) => {
  const tempDir = await createTempDir("server-malformed-");
  const dbPath = path.join(tempDir, "cache.sqlite");
  const cache = createScanCache({
    dbPath,
    logger: () => {},
  });
  const app = createApp({
    analyzeImage: async () => "should not run",
    canUseImageUrl: async () => true,
    cache,
  });
  const server = await startTestServer(app);

  t.after(async () => {
    await server.close();
    cache.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const result = await postJson(server.baseUrl, "/analyze", {});

  assert.equal(result.response.status, 400);
  assert.deepEqual(result.data, {
    error: "No image URL provided",
  });

  const db = new Database(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS count FROM scan_cache").get();
  db.close();

  assert.equal(row.count, 0);
});
