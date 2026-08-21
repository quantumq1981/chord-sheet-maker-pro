import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadBrass() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('brassTranspose.js'), ctx);
  return ctx.window.BrassTranspose;
}

test('INSTRUMENTS catalog carries the standard transposition intervals', () => {
  const BT = loadBrass();
  const byId = Object.fromEntries(BT.INSTRUMENTS.map((i) => [i.id, i]));
  // Standard section-writing conventions: written pitch − sounding pitch.
  assert.equal(byId['trumpet-bb'].transposeSemitones, 2, 'Bb trumpet reads M2 above concert');
  assert.equal(
    byId['soprano-sax-bb'].transposeSemitones,
    2,
    'Bb soprano sax reads M2 above concert'
  );
  assert.equal(byId['alto-sax-eb'].transposeSemitones, 9, 'Eb alto sax reads M6 above concert');
  assert.equal(byId['tenor-sax-bb'].transposeSemitones, 14, 'Bb tenor sax reads M9 above concert');
  assert.equal(
    byId['baritone-sax-eb'].transposeSemitones,
    21,
    'Eb bari sax reads M13 above concert'
  );
  assert.equal(byId['horn-f'].transposeSemitones, 7, 'F horn reads P5 above concert');
  assert.equal(byId['trombone'].transposeSemitones, 0, 'trombone reads concert pitch');
  assert.equal(byId['trombone'].clef, 'bass', 'trombone uses bass clef');
  assert.equal(byId['tuba'].clef, 'bass', 'tuba uses bass clef');
  assert.equal(byId['clarinet-bb'].transposeSemitones, 2, 'Bb clarinet reads M2 above concert');
});

test('transposeMusicXml shifts <pitch> steps + octaves correctly', () => {
  const BT = loadBrass();
  // Middle C in treble (C4) → up 2 semitones (Bb trumpet on concert C) = D4.
  const src = `<pitch><step>C</step><octave>4</octave></pitch>`;
  const up2 = BT.transposeMusicXml(src, 2);
  assert.ok(up2.includes('<step>D</step>'), 'C → D');
  assert.ok(up2.includes('<octave>4</octave>'), 'octave preserved on M2');
  // C4 up 9 (Eb alto on C) = A4.
  const up9 = BT.transposeMusicXml(src, 9);
  assert.ok(up9.includes('<step>A</step>') && up9.includes('<octave>4</octave>'));
  // C4 up 14 (Bb tenor on C) = D5 → octave rolls over.
  const up14 = BT.transposeMusicXml(src, 14);
  assert.ok(up14.includes('<step>D</step>') && up14.includes('<octave>5</octave>'));
});

test('transposeMusicXml crosses the octave boundary for a high B', () => {
  const BT = loadBrass();
  // B4 up 2 = C#5 (family default spells sharp for C#).
  const src = `<pitch><step>B</step><octave>4</octave></pitch>`;
  const up2 = BT.transposeMusicXml(src, 2);
  assert.ok(
    up2.includes('<step>C</step>') &&
      up2.includes('<alter>1</alter>') &&
      up2.includes('<octave>5</octave>')
  );
});

test('transposeMusicXml respects existing accidentals', () => {
  const BT = loadBrass();
  // Bb4 (step B, alter -1, oct 4) up 2 = C5.
  const src = `<pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch>`;
  const up2 = BT.transposeMusicXml(src, 2);
  assert.ok(up2.includes('<step>C</step>') && up2.includes('<octave>5</octave>'));
  assert.ok(!up2.includes('<alter>'), 'C natural drops the alter tag');
});

test('transposeMusicXml recomputes <key> fifths + preserves mode', () => {
  const BT = loadBrass();
  // C major (0 fifths) + 2 semitones = D major (2 sharps).
  const cxml = '<key><fifths>0</fifths><mode>major</mode></key>';
  const dxml = BT.transposeMusicXml(cxml, 2);
  assert.match(dxml, /<fifths>2<\/fifths>/);
  assert.match(dxml, /<mode>major<\/mode>/);
  // A minor (0 fifths minor) + 2 = B minor (2 sharps minor).
  const amxml = '<key><fifths>0</fifths><mode>minor</mode></key>';
  const bmxml = BT.transposeMusicXml(amxml, 2);
  assert.match(bmxml, /<fifths>2<\/fifths>/);
  assert.match(bmxml, /<mode>minor<\/mode>/);
  // G major (+1) + 9 semitones (Eb alto sax) = E major (+4 sharps).
  const gxml = '<key><fifths>1</fifths><mode>major</mode></key>';
  const exml = BT.transposeMusicXml(gxml, 9);
  assert.match(exml, /<fifths>4<\/fifths>/);
});

