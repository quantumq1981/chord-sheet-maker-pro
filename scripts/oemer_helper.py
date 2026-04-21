#!/usr/bin/env python3
"""Local OEMER bridge service for CSMPN fallback."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import List

from flask import Flask, jsonify, request

app = Flask(__name__)

# ── Security constants ────────────────────────────────────────────────────────
MAX_IMAGES_PER_REQUEST = 20
MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB per image
MAX_REQUESTS_PER_MINUTE = 10

_rate_buckets: dict[str, list[float]] = defaultdict(list)


def _check_rate_limit(ip: str) -> bool:
    now = time.monotonic()
    window = [t for t in _rate_buckets[ip] if now - t < 60]
    _rate_buckets[ip] = window
    if len(window) >= MAX_REQUESTS_PER_MINUTE:
        return False
    _rate_buckets[ip].append(now)
    return True


@app.after_request
def _add_cors(response: 'flask.Response') -> 'flask.Response':
    origin = request.headers.get('Origin', '')
    if any(origin.startswith(p) for p in ('http://127.0.0.1', 'http://localhost', 'file://')):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


def _run_command(cmd: List[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=False, text=True, capture_output=True)


def _mock_musicxml(image_names: List[str]) -> str:
    if any('fail' in name.lower() for name in image_names):
        raise RuntimeError('mock requested failure for provided filename')
    if len(image_names) == 1:
        return '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Mock Single Page</work-title></work>
  <identification><creator type="composer">Mock Composer</creator></identification>
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes><harmony><root><root-step>C</root-step></root><kind>major-seventh</kind></harmony></measure>
    <measure number="2"><harmony><root><root-step>F</root-step></root><kind>minor-seventh</kind></harmony><harmony><root><root-step>G</root-step></root><kind>dominant</kind></harmony></measure>
    <measure number="3"></measure>
  </part>
</score-partwise>'''
    return '''<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Mock Multi Page</work-title></work>
  <part-list><score-part id="P1"><part-name>Music</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><key><fifths>-1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes><harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>major</kind></harmony></measure>
    <measure number="2"><harmony><root><root-step>E</root-step><root-alter>-1</root-alter></root><kind>major-seventh</kind></harmony></measure>
    <measure number="3"></measure>
    <measure number="4"></measure>
  </part>
</score-partwise>'''


@app.post('/oemer/run')
def oemer_run():
    if not _check_rate_limit(request.remote_addr or ''):
        return jsonify({'code': 'rate-limited', 'message': 'Rate limit exceeded. Try again in a minute.', 'logs': []}), 429

    uploads = request.files.getlist('images')
    if not uploads:
        return jsonify({'code': 'no-images', 'message': 'No images uploaded.', 'logs': []}), 400
    if len(uploads) > MAX_IMAGES_PER_REQUEST:
        return jsonify({'code': 'too-many-images', 'message': f'Maximum {MAX_IMAGES_PER_REQUEST} images per request.', 'logs': []}), 400

    logs: List[str] = []
    with tempfile.TemporaryDirectory(prefix='oemer-bridge-') as tmpdir:
        temp = Path(tmpdir)
        input_dir = temp / 'input'
        output_dir = temp / 'output'
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        image_paths: List[Path] = []
        for upload in sorted(uploads, key=lambda f: f.filename or ''):
            filename = upload.filename or 'page.png'
            ext = Path(filename).suffix.lower()
            if ext not in ('.png', '.jpg', '.jpeg'):
                return jsonify({'code': 'unsupported-format', 'message': f'Unsupported image format: {filename}.', 'logs': logs}), 400
            upload.seek(0, 2)
            size = upload.tell()
            upload.seek(0)
            if size > MAX_IMAGE_SIZE_BYTES:
                mb = MAX_IMAGE_SIZE_BYTES // (1024 * 1024)
                return jsonify({'code': 'file-too-large', 'message': f'Image {filename} exceeds the {mb} MB limit.', 'logs': logs}), 400
            target = input_dir / Path(filename).name  # strip any path component
            upload.save(target)
            image_paths.append(target)

        logs.append(f'accepted {len(image_paths)} image(s)')

        if os.environ.get('OEMER_HELPER_MOCK') == '1':
            try:
                music_xml = _mock_musicxml([path.name for path in image_paths])
            except RuntimeError as exc:
                return jsonify({'code': 'oemer-failed', 'message': str(exc), 'logs': logs}), 500
            xml_path = output_dir / 'mock.musicxml'
            xml_path.write_text(music_xml, encoding='utf-8')
            logs.append('mock mode enabled')
            return jsonify({'music_xml': music_xml, 'music_xml_path': str(xml_path), 'logs': logs})

        if shutil.which('oemer') is None:
            return jsonify({'code': 'oemer-not-installed', 'message': 'OEMER CLI not found in PATH. Install with `pip install oemer`.', 'logs': logs}), 500

        cmd = ['oemer', '-o', str(output_dir), *[str(path) for path in image_paths]]
        logs.append('running: ' + ' '.join(cmd))
        completed = _run_command(cmd)
        if completed.stdout:
            logs.extend([f'stdout: {line}' for line in completed.stdout.splitlines() if line.strip()])
        if completed.stderr:
            logs.extend([f'stderr: {line}' for line in completed.stderr.splitlines() if line.strip()])
        if completed.returncode != 0:
            return jsonify({'code': 'oemer-failed', 'message': f'OEMER exited with status {completed.returncode}.', 'logs': logs}), 500

        xml_candidates = sorted(output_dir.glob('*.xml')) + sorted(output_dir.glob('*.musicxml'))
        if not xml_candidates:
            return jsonify({'code': 'musicxml-missing', 'message': 'OEMER completed but no MusicXML file was produced.', 'logs': logs}), 500

        xml_path = xml_candidates[0]
        music_xml = xml_path.read_text(encoding='utf-8', errors='replace')
        return jsonify({'music_xml': music_xml, 'music_xml_path': str(xml_path), 'logs': logs})


if __name__ == '__main__':
    host = os.environ.get('OEMER_HELPER_HOST', '127.0.0.1')
    port = int(os.environ.get('OEMER_HELPER_PORT', '8765'))
    app.run(host=host, port=port)
