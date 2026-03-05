
PROCESS Document for assisting  coding agents (or LLMS) to reliably convert an Ultimate Guitar “Pro / Standard Notation / Beat+Bar” PDF into your target text format, which we can label:

Chord Sheet Maker Pro Notation (CSMPN)

⸻

Chord Sheet Maker Pro Notation (CSMPN)

1) Target output specification

1.1 Header block (required fields)

Title: <Song Title>
Composer: <Composer>
Style: <Style description>
Tempo: ♩=<integer>
Key: <Key>
Time: <optional, e.g., 4/4>

1.2 Section blocks
	•	Section header uses square brackets:
	•	[Intro], [Verse 1], [Bridge], [Chorus 2], [Solo], etc.
	•	Barline layout:
	•	Start and end of a complete section line uses double bars: ‖
	•	Measures separated by |
	•	Wrap to a new line when needed; wrapped lines begin with |  for visual alignment

Example pattern:

[Section Name]
‖ Chord(s) | Chord(s) | Chord(s) | Chord(s) |
| Chord(s) | Chord(s) ‖

1.3 Chord token conventions (normalization rules)

Normalize all chords to ASCII-friendly symbols:
	•	Major 7: F7M, FΔ, Fmaj7 → Fmaj7
	•	Half-diminished: EØ, Eø, Em7b5 → Em7b5
	•	Diminished: Edim, Eo7, E°7 → Edim7 (or keep Edim if no 7 indicated—pick one standard)
	•	Augmented: F+, Faug → Faug (or F+—pick one standard)
	•	Accidentals: B♭ → Bb, C♯ → C#
	•	Slash chords preserved: D/F#

⸻

2) Why this conversion is non-trivial (so agents don’t underestimate it)

UG “Pro” PDFs frequently render notation as a mixture of:
	•	Text objects (often the chord symbols)
	•	Vector graphics (staff lines, noteheads, barlines, repeat signs)
	•	Layout-driven meaning (a chord’s x-position implies which measure it belongs to)

So the correct pipeline is: extract tokens + coordinates, reconstruct measure boundaries, then render.

⸻

3) Recommended architecture

Use a two-stage pipeline with a strict intermediate representation:
	1.	Deterministic extraction (code-heavy, minimal interpretation)
	2.	Structured formatting + optional LLM assist (interpretation constrained by schema)

This avoids the classic failure mode: an LLM “helpfully” inventing missing harmony.

⸻

4) Step-by-step process (implementation-grade)

Step 0 — Ingest inputs

Input: PDF (UG Pro export)
Optional: screenshots of the UG viewer (helpful for debugging display assumptions)

Store:
	•	pdf_path
	•	page_images (render each page at 200–300 DPI for fallback OCR/vision)

Step 1 — Extract metadata (Title / Composer / Tempo / Key / Time)

1.1 From PDF text
	•	Use a PDF parser that can read text blocks with coordinates (e.g., PyMuPDF / fitz).
	•	Search top-of-page text for likely fields:
	•	Title: largest font near top
	•	Composer: adjacent line under title or in header
	•	Tempo: look for ♩ = or just a number near a tempo marking
	•	Key/Time: may not be explicitly stated; sometimes implied

1.2 If metadata is missing or ambiguous
	•	Leave blank or set Key: to the chart center (inferred later).
	•	Do not hallucinate.

Output: metadata = {title, composer, style, tempo_bpm, key, time_sig}

Step 2 — Extract chord symbols with coordinates

2.1 Text-first approach (preferred)

Chord symbols in UG PDFs are often text objects positioned above the staff.

Extract all text spans with:
	•	text
	•	page
	•	bounding box (x0, y0, x1, y1)
	•	font size (helps filter chord-sized labels)

