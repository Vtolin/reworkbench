# Browser capture extension (Phase 4 P1)

Minimal "Save to Local Workbench" extension — one action, no sync, no cloud.

## Install (Chrome/Edge/Brave)

1. Start the backend first: `.\run.ps1` (or `python -m uvicorn server:app` on `127.0.0.1:8000`).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Enable **Developer mode** → **Load unpacked** → select this `browser-extension/` folder.

## Use

- Open an academic page (Google Scholar result, DOI page, journal article, arXiv, PubMed, institutional repository).
- Click the extension icon → the DOI is pre-filled if one is on the page (edit if needed).
- Click **Save to Local Workbench**:
  - `POST /api/capture` resolves metadata via the provider chain (OpenAlex by default; local extraction fallback),
  - downloads the PDF when the URL points directly at one,
  - otherwise creates a metadata-only library record (verify it later).
- The record appears in the Library UI instantly.

## Notes

- API URL defaults to `http://127.0.0.1:8000` (CORS is already open on the backend).
- Strict offline mode in Settings disables the external metadata lookup (local extraction still works).
- Keep the extension minimal on purpose — richer capture (page scraping, multi-tab saving) can come later.
