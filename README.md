Gavin, AJay, Matt
# Server 3

A small Chrome extension + Node backend that turns images into short spoken descriptions.

When a user long-presses an image on a page, the extension sends that image to the backend. The backend asks OpenAI for a short visual description, returns the result, and the extension reads it aloud.

The backend also keeps a 1-hour SQLite cache so repeated scans of the same image can return quickly without making the same API call again.

## manifest.json analysis

{
  "manifest_version": 3,
  "name": "Server 3",
  "version": "1.0",
  "description": "Demo for project.",
  "permissions": ["activeTab"], <-- we need active tab to capture screenshots when blob uploads fail, and to inject the content script that detects long-presses on images.
  "host_permissions": ["<all_urls>"], <-- we need host permissions to allow the extension to fetch images from any URL for analysis, and to send requests to our backend server regardless of its address.>
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ]
}


## How It Works

1. The content script detects a long-press on an image.
2. The extension background worker tries the original image URL first.
3. If the backend cannot reach that URL, the extension falls back to:
   - uploading the image bytes directly, or
   - capturing the visible tab and cropping the image region
4. The backend sends the image to OpenAI for a short description.
5. The content script reads the result aloud with the browser speech API.

## Project Structure

```text
backend/
  app.js                Express app and OpenAI request flow
  server.js             Startup entry point
  scanCache.js          SQLite-backed cache helpers
  test/
    scanCache.test.js   Cache unit tests
    server.test.js      Backend route/integration tests

extension/
  background.js         Backend communication and fallback flow
  content.js            Long-press detection and speech output
  manifest.json         Chrome extension manifest
```

## Features

- Long-press an image to trigger analysis
- Try the original image URL before sending larger uploads
- Fall back to blob upload when the backend cannot access the URL directly
- Fall back again to screenshot capture when needed
- Read descriptions aloud in-page
- Cache successful results and stable URL-access failures for 1 hour
- Fail open if the cache database is unavailable

## Requirements

- Node.js 20+
- A valid `OPENAI_API_KEY`
- Chrome or another Chromium-based browser that supports Manifest V3 extensions

## Backend Setup

From the `backend` directory:

```bash
npm install
```

Create `backend/.env`:

```env
OPENAI_API_KEY=your_key_here
```

Start the backend:

```bash
npm start
```

By default the backend listens on:

```text
http://localhost:3067
```

## Extension Setup

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension` folder

If you want the extension to talk to a different backend, update `SERVER_URL` in `extension/background.js`.

## Testing

Run the backend test suite from `backend/`:

```bash
npm test
```

Current backend test coverage includes:

- cache reads/writes
- cache expiry behavior
- separation between URL and blob cache keys
- degraded-cache fallback behavior
- repeated-request caching for both URL and blob analysis
- malformed request handling

## Caching Behavior

The cache is stored in:

```text
backend/scan-cache.sqlite
```

Cache rules:

- successful URL results are cached for 1 hour
- successful blob results are cached for 1 hour
- stable URL access failures that require blob upload are also cached for 1 hour
- malformed requests are **not** cached
- if SQLite fails, the server continues running without cache support

## Notes

- The extension and backend are intentionally separated so the browser can handle capture/fallback logic while the server owns OpenAI requests.
- The current backend dependency tree reports one transitive `path-to-regexp` vulnerability through Express tooling. That issue is dependency-level rather than project-specific logic.
