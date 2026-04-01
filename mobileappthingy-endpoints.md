# mobileappthingy backend request reference

This repo exposes **2 backend POST endpoints** for image analysis.

Base URL in the extension:
- `http://mapd.cs-smu.ca:3067`

Default local backend URL from the server code:
- `http://localhost:3067`

---

## 1) `POST /analyze`

### Purpose
Analyze an image by giving the backend a **public HTTP/HTTPS image URL**.

### Required request
- **Method:** `POST`
- **Path:** `/analyze`
- **Content-Type:** `application/json`
- **Body JSON:**

```json
{
  "imageUrl": "https://example.com/image.jpg"
}
```

### Exact rules
- `imageUrl` is **required**.
- `imageUrl` must be a valid **`http://` or `https://`** URL.
- The server first checks whether it can fetch that URL itself.
- If it **can** fetch the image, it analyzes it directly.
- If it **cannot** fetch the image, it returns a blob-fallback response telling the client to upload bytes instead.
- JSON body parsing limit is effectively **1 MB**.

### Successful response
**HTTP 200**

```json
{
  "description": "Short image description here",
  "source": "url"
}
```

### Blob fallback response
**HTTP 409**

```json
{
  "error": "Server could not access the image URL. Upload the blob instead.",
  "needsBlob": true
}
```

### Common error responses
**HTTP 400** when `imageUrl` is missing:

```json
{
  "error": "No image URL provided"
}
```

**HTTP 400** when `imageUrl` is not http/https:

```json
{
  "error": "imageUrl must be an http or https URL"
}
```

**HTTP 503** when `OPENAI_API_KEY` is not configured:

```json
{
  "error": "OPENAI_API_KEY is not set"
}
```

**HTTP 500** for other server failures:

```json
{
  "error": "<server error message>"
}
```

### cURL example
```bash
curl -X POST http://localhost:3067/analyze \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"https://example.com/test.jpg"}'
```

### Good stress-test body template
```json
{
  "imageUrl": "https://picsum.photos/1200/800"
}
```

### Notes for stress testing
- This endpoint is best for testing the **URL path**.
- Use reachable image URLs if you want **200** responses.
- Use blocked/private/invalid/non-image URLs if you want to trigger **409 fallback** or failure behavior.
- Repeating the exact same URL within 1 hour may hit the server cache instead of fully reprocessing.

---

## 2) `POST /analyze/blob`

### Purpose
Analyze an image by **uploading the image bytes directly**.

### Required request
- **Method:** `POST`
- **Path:** `/analyze/blob`
- **Content-Type:** `multipart/form-data`
- **Form field name:** `image`
- **Body:** one uploaded file in the `image` field

### Exact rules
- The uploaded file field **must be named `image`**.
- A file is **required**.
- The uploaded file must have a MIME type starting with **`image/`**.
- Max upload size is **15 MB**.
- The backend reads the file into memory and converts it into a base64 data URL before sending it to OpenAI.

### Successful response
**HTTP 200**

```json
{
  "description": "Short image description here",
  "source": "blob"
}
```

### Common error responses
**HTTP 400** when no file is uploaded:

```json
{
  "error": "No image uploaded"
}
```

**HTTP 400** when uploaded file is not an image:

```json
{
  "error": "Uploaded file must be an image"
}
```

**HTTP 400** when file is too large:

```json
{
  "error": "Uploaded image exceeds the 15 MB limit"
}
```

**HTTP 503** when `OPENAI_API_KEY` is not configured:

```json
{
  "error": "OPENAI_API_KEY is not set"
}
```

**HTTP 500** for other server failures:

```json
{
  "error": "<server error message>"
}
```

### cURL example
```bash
curl -X POST http://localhost:3067/analyze/blob \
  -F "image=@./test-image.png"
```

### Important multipart detail
This is the exact thing your client must send:

```text
form-data field name: image
value: binary file contents
filename: anything reasonable (ex: test-image.png)
```

### Notes for stress testing
- This endpoint is the one to hammer when you want to test **upload throughput**, **memory pressure**, and **OpenAI request volume**.
- Repeating the exact same file bytes within 1 hour may hit the cache.
- To avoid cache skew during stress testing, vary the file content slightly between requests.

---

## Cache behavior that affects stress tests
The backend has a **1-hour SQLite cache**.

Cached for 1 hour:
- successful URL results
- successful blob results
- stable URL-access failures that return the blob fallback (`409` + `needsBlob: true`)

Not cached:
- malformed requests

### Why this matters
If you spam the same URL or same file repeatedly, you may mostly be measuring:
- cache lookup speed
- SQLite behavior
- Express overhead

instead of full analysis cost.

If you want a **real** stress test of end-to-end work, vary:
- the image URL, or
- the uploaded file bytes

---

## Minimal request cheat sheet

### URL endpoint
```http
POST /analyze
Content-Type: application/json

{"imageUrl":"https://example.com/image.jpg"}
```

### Blob endpoint
```http
POST /analyze/blob
Content-Type: multipart/form-data

image=<binary image file>
```

---

## Fast sanity checks

### Valid URL request
```bash
curl -s -X POST http://localhost:3067/analyze \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"https://picsum.photos/800/600"}'
```

### Missing JSON field
```bash
curl -s -X POST http://localhost:3067/analyze \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Blob upload
```bash
curl -s -X POST http://localhost:3067/analyze/blob \
  -F "image=@./test-image.png"
```

### Missing blob field
```bash
curl -s -X POST http://localhost:3067/analyze/blob
```

---

## Blunt summary
There are only **two real backend endpoints** to hit:

1. **`POST /analyze`** with JSON `{ "imageUrl": "..." }`
2. **`POST /analyze/blob`** with multipart form field **`image`**

That is the whole circus. Everything else in the repo is client-side fallback logic, cache plumbing, or server bootstrapping.