Filter spans that look like chords using regex heuristics, e.g.:
	•	Root: [A-G]
	•	Optional accidental: [b#]?
	•	Quality tokens: m, maj, dim, aug, sus, add, ø, °, 7, 9, 13, etc.
	•	Optional slash bass: /(?:[A-G][b#]?)

2.2 Fallback: OCR/vision chord extraction

If chord text isn’t extractable (sometimes it’s converted to vectors):
	•	Render page to image
	•	Run OCR on regions above staff lines
	•	Use the same regex filter and keep bounding boxes from OCR

Output: chords = [ {page, x_center, y_center, raw_text} … ]

Step 3 — Detect staff systems and measure boundaries

You need measures so you can say “these chord tokens belong to bar 1, bar 2, …”.

3.1 Detect staff systems (rows)

Methods:
	•	Vector-line detection (if available): staff lines are dense horizontal lines.
	•	Image-based: detect clusters of five parallel horizontal lines.
	•	Practical heuristic: group chord tokens by y into systems (k-means or threshold clustering).

Output: systems = [ {page, system_id, y_band_min, y_band_max, chords_in_system[]} … ]

3.2 Detect barlines (measure separators)

Options (ranked):
	1.	Vector path extraction: barlines are vertical line segments; detect long near-vertical strokes crossing the staff band.
	2.	Image processing: detect vertical lines in staff region (Hough transform).
	3.	Spacing heuristic (last resort): infer measure boundaries by consistent x-intervals plus double-bar markers.

Output per system: sorted list of barline x-positions
barlines = [x0, x1, x2, …]

Step 4 — Assign chords to measures

For each system:
	•	Sort chords by x
	•	For each chord, find the enclosing bar interval:
	•	measure_index = the i such that barlines[i] <= chord.x < barlines[i+1]

Allow multiple chord tokens per measure; order them by x.

Output: measures = [ {global_bar_number, chords:[...]} … ]

Step 5 — Normalize chord spellings to CSMPN

Create a normalization function:

Core mappings
	•	Replace unicode:
	•	♭ → b, ♯ → #
	•	Ø/ø → m7b5 (but only when used as half-diminished marker)
	•	Δ → maj7
	•	° → dim (or dim7 if the chord already implies 7)
	•	Convert 7M → maj7 (e.g., F7M → Fmaj7)
	•	Standardize minor:
	•	min → m, keep m7 etc.

Important: don’t “reharmonize.” This stage is spelling only.

Output: normalized_measures

Step 6 — Identify form / sections (AABA, choruses, verses, etc.)

UG PDFs may not label sections explicitly. You have three approaches:

6.1 If rehearsal marks exist in text

Extract “A”, “B”, “Coda”, “Solo”, etc. from PDF text near system starts.

6.2 Pattern-based inference (deterministic)
	•	Compute hash signatures of 8-bar or 16-bar windows of chord measures.
	•	Find repeats (same chord sequence appears multiple times):
	•	Repeated 32-bar sequence → likely “Chorus xN”
	•	Unique middle segment → likely “Bridge (B)”
	•	If the piece is a jazz head:
	•	Often: Head (1 chorus), Head (repeat), Solos (N choruses), Head out

6.3 LLM assist (constrained)

If you want an LLM to name sections:
	•	Provide it only the normalized measure list (no guessing missing bars)
	•	Ask it to output section boundaries in strict JSON:
	•	{sections:[{name,start_bar,end_bar}…]}

Then validate:
	•	Sections cover all bars exactly once (unless repeats are intentional)
	•	No gaps, no overlaps

Step 7 — Render to CSMPN text layout

Rendering rules:
	•	Start each section with [Name]
	•	Print measures in order
	•	Insert ‖ at section start and end
	•	Wrap at a fixed measures-per-line (commonly 4 bars per line, or align with systems)
	•	If a measure has multiple chords:
	•	join with spaces: Em7b5 A7
	•	If measure is explicitly a repeat/percent in source:
	•	optionally encode % (your choice), but only if you detected it reliably

Output: final CSMPN text.

⸻

5) Quality control checklist (what makes it “meticulous”)

A future agent should pass these checks before declaring success:
	1.	Measure count sanity

	•	Does total bar count match the PDF’s bar numbers / systems?

	2.	Chord density sanity

	•	If 8 consecutive measures are empty, that’s almost certainly an extraction bug.

	3.	Left-to-right ordering

	•	Chords within a bar must be in x-order.

	4.	Repeat structure sanity

	•	If the chart visually shows 3 choruses, your output should show 3 sections or a “Repeat” instruction—consistently.

	5.	Normalization reversibility

	•	Keep raw_text in the intermediate JSON so you can debug spelling conversions.

⸻

6) Intermediate JSON schema (recommended)

This is the “handoff format” between extraction code and formatter/LLM:

{
  "metadata": {
    "title": "",
    "composer": "",
    "style": "",
    "tempo_bpm": 0,
    "key": "",
    "time_sig": ""
  },
  "bars": [
    {
      "bar": 1,
      "system": 0,
      "page": 1,
      "chords_raw": ["F7M"],
      "chords_norm": ["Fmaj7"]
    },
    {
      "bar": 2,
      "chords_raw": ["EØ", "A7"],
      "chords_norm": ["Em7b5", "A7"]
    }
  ]
}


⸻

7) LLM prompt template (for sectioning + formatting only)

Use an LLM where it is strong (structure and labeling), not where it is risky (token extraction).

System instruction (summary):
	•	“You may not invent chords or bars. Only reorganize provided bars into named sections and render CSMPN.”

User payload:
	•	Provide the JSON bars[] list plus your CSMPN formatting rules.
	•	Require exact output: either strict JSON section map, or final CSMPN text.

