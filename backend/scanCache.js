import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const CACHE_TTL_MS = 60 * 60 * 1000;

const CACHE_TABLE_NAME = "scan_cache";

function defaultLogger(message, details) {
  if (details === undefined) {
    console.log(message);
    return;
  }

  console.log(message, details);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarizeText(value, maxLength = 160) {
  if (typeof value !== "string") {
    return value;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function resolveDbPath(dbPath) {
  return dbPath instanceof URL ? fileURLToPath(dbPath) : dbPath;
}

function createUnavailableState() {
  return {
    available: false,
    db: null,
    statements: null,
  };
}

export function normalizeImageUrl(imageUrl) {
  const normalizedUrl = new URL(imageUrl);
  normalizedUrl.hash = "";
  return normalizedUrl.toString();
}

export function createUrlCacheKey(imageUrl) {
  return `url:${normalizeImageUrl(imageUrl)}`;
}

export function createBlobCacheKey(buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return `blob:${hash}`;
}

export function createScanCache({
  dbPath = new URL("./scan-cache.sqlite", import.meta.url),
  ttlMs = CACHE_TTL_MS,
  now = () => Date.now(),
  DatabaseImpl = Database,
  logger = defaultLogger,
} = {}) {
  const resolvedDbPath = resolveDbPath(dbPath);
  let state = createUnavailableState();

  function logEvent(requestTag, message, details) {
    const prefix = requestTag ? `${requestTag} ` : "";
    logger(`${prefix}${message}`, details);
  }

  function disableCache(error, { requestTag = null, action, key } = {}) {
    logEvent(requestTag, "cache degraded", {
      action,
      dbPath: resolvedDbPath,
      key: summarizeText(key),
      error: getErrorMessage(error),
    });

    try {
      state.db?.close();
    } catch {
      // Ignore close errors while degrading the cache.
    }

    state = createUnavailableState();
  }

  try {
    const db = new DatabaseImpl(resolvedDbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${CACHE_TABLE_NAME} (
        cache_key TEXT PRIMARY KEY,
        entry_type TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      )
    `);

    state = {
      available: true,
      db,
      statements: {
        getByKey: db.prepare(`
          SELECT cache_key, entry_type, status_code, response_json, created_at_ms, expires_at_ms
          FROM ${CACHE_TABLE_NAME}
          WHERE cache_key = ?
        `),
        upsert: db.prepare(`
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
        `),
        deleteByKey: db.prepare(`
          DELETE FROM ${CACHE_TABLE_NAME}
          WHERE cache_key = ?
        `),
        deleteExpired: db.prepare(`
          DELETE FROM ${CACHE_TABLE_NAME}
          WHERE expires_at_ms <= ?
        `),
      },
    };

    state.statements.deleteExpired.run(now());
  } catch (error) {
    disableCache(error, { action: "startup" });
  }

  function read({ key, requestTag = null } = {}) {
    if (!state.available) {
      return null;
    }

    try {
      const currentTime = now();
      const row = state.statements.getByKey.get(key);

      if (!row) {
        state.statements.deleteExpired.run(currentTime);
        logEvent(requestTag, "cache miss", {
          key: summarizeText(key),
        });
        return null;
      }

      if (row.expires_at_ms <= currentTime) {
        state.statements.deleteByKey.run(key);
        state.statements.deleteExpired.run(currentTime);
        logEvent(requestTag, "cache expired", {
          key: summarizeText(key),
          entryType: row.entry_type,
        });
        return null;
      }

      let payload;

      try {
        payload = JSON.parse(row.response_json);
      } catch (error) {
        state.statements.deleteByKey.run(key);
        logEvent(requestTag, "cache degraded", {
          action: "parse",
          key: summarizeText(key),
          error: getErrorMessage(error),
        });
        return null;
      }

      state.statements.deleteExpired.run(currentTime);

      logEvent(requestTag, "cache hit", {
        key: summarizeText(key),
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
      disableCache(error, {
        requestTag,
        action: "read",
        key,
      });
      return null;
    }
  }

  function write({ key, entryType, statusCode, payload, requestTag = null } = {}) {
    if (!state.available) {
      return false;
    }

    try {
      const createdAtMs = now();
      const expiresAtMs = createdAtMs + ttlMs;

      state.statements.deleteExpired.run(createdAtMs);
      state.statements.upsert.run({
        cacheKey: key,
        entryType,
        statusCode,
        responseJson: JSON.stringify(payload),
        createdAtMs,
        expiresAtMs,
      });

      logEvent(requestTag, "cache store", {
        key: summarizeText(key),
        entryType,
        statusCode,
        expiresAtMs,
      });

      return true;
    } catch (error) {
      disableCache(error, {
        requestTag,
        action: "write",
        key,
      });
      return false;
    }
  }

  function close() {
    try {
      state.db?.close();
    } finally {
      state = createUnavailableState();
    }
  }

  return {
    read,
    write,
    close,
    isAvailable() {
      return state.available;
    },
    getDbPath() {
      return resolvedDbPath;
    },
  };
}
