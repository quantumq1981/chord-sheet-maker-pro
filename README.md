# chord-sheet-maker-pro

Professional Fake Book style Chord Sheet Maker for musicians.

## OEMER image fallback (v1)

This project now includes a manual image-input OMR fallback path named `oemer-image`.

### What this path does

1. Accept one or more page images (PNG preferred).
2. Send images to a local OEMER helper.
3. Receive MusicXML from helper.
4. Parse MusicXML (measures, harmony, key, time, title/composer).
5. Emit CSMPN fake-book output.

### Supported image formats

- Preferred and expected for v1: **PNG** (`.png`)
- Also accepted: `.jpg`, `.jpeg`

### Recommended image settings

- PNG
- 300 DPI or higher
- One page per image
- Page-order naming (example):
  - `song_page-001.png`
  - `song_page-002.png`
  - `song_page-003.png`

## Local OEMER helper setup

### Python version

- Python **3.10+** recommended

### Install dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install oemer flask
```

### Run helper service

```bash
python scripts/oemer_helper.py
```

Default endpoint used by app: `http://127.0.0.1:8765/oemer/run`

### Optional mock mode (for local acceptance testing)

```bash
OEMER_HELPER_MOCK=1 python scripts/oemer_helper.py
```

In mock mode, helper returns synthetic MusicXML for PNG inputs and can produce a clean structured failure when a filename contains `fail`.

## UI workflow

1. Open app.
2. Click **OEMER Image OMR** in the top bar.
3. Upload one or more page images.
4. Click **Run OEMER OMR**.
5. Review status logs:
   - loading images
   - running OEMER
   - parsing MusicXML
   - generating CSMPN
6. Click **Use This Chart** to import generated CSMPN into chart view.

## Helper API

`POST /oemer/run` multipart form-data

- field: `images` (one or more files)

Success response:

```json
{
  "music_xml": "...",
  "music_xml_path": "/tmp/.../output/file.musicxml",
  "logs": ["..."]
}
```

Failure response (structured):

```json
{
  "code": "oemer-failed",
  "message": "...",
  "logs": ["..."]
}
```