⸻

8) Practical note specific to UG “Beat + Bar”

In UG’s “Beat + Bar” view, chord symbols’ meaning is largely positional: they sit above the staff aligned to measures. So your extractor’s coordinate logic is the real work; once bars are reconstructed, generating CSMPN is straightforward.

⸻


Below is an audit, prioritized for 
(1) making the current converter reliably runnable, and 
(2) evolving it toward your new goal: UG Pro PDF → CSMPN (without full OMR).


A. Critical issues that will break or destabilize the current app

1) Literal “```” code fences are inside the HTML/CSS

Your <style> block contains literal triple-backticks, which are not valid CSS and will cause parsing failures or weird rendering.  
You also have similar “```” blocks around body HTML and script sections (same problem, different place).  

Fix: delete all occurrences of ``` from the HTML file. Those belong in chat messages/markdown, not in the actual source.

2) selectFormat() relies on event.target, but event is not passed

Your buttons call selectFormat('chordpro'), but inside selectFormat you do event.target.classList.add('active');.  
This works inconsistently depending on browser/runtime; it’s a common cause of “nothing happens” on iOS Safari.

Fix options:
	•	Pass this: onclick="selectFormat('chordpro', this)", then use the passed element.
	•	Or avoid inline handlers and attach listeners in JS (recommended long-term).

⸻

B. Structural limitations that matter for your CSMPN/CSMPN workflow

3) Bar grouping is “blind chunking,” not measure-aware
	•	ChordPro parser groups chords into bars by fixed groups of 4, regardless of time signature or harmonic rhythm.  
	•	UG Text parser groups by beats-per-bar from the time signature, but still assumes each chord token is one beat (rarely true in real charts).  

Why it matters: UG Pro PDFs effectively are measure-aware. If you want accurate CSMPN, the core data model needs to be measure-based, with chord events having positions (beat/offset), not just “a list of chords.”

4) MusicXML parsing drops empty measures, breaking alignment

In extractChords, you only push a measure if it has at least one <harmony> tag, which collapses the timeline.  
Result: bar numbers drift, repeats/holds become impossible to express correctly, and your “expand everything” mode becomes unreliable.

5) Chord normalization is inconsistent with your CSMPN standard

Your MusicXML kindMap emits Maj7 and m7b5 (half-diminished).  
You explicitly want major seventh as maj7 and half-diminished as m7b5 (e.g., Em7b5). Good news: you’re already close—this is just a normalization layer issue, but it must be centralized so all importers agree.

⸻

C. What’s structurally “intact” and worth keeping

6) The high-level architecture is correct: Parser → Normalizer → Generator

You already have the right separation in spirit:
	•	ChordProParser, UGTextParser, MusicXMLParser produce structured data  
	•	FormatGenerator outputs the CSMPN-like text blocks  

This is the right spine to keep. The next phase is making the data model measure-aware and adding a dedicated UG Pro PDF importer.

⸻

D. Recommended restructuring for “UG Pro PDF → CSMPN” (no full OMR)

1) Define a single canonical internal format (measure-first)

Aim for something like:
	•	Song
	•	metadata
	•	measures: [ { number, timeSig, keySig, chords:[ { offset, symbol } ], repeat/ending markers } ]

Then the generator formats those measures into your CSMPN bars/lines (and can support both: “compressed w/ repeats” and “expanded chord stream”).

This directly addresses the current bar-chunking weakness.  

2) Add a “ChordSymbolNormalizer” used by every importer

Centralize:
	•	Maj7 → maj7
	•	- or min → m
	•	ø / half-diminished → m7b5 (which you already map in MusicXML)  

3) Build a dedicated UG Pro PDF importer (PDF text extraction first)

For UG “Pro” PDFs, you often can avoid OMR because chord symbols are frequently embedded as text objects in the PDF (selectable). The pragmatic pipeline is:
	1.	Extract text objects + their coordinates per page (pdf.js in-browser is the usual move).
	2.	Filter candidates that match chord regex.
	3.	Cluster by staff/system row using Y-coordinates.
	4.	Quantize X-position into measure slots using detected barlines or consistent spacing heuristics.
	5.	Emit measure-aware chord events.

This is far more reliable than general OMR and aligns with your “reduce clutter, keep what matters” direction.

⸻

E. before all work photos are completed. It is important that you do a sanity check and if necessary.
	produce a patch list (exact edits) making sur  this app runs cleanly on iPhone (remove ``` blocks, fix event.target, etc.), and/or
	
and also make sure to outline the UG Pro PDF importer spec (data structures + heuristics + chord regex + measure quantization rules) this is assuming this is an already done since it should’ve been able to be implemented fast