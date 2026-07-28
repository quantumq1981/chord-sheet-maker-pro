name	description
chordpro
ChordPro format reference for creating and editing song files (.pro, .cho, .chopro). Use when working with chord sheets, song arrangements, metadata directives, transposition, or any ChordPro syntax questions.
ChordPro Format Reference

Official spec: https://www.chordpro.org/chordpro/

Bluegrass Songbook Format Strategy

We use ChordPro-compatible syntax with extensions:

Standard ChordPro for portability (works in other apps)
{meta: key value} pattern for all metadata (consistent, explicit)
{meta: x_*} for custom Bluegrass Songbook fields
ABC notation for fiddle tunes (via {start_of_abc})
File Extensions

.pro, .cho, .crd, .chopro, .chord

Line Types

# Comment (ignored by processors)
{directive: value}           # Metadata or formatting control
Lyrics with [C]inline [G]chords
                              # Blank line (section separator)
Chord Syntax

[C]        # Basic major chord
[Am]       # Minor chord
[Am7]      # With extension
[C/B]      # With bass note (slash chord)
[F#m]      # With accidental
[Bbmaj7]   # Flat + extension
[*Coda]    # Annotation (asterisk prefix = not a chord)
[*N.C.]    # "No chord" annotation
Chord structure: Root + Qualifier + Extension + /Bass

Component	Examples
Root	C, D, E, F, G, A, B (with # or b)
Qualifier	m (minor), dim, aug, sus
Extension	7, maj7, m7, sus4, add9, 6, 9, 11, 13
Bass	/E, /G, /B (any note after slash)
Alternate notations (supported by reference implementation):

Nashville: [1], [4], [5], [b7]
Roman: [I], [IV], [V], [bVII]
Metadata Directives

Bluegrass Songbook uses {meta: key value} pattern for consistency:

{meta: title Song Title}       # Required
{meta: artist Artist Name}     # Performer (from "Recorded by")
{meta: composer Writer Name}   # Songwriter (from "Written by")
{meta: lyricist Lyricist}      # If different from composer
{meta: album Album Name}
{meta: year 2024}
{key: G}                       # Musical key (standalone ok)
{time: 4/4}                    # Time signature
{tempo: 120}                   # BPM
{capo: 2}                      # Capo position
Note: {meta: title ...} and {title: ...} are functionally equivalent per the ChordPro spec. We prefer {meta: ...} for consistency.

Bluegrass Songbook custom fields (using x_ prefix per ChordPro spec):

{meta: x_source classic-country}
{meta: x_source_file yourcheatingheart.html}
{meta: x_enriched 2025-12-26}
{meta: x_strum_pattern boom-chick}
{meta: x_difficulty intermediate}
Provenance metadata (added automatically by workflows):

# For new submissions (via GitHub issue):
{meta: x_source manual}
{meta: x_submitted_by github:username}
{meta: x_submitted 2025-12-26}
{meta: x_submission_issue 26}

# For corrections to existing songs:
{meta: x_corrected_by github:username}
{meta: x_corrected 2025-12-26}
{meta: x_correction_issue 24}
Field	Purpose	Example
x_source	Original data source	classic-country, manual
x_source_file	Original filename	songname.html
x_enriched	Date enrichment ran	2025-12-26
x_submitted_by	GitHub user who submitted	github:username
x_submitted	Date submitted	2025-12-26
x_submission_issue	GitHub issue number	26
x_corrected_by	GitHub user who corrected	github:username
x_corrected	Date corrected	2025-12-26
x_correction_issue	GitHub issue number	24
Version metadata (for multiple versions of the same song):

{meta: x_version_label Alternate Arrangement}
{meta: x_version_type alternate}        # alternate | cover | simplified | live
{meta: x_arrangement_by John Smith}     # Who created this arrangement
{meta: x_version_notes Different key, simplified chord voicings}
{meta: x_canonical_id originalsongid}   # Links to primary version (optional)
Field	Purpose	Values
x_version_label	Display name for this version	Any descriptive text
x_version_type	Category of version	alternate, cover, simplified, live
x_arrangement_by	Person who created this arrangement	Name
x_version_notes	Free-form notes about differences	Any text
x_canonical_id	Links to the original/primary version	Song ID (filename stem)
Environment Directives (Sections)

Long Form	Short	Purpose
{start_of_verse} / {end_of_verse}	{sov} / {eov}	Verse block
{start_of_chorus} / {end_of_chorus}	{soc} / {eoc}	Chorus block
{start_of_bridge} / {end_of_bridge}	{sob} / {eob}	Bridge block
{start_of_tab} / {end_of_tab}	{sot} / {eot}	Tablature
{start_of_grid} / {end_of_grid}	{sog} / {eog}	Chord grid
With labels:

{start_of_verse: Verse 1}
{start_of_verse: label="Verse 2"}
{start_of_chorus: label="Chorus\nAll sing"}  # Multi-line label
Custom sections (any name with letters/digits/underscores):

{start_of_intro}
...
{end_of_intro}
Formatting Directives

{comment: Instrumental break}     # or {c: ...} - displayed as note
{comment_italic: Softly}          # or {ci: ...}
{comment_box: Important}          # or {cb: ...}
{highlight: Key change!}
{chorus}                          # Reference to repeat last chorus
Output Control

{new_song}           # or {ns} - start new song in multi-song file
{new_page}           # or {np}
{column_break}       # or {colb}
Chord Definitions & Diagrams

{define: Asus4 base-fret 1 frets x 0 2 2 3 0}
{chord: Asus4}       # Display diagram inline
Transposition

{transpose: +2}      # Transpose up 2 semitones
{transpose: -3}      # Transpose down 3
Complete Example

# Amazing Grace - Traditional hymn
{meta: title Amazing Grace}
{meta: artist Traditional}
{meta: composer John Newton}
{key: G}
{time: 3/4}
{tempo: 80}
{meta: x_source manual}

{start_of_verse: Verse 1}
A[G]mazing [G7]grace, how [C]sweet the [G]sound
That [G]saved a [Em]wretch like [D]me
I [G]once was [G7]lost, but [C]now I'm [G]found
Was [G]blind but [D]now I [G]see
{end_of_verse}

{start_of_verse: Verse 2}
'Twas [G]grace that [G7]taught my [C]heart to [G]fear
And [G]grace my [Em]fears re[D]lieved
How [G]preci[G7]ous did that [C]grace ap[G]pear
The [G]hour I [D]first be[G]lieved
{end_of_verse}

{comment: Repeat Verse 1}
Fiddle Tune Example (with ABC)

{meta: title Salt Creek}
{meta: artist Traditional}
{key: A}
{time: 4/4}
{tempo: 120}
{meta: x_type fiddle-tune}
{meta: x_difficulty intermediate}

{start_of_abc}
X:1
T:Salt Creek
M:4/4
K:A
|: E2AB c2BA | E2AB c2Bc | d2fd c2ec | BAGB A2AB :|
|: c2ec B2dB | A2cA G2BG | FGAB c2BA | BAGB A2AB :|
{end_of_abc}
Bluegrass Songbook Conventions

This project uses these conventions:

Metadata pattern: Use {meta: key value} for all metadata (consistent, explicit)
Metadata order: title, artist, composer, key, tempo, then x_* fields
Custom fields: Use x_ prefix for Bluegrass Songbook extensions
Verse markers: Use {start_of_verse}/{end_of_verse} for clear boundaries
Chord positioning: Place [chord] immediately before the syllable
Fiddle tunes: Use {start_of_abc}/{end_of_abc} for notation
Comments: Use {comment: ...} for performance instructions
Common Keys in Bluegrass/Country

Key	I	IV	V	Common Extensions
G	G	C	D	Em, Am, D7
C	C	F	G	Am, Dm, G7
D	D	G	A	Bm, Em, A7
A	A	D	E	F#m, Bm, E7
E	E	A	B	C#m, F#m, B7
Validation Checklist

{meta: title ...} and {meta: artist ...} present
{key: ...} matches the arrangement
{meta: composer ...} if known (not writer)
All chords are valid (no typos)
Verses wrapped in {start_of_verse}/{end_of_verse}
Chord placement is before syllables, not after
File ends with newline
Related Files

Parser: sources/classic-country/src/parser.py
Index builder: scripts/lib/build_index.py
Frontend renderer: docs/js/search.js
