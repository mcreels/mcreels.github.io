# Wedding Reels (static)

A tiny, static “Instagram Reels”-style viewer for wedding videos hosted on Google Drive.

## Add / edit videos (development)

Create a local `data.json` (it’s git-ignored) and add items to the `videos` array.

Start with:

```bash
cp data.example.json data.json
```

Then edit `data.json`:

```json
{
  "videos": [
    { "id": "GOOGLE_DRIVE_FILE_ID", "title": "Mike & Cindy Dance", "description": "First dance" }
  ]
}
```

### Getting the Google Drive `id`

Open the file in Google Drive and copy the file ID from the URL:

- `https://drive.google.com/file/d/<ID>/view`

Make sure the files are shared so they can be previewed (e.g. “Anyone with the link”).

## Production data (`data.bin`)

In production, the app loads `data.bin` and prompts for a password to decrypt it in the browser.

Generate `data.bin` from your local `data.json`:

```bash
node scripts/encrypt-data.mjs --in data.json --out data.bin
```

Non-interactive:

```bash
DATA_PASSWORD="your password" node scripts/encrypt-data.mjs --in data.json --out data.bin
```

Commit `data.bin`. Do not commit `data.json`.

## Run locally

Browsers won’t `fetch()` `data.json` from a `file://` URL, so serve it:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Controls

- Scroll / trackpad / swipe: previous/next reel
- Keyboard: `↑`/`↓`, `PageUp`/`PageDown`, `j`/`k`, `Space`
- “Up next” pill: tap to advance
- Top-right buttons:
  - Eye: hide/show captions (cinema mode)
  - Shuffle: reshuffle the playlist

## Sharing

Each reel updates the URL hash as `#v=<VIDEO_ID>`. Sharing that link opens directly to that video.

## Testing `data.bin` locally

If you have both `data.json` and `data.bin` locally, the app auto-prefers `data.json`. Force `data.bin` with:

- `http://localhost:8000/?source=bin`
