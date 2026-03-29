# Server 3

Server 3 is a small Chrome extension + Node backend project for image narration.

When a user long-presses an image on a page, the extension sends it to the backend, the backend asks OpenAI for a short visual description, and the extension reads that description aloud. The backend also keeps a 1-hour SQLite cache so repeated scans can return quickly without making the same request again.

## What It Does

- Long-press an image to trigger analysis
- Try the original image URL first, then fall back to blob upload or screenshot capture
- Read the result out loud in the page
- Cache successful results and stable URL access failures for 1 hour

## Project Layout

```text
backend/    Express server, OpenAI integration, SQLite cache, tests
extension/  Chrome extension files (background script, content script, manifest)
```

## Backend Setup

From the `backend` directory:

```bash
npm install
```

Create `backend/.env` and set:

```env
OPENAI_API_KEY=your_key_here
```

Start the server:

```bash
npm start
```

By default the backend listens on `http://localhost:3067`.

## Extension Setup

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click `Load unpacked`
4. Select the `extension` folder

If you want the extension to talk to a local backend, update `SERVER_URL` in [extension/background.js](/c:/Users/Criti/Downloads/Server%203/Server%203/extension/background.js) to `http://localhost:3067`.

## Testing

From the `backend` directory:

```bash
npm test
```

## Notes

- The cache database is created automatically in `backend/scan-cache.sqlite`
- Cached entries expire after 1 hour
- If the database has a problem, the server falls back to the normal live request flow
