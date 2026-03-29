import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  CACHE_TTL_MS,
  createBlobCacheKey,
  createScanCache,
  createUrlCacheKey,
} from "../scanCache.js";

async function createTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function cleanupCache(cache, tempDir) {
  cache.close();
  await rm(tempDir, { recursive: true, force: true });
}

test("stores and retrieves a successful URL result", async (t) => {
  const tempDir = await createTempDir("scan-cache-url-");
  const currentTime = 0;
  const cache = createScanCache({
    dbPath: path.join(tempDir, "cache.sqlite"),
    logger: () => {},
    now: () => currentTime,
  });

  t.after(() => cleanupCache(cache, tempDir));

  const key = createUrlCacheKey("https://example.com/image.png");
  const payload = { description: "A mountain scene", source: "url" };

  assert.equal(cache.write({
    key,
    entryType: "url",
    statusCode: 200,
    payload,
  }), true);

  assert.deepEqual(cache.read({ key }), {
    key,
    entryType: "url",
    statusCode: 200,
    payload,
    createdAtMs: 0,
    expiresAtMs: CACHE_TTL_MS,
  });
});

test("stores and retrieves a successful blob result", async (t) => {
  const tempDir = await createTempDir("scan-cache-blob-");
  const cache = createScanCache({
    dbPath: path.join(tempDir, "cache.sqlite"),
    logger: () => {},
  });

  t.after(() => cleanupCache(cache, tempDir));

  const key = createBlobCacheKey(Buffer.from("same-image-bytes"));
  const payload = { description: "A user upload", source: "blob" };

  assert.equal(cache.write({
    key,
    entryType: "blob",
    statusCode: 200,
    payload,
  }), true);

  const cached = cache.read({ key });

  assert.equal(cached?.entryType, "blob");
  assert.equal(cached?.statusCode, 200);
  assert.deepEqual(cached?.payload, payload);
});

test("keeps URL and blob keys separate", async (t) => {
  const tempDir = await createTempDir("scan-cache-separate-");
  const cache = createScanCache({
    dbPath: path.join(tempDir, "cache.sqlite"),
    logger: () => {},
  });

  t.after(() => cleanupCache(cache, tempDir));

  const urlKey = createUrlCacheKey("https://example.com/image.png");
  const blobKey = createBlobCacheKey(Buffer.from("https://example.com/image.png"));

  assert.notEqual(urlKey, blobKey);

  cache.write({
    key: urlKey,
    entryType: "url",
    statusCode: 200,
    payload: { description: "Remote image", source: "url" },
  });
  cache.write({
    key: blobKey,
    entryType: "blob",
    statusCode: 200,
    payload: { description: "Uploaded image", source: "blob" },
  });

  assert.deepEqual(cache.read({ key: urlKey })?.payload, {
    description: "Remote image",
    source: "url",
  });
  assert.deepEqual(cache.read({ key: blobKey })?.payload, {
    description: "Uploaded image",
    source: "blob",
  });
});

test("treats expired rows as misses and removes them", async (t) => {
  let currentTime = 1_000;
  const tempDir = await createTempDir("scan-cache-expiry-");
  const dbPath = path.join(tempDir, "cache.sqlite");
  const cache = createScanCache({
    dbPath,
    logger: () => {},
    now: () => currentTime,
  });

  t.after(() => cleanupCache(cache, tempDir));

  const key = createUrlCacheKey("https://example.com/expiring.png");

  cache.write({
    key,
    entryType: "url",
    statusCode: 200,
    payload: { description: "Short lived", source: "url" },
  });

  currentTime += CACHE_TTL_MS + 1;

  assert.equal(cache.read({ key }), null);

  const db = new Database(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS count FROM scan_cache WHERE cache_key = ?").get(key);
  db.close();

  assert.equal(row.count, 0);
});

test("swallows database startup failures and behaves like a cache miss", () => {
  class BrokenDatabase {
    constructor() {
      throw new Error("database unavailable");
    }
  }

  const cache = createScanCache({
    DatabaseImpl: BrokenDatabase,
    logger: () => {},
  });

  assert.equal(cache.isAvailable(), false);
  assert.equal(cache.read({ key: "url:https://example.com/image.png" }), null);
  assert.equal(cache.write({
    key: "url:https://example.com/image.png",
    entryType: "url",
    statusCode: 200,
    payload: { description: "unused" },
  }), false);
});
