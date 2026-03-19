# VexFlow Notation Enhancement Plan

## Goal

Expand `{vt ...}` notation blocks in Fake-Book mode without breaking the existing one-line EasyScore-style snippets that are already working in production.

## Short analysis of VexFlow’s current feature set

VexFlow already exposes the primitives needed for most of the requested roadmap items: `StaveNote`, `Accidental`, `Beam`, `StaveTie`, `Articulation`, `Annotation`, `GraceNoteGroup`, `TextDynamics`, `Crescendo`, `Volta`, `TabNote`, `TabStave`, `StaveConnector`, `Ornament`, and `Factory`/`System` helpers. In other words, the library is capable of rendering much more than the app’s previous `{vt ...}` bridge exposed. The main gap was not rendering power; it was the app-side parser and the fact that the old implementation only passed a single EasyScore note string straight into one staff.

### Capability mapping

| Requested area | VexFlow support | Phase in this repo |
| --- | --- | --- |
| Notes, rests, accidentals, dotted values | Native | Implemented now |
| Chords | Native | Implemented now |
| Beams | Native | Implemented now |
| Ties | Native | Implemented now |
| Lyrics / text / chord symbols above staff | Via `Annotation` | Implemented now |
| Articulations, fermatas | Via `Articulation` | Implemented now |
| Grace notes | Via `GraceNote` / `GraceNoteGroup` | Implemented now |
| Multiple bars | Native with multiple staves / formatting | Implemented now |
| Multiple voices / polyphony | Native with multiple `Voice` instances | Designed, not yet implemented |
| Grand staff / multi-staff | Native with multiple staves and connectors | Designed, not yet implemented |
| Guitar tab / chord diagrams | Native tablature support, diagrams would need app-side DSL / drawing | Designed, not yet implemented |
| Hairpins, voltas, repeats, endings | Native primitives exist | Designed, not yet implemented |

## Technical risks identified before implementation

1. **Backward compatibility risk**  
   The app already had a working EasyScore path. Replacing it outright would risk regressions. The new implementation therefore parses enhanced syntax first and falls back to the legacy EasyScore renderer if enhanced parsing/drawing fails.

2. **Runtime API drift risk**  
   The app loads VexFlow 3.0.9 from a CDN. Some online examples target newer APIs. To reduce disruption, the new bridge uses stable 3.x primitives and keeps the old renderer available as a fallback.

3. **Miniature-staff layout risk**  
   The notation block lives inside a fake-book bar-oriented layout, so large snippets can overflow quickly. The current implementation caps bars-per-row and draws compact multi-bar systems. Larger constructs such as grand staff or tablature should be added in a later phase with explicit layout controls.

4. **Syntax complexity risk**  
   Rich notation can become unreadable if the DSL grows too quickly. The current phase keeps the original note syntax intact and adds optional modifier blocks like `[staccato, lyric="Hi"]` rather than replacing the existing shorthand.

## Implemented Phase 1 syntax

The notation block stays brace-based and backward compatible:

```text
{vt [4/4] bass: tempo="Allegro" C3/q[chord="Cm7",dyn="mf"] qr | <C3 E3 G3>/h^ <C3 E3 G3>/h}
```

### Supported tokens

- **Single note**: `C4/q`, `Bb4/8`, `F#5/h.`
- **Chord**: `<C4 E4 G4>/q`, `<Bb3 D4 F4>/h.`
- **Rest**: `qr`, `8r`, `r/q`, `hr.`
- **Tie**: `C4/q^ C4/q` or across bars `C4/q^ | C4/q`
- **Bar separator**: `|`
- **Clef prefix**: `bass:`, `treble:`, `alto:`, `tenor:`, `percussion:`
- **Time prefix**: `[3/4]`, `[6/8]`
- **Tempo/text directives**: `tempo="Allegro"`, `text="rubato"`
- **Modifiers**: appended in `[...]`
  - articulations: `staccato`, `accent`, `tenuto`, `marcato`, `fermata`
  - `lyric="Hello"`
  - `text="rit."`
  - `dyn="mf"`
  - `chord="Cmaj7"`
  - `grace="D4/16 E4/16"`

### Backward compatibility examples

Existing snippets still work unchanged:

```text
{vt C4/q, D4/q, E4/q, F4/q}
{vt [3/4] G4/q, A4/q, B4/q}
{vt bass: F2/h, G2/h}
```

## Rendering logic

1. Parse the raw `{vt ...}` content into a structured notation model.
2. Split the content into measures using `|`.
3. Convert each event into a VexFlow `StaveNote`.
4. Add accidentals, dots, annotations, articulations, and grace notes.
5. Build one `Voice` per measure for this phase.
6. Format each measure into a compact multi-bar system.
7. Auto-generate beams.
8. Draw ties within a bar or across adjacent bars.
9. If enhanced parsing or rendering fails, fall back to the original EasyScore renderer.

## Recommended next phases

### Phase 2
- Multiple voices (`voice1:`, `voice2:` blocks).
- Repeat barlines, voltas, and ending brackets.
- Hairpins and dedicated dynamic glyph rendering.
- Better per-block layout controls (`bars=2`, `scale=0.8`, `staff=grand`).

### Phase 3
- Tab staff and percussion shorthand.
- Chord-diagram DSL and rendering.
- Real-time parser diagnostics wired into the preview UI.
- Optional block-level JSON export for future import/export tooling.

## Suggested beta checklist

- Validate on existing sheets that already use `{vt C4/q, ...}`.
- Test small mobile widths for 1–4 bar snippets.
- Collect user feedback on modifier naming before adding more DSL surface area.