test('transposeMusicXml shifts <harmony> roots and slash basses', () => {
  const BT = loadBrass();
  // C major chord — root C. Up 2 = D. Alter drops.
  const src = '<harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>';
  const up2 = BT.transposeMusicXml(src, 2);
  assert.match(up2, /<root-step>D<\/root-step>/);
  assert.ok(!/<root-alter>/.test(up2), 'natural D has no root-alter');
  // Bb7 (Bb root + kind dominant) up 9 = G7.
  const bb7 =
    '<harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>dominant</kind></harmony>';
  const g7 = BT.transposeMusicXml(bb7, 9);
  assert.match(g7, /<root-step>G<\/root-step>/);
  assert.ok(!/<root-alter>/.test(g7), 'natural G');
  // Slash chord C/E up 7 = G/B.
  const cSlash =
    '<harmony><root><root-step>C</root-step></root><kind>major</kind><bass><bass-step>E</bass-step></bass></harmony>';
  const gSlash = BT.transposeMusicXml(cSlash, 7);
  assert.match(gSlash, /<root-step>G<\/root-step>/);
  assert.match(gSlash, /<bass-step>B<\/bass-step>/);
});

test('transposeMusicXml can rewrite the clef for bass-clef instruments', () => {
  const BT = loadBrass();
  const src = '<clef><sign>G</sign><line>2</line></clef>';
  const bass = BT.transposeMusicXml(src, 0, { clef: 'bass' });
  assert.match(bass, /<sign>F<\/sign>/);
  assert.match(bass, /<line>4<\/line>/);
  // Absent an override, the clef is untouched.
  const same = BT.transposeMusicXml(src, 2);
  assert.equal(same, src);
});

test('transposeMusicXml with semitones=0 and no clef override is a passthrough', () => {
  const BT = loadBrass();
  const src = `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Rhythm Guitar</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>1</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
  <note><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type><notehead>slash</notehead></note>
</measure></part></score-partwise>`;
  assert.equal(BT.transposeMusicXml(src, 0), src);
});

