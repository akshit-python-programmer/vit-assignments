# Assignment PDF Editor

A static web app for finishing assignments fast:

1. **Open** any assignment PDF (or start with a blank page).
2. **Drag images** from the tray onto any page. You can move them, resize them from the corners, or drag them onto another page. **Ctrl+V** pastes a screenshot straight onto the page you're looking at.
3. **Add text** anywhere: double-click a page, or use **Add text**. You can change font, size, bold and colour.
4. **Download.** The PDF is compressed to land *just under* the size limit (default 4 MB, the VTOP upload limit), keeping as much image quality as the limit allows.

Everything runs in the browser. Files are never uploaded anywhere.

## How the size targeting works

- The limit is read as decimal MB (4 MB = 4,000,000 bytes), and the hard cap includes a 1.25% safety margin (3.95 MB for a 4 MB limit). That keeps the file under the limit whether a site counts 1 MB as 1,000,000 or 1,048,576 bytes.
- **Normal mode:** the original pages are kept as they are (sharp, selectable text). Only the images you added are re-encoded. A search over resolution (DPI) and JPEG quality picks the highest quality that still fits, aiming for 95–100% of the cap. If everything already fits at full quality, nothing is compressed.
- **Fallback:** if the original PDF is already too big on its own (for example a scanned PDF), every page is flattened to an image and the same search runs on the page images. Typed text stays as real text.
- Transparent PNGs (such as signatures) stay PNG so their transparency is kept. Text with symbols the built-in PDF fonts can't encode (₹, θ, ≤, Hindi, emoji…) is embedded as a crisp 300 DPI image.

## Hosting

It's plain static files with no build step, so it can be served from GitHub Pages
(Settings → Pages → Deploy from branch → `main` / root).

Bundled libraries: [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) and [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT). Their licenses are in `vendor/`.
