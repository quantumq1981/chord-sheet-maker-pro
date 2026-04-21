Prompt: Universal Chord Chart Import Pipeline for index.html

Context:
The Chord Sheet Maker Pro app currently supports two primary import paths: the canonical src/ingest/ugProPdfImporter.ts for Ultimate Guitar Pro PDFs and the standalone ug-pro-importer.html page. The Slash Notation panel (index.html) is the primary rendering surface for rhythm charts, but its import capabilities are currently limited to manual CSMPN text entry.

Musicians work with diverse file formats: Guitar Pro files (.gp, .gp3, .gp4, .gp5, .gp7, .gpx), ASCII tablature (.txt, .tab), ABC notation (.abc), and plain-text chord charts over lyrics. The app needs a unified import pipeline that extracts chord symbols and structural metadata from any of these formats and renders them as editable CSMPN in the slash notation panel.

Objective:
Implement a modular, extensible import pipeline in index.html that:

1. Accepts file uploads via <input type="file"> for all supported formats.
2. Routes each format to the appropriate parser/extractor.
3. For PDFs: Uses PDF.js to extract text items with X/Y coordinates, reconstruct chord-over-lyrics alignment, and output CSMPN.
4. For Guitar Pro formats: Extracts chord symbols, section markers, tempo, and key signature.
5. For ASCII tab/ABC: Parses notation and converts to chord chart representation.
6. Outputs a unified CSMPN string that populates the source editor and triggers updatePreview().

Technical Specifications

1. File Upload & Format Detection

Add a new import control to the slash notation panel:

```html
<input type="file" id="importFileInput" accept=".pdf,.gp,.gp3,.gp4,.gp5,.gp7,.gpx,.txt,.tab,.abc,text/plain,application/pdf" />
<button id="importFileBtn">📂 Import Chart</button>
```

Format detection logic:

```javascript
function detectFormat(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const mime = file.type;
  
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['gp', 'gp3', 'gp4', 'gp5', 'gp7', 'gpx'].includes(ext)) return 'guitarpro';
  if (['txt', 'tab'].includes(ext) || mime === 'text/plain') return 'ascii';
  if (ext === 'abc') return 'abc';
  
  // Fallback: inspect file header
  return null;
}
```

2. PDF Import Pipeline (Ultimate Guitar Pro / Chord Charts)

Follow the recommended workflow: PDF.js → coordinate extraction → chord identification → CSMPN reconstruction.

2.1 PDF.js Integration

· Load PDF.js via CDN (already lazy-loaded in the app; add to preconnect list).
· Use pdfjsLib.getDocument({ data: arrayBuffer }) to parse the uploaded file .
· For each page, call page.getTextContent() to retrieve text items with transform coordinates.

2.2 Coordinate-Based Text Extraction
Each text item from PDF.js includes:

```javascript
{
  str: "G",
  transform: [a, b, c, d, e, f],  // e = x, f = y in PDF points
  width: 12.5,
  height: 10,
  fontName: "Helvetica"
}
```

· Convert PDF coordinate system (origin at bottom-left) to top-down coordinates: y = pageHeight - f.
· Group text items by Y-coordinate proximity (within 5-10 points) to identify lines.
· Within each line, sort by X-coordinate to reconstruct reading order.

2.3 Chord Identification with Tonal.js

· Maintain a dictionary of valid chord roots (A-G, including flats/sharps) and qualities (m, maj7, dim, 7, sus4, etc.).
· For each text item, test against chord pattern regex:
  ```javascript
  const chordPattern = /^[A-G](b|#)?(m|maj|min|dim|aug|sus|add|7|9|11|13)?.*(?:\/[A-G](b|#)?)?$/;
  ```
· Use Tonal.js Tonal.Chord.get() to validate and normalize chord names.
· Flag items that match the pattern as type: 'chord'; others as type: 'lyric'.

2.4 Chord-over-Lyrics Reconstruction

· Align chords with lyrics using X-coordinate interpolation:
  · For each chord, find the lyric word with the nearest X position.
  · Insert chord token [G] inline before the corresponding word.
· Handle multiple chords per line (e.g., [G] [C] [D] above "Sweet home Alabama").
· Detect section headers (Intro, Verse, Chorus) via:
  · Text styling (bold, larger font, all-caps) if available in fontName.
  · Keyword matching against known section labels.
· Output format: CSMPN with bar lines inferred from chord density/spacing.

2.5 Edge Cases

· Multi-column layouts: Detect via X-coordinate clustering; process columns separately.
· Chord diagrams: Skip items with height > 30 (likely fretboard grids).
· Title/composer extraction: First few lines with large font size → t: and c: headers.

3. Guitar Pro Format Import (.gp, .gp3, .gp4, .gp5, .gp7, .gpx)

Guitar Pro files are the industry standard for guitar tablature and contain rich metadata: chord diagrams, section markers, tempo, and lyrics .

3.1 Parser Selection

· Use alphaTab library (already used in app.html for OSMD rendering) via its importer API .
· alphaTab supports all Guitar Pro formats and provides a unified model.Score object.

3.2 Extraction Logic