test('transposeMusicXml overrides <part-name> when opts.partName is set', () => {
  const BT = loadBrass();
  const src = '<part-name>Rhythm Guitar</part-name>';
  const out = BT.transposeMusicXml(src, 0, { partName: 'B♭ Trumpet' });
  assert.match(out, /<part-name>B(?:♭|&#9837;)? ?Trumpet<\/part-name>/);
});

test('buildBrassMusicXml — individual parts each have their instrument name + transposed pitches', () => {
  const BT = loadBrass();
  const src = `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Concert</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>1</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
  <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
</measure></part></score-partwise>`;
  const { parts } = BT.buildBrassMusicXml(src, ['trumpet-bb', 'alto-sax-eb', 'trombone'], {
    mode: 'parts',
    title: 'Blues',
  });
  assert.equal(parts.length, 3);
  // Bb trumpet: C→D, key C→D (2 sharps).
  const tpt = parts[0];
  assert.match(tpt.xml, /<step>D<\/step>/);
  assert.match(tpt.xml, /<fifths>2<\/fifths>/);
  assert.match(tpt.xml, /<root-step>D<\/root-step>/);
  assert.ok(tpt.filename.endsWith('.xml'));
  assert.match(tpt.xml, /<part-name>[^<]*Trumpet[^<]*<\/part-name>/);
  // Eb alto: C→A, key C→A (3 sharps).
  const alto = parts[1];
  assert.match(alto.xml, /<step>A<\/step>/);
  assert.match(alto.xml, /<fifths>3<\/fifths>/);
  // Trombone: concert pitch (0), bass clef switched.
  const trb = parts[2];
  assert.match(trb.xml, /<step>C<\/step>/);
  assert.match(trb.xml, /<sign>F<\/sign>/);
  assert.match(trb.xml, /<line>4<\/line>/);
});

test('buildBrassMusicXml — full-score mode emits a multi-part score-partwise', () => {
  const BT = loadBrass();
  const src = `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Concert</part-name></score-part></part-list>
<part id="P1"><measure number="1">
  <attributes><divisions>1</divisions><key><fifths>0</fifths><mode>major</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
  <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
</measure><measure number="2">
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
</measure></part></score-partwise>`;
  const { score, filename } = BT.buildBrassMusicXml(src, ['trumpet-bb', 'alto-sax-eb'], {
    mode: 'score',
    title: 'Blues Section',
  });
  assert.ok(filename.endsWith('.xml'));
  assert.match(score, /<score-partwise/);
  // Two <score-part> entries with the picked instrument names.
  const scoreParts = score.match(/<score-part\b/g) || [];
  assert.equal(scoreParts.length, 2, 'one score-part per picked instrument');
  const parts = score.match(/<part id=/g) || [];
  assert.equal(parts.length, 2);
  // Each part carries its transposed measures.
  assert.match(score, /<part id="trumpet-bb"/);
  assert.match(score, /<part id="alto-sax-eb"/);
  // A trumpet measure should show its D (from concert C).
  const tptSect = score.split('<part id="trumpet-bb">')[1].split('</part>')[0];
  assert.match(tptSect, /<step>D<\/step>/);
  const altSect = score.split('<part id="alto-sax-eb">')[1].split('</part>')[0];
  assert.match(altSect, /<step>A<\/step>/);
});

test('assemblePartwiseScore rejects empty input safely', () => {
  const BT = loadBrass();
  const score = BT.assemblePartwiseScore([], { title: 'Empty' });
  assert.match(score, /<score-partwise/);
  assert.match(score, /<part-list\/>/);
});

test('transposeAbc adjusts K: and note letters + octave markers', () => {
  const BT = loadBrass();
  const abc = `X:1
T:Test
M:4/4
L:1/4
K:C
C D E F | G A B c |`;
  // Up 2 (Bb trumpet on concert C): K:C→D, letters shift.
  const up2 = BT.transposeAbc(abc, 2);
  assert.match(up2, /K:D/, 'key K:C → K:D');
  // C→D, D→E, E→^F (family default: F#), F→G, G→A, A→B, B→^c, c→d
  assert.ok(up2.includes('D E ^F G'), 'body C D E F → D E ^F G: got ' + up2);
  assert.ok(up2.includes('A B ^c d'), 'body G A B c → A B ^c d');
});

test('transposeAbc handles a Bb minor tune → Cm for Bb trumpet', () => {
  const BT = loadBrass();
  const abc = `X:1
T:Blues
M:4/4
L:1/4
K:Bbm
_B _d f _b | _b f _d _B |`;
  const up2 = BT.transposeAbc(abc, 2);
  assert.match(up2, /K:Cm/);
});

test('transposeAbc transposes chord annotations (with slash bass)', () => {
  const BT = loadBrass();
  const abc = `K:C
"C"C4 | "F"F4 | "G7"G4 | "C/E"C4 |`;
  const up2 = BT.transposeAbc(abc, 2);
  assert.match(up2, /"D"/);
  assert.match(up2, /"G"/);
  assert.match(up2, /"A7"/);
  assert.match(up2, /"D\/F#"/); // C/E → D/F#
});

test('transposeAbc leaves text annotations (^Verse) alone', () => {
  const BT = loadBrass();
  const abc = `K:C
"^Verse 1"C D E F |`;
  const out = BT.transposeAbc(abc, 2);
  assert.match(out, /"\^Verse 1"/);
  assert.ok(out.includes('D E ^F G'));
});

test('transposeAbc with clef=bass inserts a V:1 clef=bass after K:', () => {
  const BT = loadBrass();
  const abc = `X:1
K:C
C D E F |`;
  const out = BT.transposeAbc(abc, 0, { clef: 'bass' });
  assert.match(out, /V:1 clef=bass/);
});

test('buildBrassAbc — Bb trumpet part injects %%MIDI program', () => {
  const BT = loadBrass();
  const abc = `X:1\nK:C\nC D E F |\n`;
  const { parts } = BT.buildBrassAbc(abc, ['trumpet-bb'], { title: 'Simple' });
  assert.equal(parts.length, 1);
  assert.match(parts[0].abc, /K:D/);
  assert.match(parts[0].abc, /%%MIDI program 56/);
  assert.ok(parts[0].filename.endsWith('.abc'));
});

test('unknown instrument ids are silently skipped', () => {
  const BT = loadBrass();
  const { parts } = BT.buildBrassMusicXml('<score-partwise/>', ['not-a-real-id', 'trumpet-bb'], {
    mode: 'parts',
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].id, 'trumpet-bb');
});

test('transposeChordText matches the family enharmonic default (Bb C# Eb F# Ab)', () => {
  const BT = loadBrass();
  // C up 1 → C# (not Db).
  assert.equal(BT.transposeChordText('C', 1), 'C#');
  // C up 3 → Eb (not D#).
  assert.equal(BT.transposeChordText('C', 3), 'Eb');
  // C up 6 → F# (not Gb).
  assert.equal(BT.transposeChordText('C', 6), 'F#');
  // C up 8 → Ab (not G#).
  assert.equal(BT.transposeChordText('C', 8), 'Ab');
  // C up 10 → Bb (not A#).
  assert.equal(BT.transposeChordText('C', 10), 'Bb');
});
