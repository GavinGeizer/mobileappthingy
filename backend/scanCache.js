import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const CACHE_TTL_MS = 60 * 60 * 1000;

const CACHE_TABLE_NAME = "scan_cache";
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${CACHE_TABLE_NAME} (
    cache_key TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )
`;
const SELECT_BY_KEY_SQL = `
  SELECT
    cache_key,
    entry_type,
    status_code,
    response_json,
    created_at_ms,
    expires_at_ms
  FROM ${CACHE_TABLE_NAME}
  WHERE cache_key = ?
`;
const UPSERT_SQL = `
  INSERT INTO ${CACHE_TABLE_NAME} (
    cache_key,
    entry_type,
    status_code,
    response_json,
    created_at_ms,
    expires_at_ms
  ) VALUES (
    @cacheKey,
    @entryType,
    @statusCode,
    @responseJson,
    @createdAtMs,
    @expiresAtMs
  )
  ON CONFLICT(cache_key) DO UPDATE SET
    entry_type = excluded.entry_type,
    status_code = excluded.status_code,
    response_json = excluded.response_json,
    created_at_ms = excluded.created_at_ms,
    expires_at_ms = excluded.expires_at_ms
`;
const DELETE_BY_KEY_SQL = `
  DELETE FROM ${CACHE_TABLE_NAME}
  WHERE cache_key = ?
`;
const DELETE_EXPIRED_SQL = `
  DELETE FROM ${CACHE_TABLE_NAME}
  WHERE expires_at_ms <= ?
`;

/**
 * SQLite-backed cache for image scan responses.
 *
 * Design notes:
 * - URL scans use a normalized URL key so fragments do not create duplicates.
 * - Blob scans use a SHA-256 digest so identical uploads reuse the same row.
 * - The cache is fail-open: if SQLite fails, the server keeps working without it.
 */
function summarizeForLog(value, maxLength = 160) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function prepareStatements(db) {
  return {
    getByKey: db.prepare(SELECT_BY_KEY_SQL),
    upsert: db.prepare(UPSERT_SQL),
    deleteByKey: db.prepare(DELETE_BY_KEY_SQL),
    deleteExpired: db.prepare(DELETE_EXPIRED_SQL),
  };
}

/**
 * Removes URL fragments so the same image resource maps to one cache key.
 */
export function normalizeImageUrl(imageUrl) {
  const normalizedUrl = new URL(imageUrl);
  normalizedUrl.hash = "";
  return normalizedUrl.toString();
}

/**
 * Prefix keys by source type to keep URL and uploaded-blob entries separate.
 */
export function createUrlCacheKey(imageUrl) {
  return `url:${normalizeImageUrl(imageUrl)}`;
}

export function createBlobCacheKey(buffer) {
  return `blob:${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * Creates a persistent cache API with graceful degradation.
 *
 * Once disabled, reads become cache misses and writes become no-ops instead of
 * throwing. That keeps the request path simple for callers.
 */
export function createScanCache({
  dbPath = new URL("./scan-cache.sqlite", import.meta.url),
  ttlMs = CACHE_TTL_MS,
  now = () => Date.now(),
  DatabaseImpl = Database,
  logger = console.log,
} = {}) {
  const resolvedDbPath = dbPath instanceof URL ? fileURLToPath(dbPath) : dbPath;
  let db = null;
  let statements = null;

  const logEvent = (requestTag, message, details) => {
    const fullMessage = requestTag ? `${requestTag} ${message}` : message;

    if (details === undefined) {
      logger(fullMessage);
      return;
    }

    logger(fullMessage, details);
  };

  const degradeCache = (error, { requestTag = null, action, key } = {}) => {
    logEvent(requestTag, "cache degraded", {
      action,
      dbPath: resolvedDbPath,
      key: summarizeForLog(key),
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      db?.close();
    } catch {
      // A close failure should not leak past the cache boundary.
    }

    db = null;
    statements = null;
  };

  try {
    db = new DatabaseImpl(resolvedDbPath);
    db.exec(CREATE_TABLE_SQL);
    statements = prepareStatements(db);

    // Clean up stale rows opportunistically on startup and during normal traffic.
    statements.deleteExpired.run(now());
  } catch (error) {
    degradeCache(error, { action: "startup" });
  }

  function read({ key, requestTag = null } = {}) {
    if (!statements) {
      return null;
    }

    try {
      const currentTime = now();
      const row = statements.getByKey.get(key);

      if (!row) {
        statements.deleteExpired.run(currentTime);
        logEvent(requestTag, "cache miss", {
          key: summarizeForLog(key),
        });
        return null;
      }

      if (row.expires_at_ms <= currentTime) {
        statements.deleteByKey.run(key);
        statements.deleteExpired.run(currentTime);
        logEvent(requestTag, "cache expired", {
          key: summarizeForLog(key),
          entryType: row.entry_type,
        });
        return null;
      }

      let payload;

      try {
        payload = JSON.parse(row.response_json);
      } catch (error) {
        // Corrupt JSON means the row is unusable, so evict it and treat it as a miss.
        statements.deleteByKey.run(key);
        logEvent(requestTag, "cache degraded", {
          action: "parse",
          key: summarizeForLog(key),
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }

      statements.deleteExpired.run(currentTime);

      logEvent(requestTag, "cache hit", {
        key: summarizeForLog(key),
        entryType: row.entry_type,
        statusCode: row.status_code,
      });

      return {
        key: row.cache_key,
        entryType: row.entry_type,
        statusCode: row.status_code,
        payload,
        createdAtMs: row.created_at_ms,
        expiresAtMs: row.expires_at_ms,
      };
    } catch (error) {
      degradeCache(error, { requestTag, action: "read", key });
      return null;
    }
  }

  function write({ key, entryType, statusCode, payload, requestTag = null } = {}) {
    if (!statements) {
      return false;
    }

    try {
      const createdAtMs = now();
      const expiresAtMs = createdAtMs + ttlMs;

      statements.deleteExpired.run(createdAtMs);
      statements.upsert.run({
        cacheKey: key,
        entryType,
        statusCode,
        responseJson: JSON.stringify(payload),
        createdAtMs,
        expiresAtMs,
      });

      logEvent(requestTag, "cache store", {
        key: summarizeForLog(key),
        entryType,
        statusCode,
        expiresAtMs,
      });

      return true;
    } catch (error) {
      degradeCache(error, { requestTag, action: "write", key });
      return false;
    }
  }

  function close() {
    try {
      db?.close();
    } finally {
      db = null;
      statements = null;
    }
  }

  return {
    read,
    write,
    close,
    isAvailable() {
      return Boolean(statements);
    },
    getDbPath() {
      return resolvedDbPath;
    },
  };
}
