# Hybrid Rhythm Guitar v1 Syntax Spec

## Activation
- Rendering path activates only when:
  1. **Hybrid Rhythm Guitar Mode** is ON, and
  2. source contains at least one `{hybrid ... }` block with valid content.

## Block format

```txt
{hybrid
  sectionCue: text
  bar1: <event tokens>
  tab1: <shape> @ <beat>
  cue1: text
}
```

## Per-line directives
- `barN:` or `bN:` — define rhythmic/chord events for bar `N` in the current section.
- `tabN:` or `tN:` — define a tab shape event for bar `N`.
- `cueN:` or `cN:` — add cue text attached to bar `N`.
- `sectionCue:` or `sc:` — section-level cue text.

## Event token grammar

### Canonical form
`<beat>:<duration>(<optionalChord>)<optionalFlag>`

### Mobile shorthand form
`<beat><duration>(<optionalChord>)<optionalFlag>`

### Beat
- `1`, `2`, `3`, `4` (and meter-dependent up to numerator)
- offbeat: `1&`, `2&`, `3&`, `4&`

### Duration
- slash durations: `w`, `h`, `q`, `e`, `s`
- rest durations: `r` (quarter rest default), `rw`, `rh`, `rq`, `re`, `rs`

### Optional chord
- `(G)`, `(Em7)`, `(F#7)`, etc.

### Optional flag
- `!` accent
- `~` sustain/hold marker

### PM tokens inside bar line
- `pm` (bar-level PM)
- `pm_start`
- `pm_end`

## Tab shape grammar
`tabN: s1,s2,s3,s4,s5,s6 @ beat`

- Each string token is one of: `x`, `-`, or integer fret number.
- Example: `tab2: x,x,5,4,3,x @ 1`

## Validation + failure behavior
- Parser emits warnings for:
  - invalid beat position
  - unsupported duration
  - malformed tab shape
  - cue/tab/bar references to nonexistent bars
  - overlapping event starts
- Invalid entries are skipped.
- Chart still renders using valid entries.
- If no valid hybrid content remains, renderer falls back to normal fake-book path.

## Known v1 limits
- No engraved beaming engine for 16th-note grouping.
- No tied-rest notation model.
- Tab is event-level shape cueing (not full transcription).
- Cues are section-level or bar-level text only.