```javascript
async function importGuitarPro(file) {
  const buffer = await file.arrayBuffer();
  const score = new alphaTab.importer.ScoreLoader().loadScoreFromBytes(buffer);
  
  const csmpn = [];
  
  // Extract metadata
  csmpn.push(`t: ${score.title || file.name.replace(/\.gp\d?$/, '')}`);
  if (score.artist) csmpn.push(`c: ${score.artist}`);
  if (score.tempo) csmpn.push(`q: ${score.tempo}`);
  
  // Extract master bars (rehearsal marks = section headers)
  for (const masterBar of score.masterBars) {
    if (masterBar.section) {
      csmpn.push(`= ${masterBar.section.text}`);
    }
    
    // Extract chords from the first track (typically rhythm guitar)
    const track = score.tracks[0];
    for (const voice of masterBar.voices) {
      for (const beat of voice.beats) {
        if (beat.chord) {
          csmpn.push(beat.chord.name);
        }
        // Handle rests for rhythm spacing
      }
    }
    csmpn.push('|');
  }
  
  return csmpn.join(' ');
}
```

3.3 Settings Configuration
Configure alphaTab importer settings :

```javascript
alphaTab.importer.ImporterSettings = {
  beatTextAsLyrics: true,  // Parse beat text as lyrics (common in GP3-5)
  encoding: 'utf-8'
};
```

4. ASCII Tab / Plain Text Import

ASCII tablature is a simple text format using hyphens for strings and numbers for frets .

4.1 Detection & Extraction

· Detect tablature lines: regex /^-{3,}/ across multiple lines.
· For chord charts (no hyphens): treat each line as [Chord] lyrics or pure chord sequence.
· Parse chord lines using the same Tonal.js validator.

4.2 Conversion to CSMPN

· Tablature → Chord symbols: Use fretboard-to-chord lookup table (e.g., [0,2,2,1,0,0] → E).
· Chord-over-lyrics format: [G]Sweet [C]home [D]Alabama → CSMPN with bars inferred from line breaks.

5. ABC Notation Import

ABC is a text-based music notation format widely used for folk/traditional music .

5.1 Parsing with abcjs

· Use abcjs (already lazy-loaded in the app) to parse ABC string into tune object.
· Extract chord symbols from %%chords directive or inline "G" annotations.
· Convert ABC header fields (X:, T:, M:, K:, Q:) to CSMPN headers.

5.2 Chord Extraction

```javascript
function abcToCsmpn(abcString) {
  const tune = ABCJS.parseOnly(abcString)[0];
  const csmpn = [];
  
  csmpn.push(`t: ${tune.metaText.title}`);
  csmpn.push(`k: ${tune.metaText.key}`);
  if (tune.metaText.tempo) csmpn.push(`q: ${tune.metaText.tempo}`);
  
  // Extract chords from melody line
  for (const line of tune.lines) {
    for (const bar of line.bars) {
      // ... extract chord symbols
    }
  }
  
  return csmpn.join('\n');
}
```

6. Unified Output & Error Handling

All importers should:

1. Return a Promise that resolves to a CSMPN string.
2. Populate sourceEl.value with the result.
3. Call updatePreview() to trigger slash notation rendering.
4. Display import feedback in the existing export-feedback UI.

Error handling:

```javascript
try {
  const csmpn = await importerForFormat(file);
  sourceEl.value = csmpn;
  updatePreview();
  showFeedback(`Imported ${file.name} successfully`, 'success');
} catch (error) {
  showFeedback(`Import failed: ${error.message}`, 'error');
  console.error('Import error:', error);
}
```

7. Integration with Existing Architecture

· Lazy-load heavy libraries: PDF.js, alphaTab, and abcjs are already in the app's lazy-load manifest; importers should use dynamic import() or check global availability.
· Reuse existing parsers: The imported CSMPN will flow through parseCSMPN() and the slash notation renderer unchanged.
· Follow escape patterns: All user-provided text must pass through escapeHtml() before insertion into sourceEl.
· Add to OPP_ROADMAP.md: Track this feature under Sprint 6 (Import Unification).

8. Testing Requirements

Add fixture tests in tests/importers/:

· ug-pro-pdf.test.ts: Sample Ultimate Guitar PDF with expected CSMPN output.
· guitar-pro.test.ts: Sample .gp5 file with section markers and chords.
· ascii-tab.test.ts: ASCII tablature conversion to chord symbols.
· abc-import.test.ts: ABC tune conversion.

9. Deliverables

1. src/import/formatDetector.ts – File type detection.
2. src/import/pdfChordExtractor.ts – PDF.js coordinate parsing + Tonal.js validation.
3. src/import/guitarProImporter.ts – alphaTab-based GP importer.
4. src/import/asciiTabImporter.ts – ASCII/plain text importer.
5. src/import/abcImporter.ts – abcjs-based ABC importer.
6. src/import/importPipeline.ts – Unified orchestrator.
7. Integration into index.html with file input UI.
8. Unit tests for all importers.

Constraints

· Maintain zero runtime dependencies beyond libraries already approved (PDF.js, alphaTab, abcjs, Tonal.js).
· Follow OPP principles: clean architecture, tests before features, canonical single-track development (all work goes in index.html and src/import/).
· Respect lazy-loading strategy: PDF.js and abcjs already cost ~300KB+ on initial parse; importers must not load until file selection.

References

· PDF.js coordinate extraction: getTextContent() returns transform array with (e,f) as translation .
· Guitar Pro import/export formats: GP supports MIDI, MusicXML, ASCII, PowerTab .
· ASCII tablature import rules: hyphens for strings, vertical bars for measures .
· alphaTab importer settings: beatTextAsLyrics, encoding, mergePartGroupsInMusicXml .
· abcjs-vexflow-renderer: ABC parsing with VexFlow output .
