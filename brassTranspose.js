/**
 * brassTranspose.js — Brass / Horn / Sax section transposer for MusicXML and ABC.
 *
 * Pure, headless-testable core (no DOM, no abcjs, no MusicXmlCore dependency at
 * evaluation time) that turns a concert-pitch source into per-instrument
 * transposed parts, and can assemble a multi-part score. Loaded as a classic
 * <script> after musicXmlCore.js so `window.BrassTranspose` is available for
 * the index.html UI wiring.
 *
 * The primitive is `semitones` — the amount to shift the WRITTEN pitch above
 * concert. A Bb trumpet reads concert C as written D (a major 2nd higher), so
 * its `transposeSemitones` = +2. Trombone reads concert pitch (0), notated in
 * bass clef.
 *
 * The MusicXML transformer is intentionally regex-based (no @xmldom dep needed
 * at test time). It touches only the three elements that carry pitch:
 *   • <pitch><step>/<alter>/<octave></pitch>   — every note
 *   • <harmony><root>/<bass>...</harmony>       — every chord symbol
 *   • <key><fifths>/<mode></key>                — the key signature
 * plus an optional <clef> rewrite for bass-clef instruments (trombone). Every
 * other MusicXML element passes through unchanged, so structure, repeats,
 * voltas, lyrics, section rehearsal marks and tempo are preserved.
 */
(function () {
  'use strict';

  // ── Instrument catalog ────────────────────────────────────────────────────
  // `transposeSemitones` = written − sounding, i.e. how much to shift concert
  // pitch UP to get the written part. `clef` is the standard staff for the part.
  // `midiProgram` is the General-MIDI voice used for ABC playback previews.
  var INSTRUMENTS = [
    { id: 'trumpet-bb', name: 'B♭ Trumpet', family: 'brass', transposeSemitones: 2, clef: 'treble', midiProgram: 56 },
    { id: 'cornet-bb', name: 'B♭ Cornet', family: 'brass', transposeSemitones: 2, clef: 'treble', midiProgram: 56 },
    { id: 'flugelhorn-bb', name: 'B♭ Flugelhorn', family: 'brass', transposeSemitones: 2, clef: 'treble', midiProgram: 56 },
    { id: 'horn-f', name: 'F Horn', family: 'brass', transposeSemitones: 7, clef: 'treble', midiProgram: 60 },
    { id: 'trombone', name: 'Trombone', family: 'brass', transposeSemitones: 0, clef: 'bass', midiProgram: 57 },
    { id: 'bass-trombone', name: 'Bass Trombone', family: 'brass', transposeSemitones: 0, clef: 'bass', midiProgram: 57 },
    { id: 'euphonium', name: 'Euphonium (BC)', family: 'brass', transposeSemitones: 0, clef: 'bass', midiProgram: 58 },
    { id: 'euphonium-tc-bb', name: 'B♭ Euphonium (TC)', family: 'brass', transposeSemitones: 14, clef: 'treble', midiProgram: 58 },
    { id: 'tuba', name: 'Tuba', family: 'brass', transposeSemitones: 0, clef: 'bass', midiProgram: 58 },
    { id: 'soprano-sax-bb', name: 'B♭ Soprano Sax', family: 'sax', transposeSemitones: 2, clef: 'treble', midiProgram: 64 },
    { id: 'alto-sax-eb', name: 'E♭ Alto Sax', family: 'sax', transposeSemitones: 9, clef: 'treble', midiProgram: 65 },
    { id: 'tenor-sax-bb', name: 'B♭ Tenor Sax', family: 'sax', transposeSemitones: 14, clef: 'treble', midiProgram: 66 },
    { id: 'baritone-sax-eb', name: 'E♭ Baritone Sax', family: 'sax', transposeSemitones: 21, clef: 'treble', midiProgram: 67 },
    { id: 'clarinet-bb', name: 'B♭ Clarinet', family: 'woodwind', transposeSemitones: 2, clef: 'treble', midiProgram: 71 },
    { id: 'bass-clarinet-bb', name: 'B♭ Bass Clarinet', family: 'woodwind', transposeSemitones: 14, clef: 'treble', midiProgram: 71 },
  ];

  var INSTRUMENT_BY_ID = {};
  for (var i = 0; i < INSTRUMENTS.length; i++) INSTRUMENT_BY_ID[INSTRUMENTS[i].id] = INSTRUMENTS[i];

  function getInstrument(id) { return INSTRUMENT_BY_ID[id] || null; }

  // ── Pitch arithmetic ──────────────────────────────────────────────────────
  var STEP_TO_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Family default enharmonic spelling — Bb C# Eb F# Ab (matches chordTheory.js).
  var FAMILY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  function normSemis(n) {
    n = Math.round(Number(n) || 0);
    // Keep result in a musical range; MusicXML pitches will be clamped separately.
    return n;
  }

  // Pick a note-name table given a preference. Defaults to family spelling.
  function nameTable(prefer) {
    if (prefer === 'sharp') return SHARP_NAMES;
    if (prefer === 'flat') return FLAT_NAMES;
    return FAMILY_NAMES;
  }

  // Spell a chromatic pitch-class (0..11) as `{ step, alter }`.
  // alter ∈ {-1, 0, +1}. Uses the chosen name table.
  function pcToStepAlter(pc, prefer) {
    var name = nameTable(prefer)[((pc % 12) + 12) % 12];
    var step = name[0];
    var alter = 0;
    if (name.length > 1) alter = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0;
    return { step: step, alter: alter };
  }

  // Transpose a MusicXML pitch (step, alter, octave) by `semitones`. Returns
  // `{ step, alter, octave }` with alter forced to -1|0|+1 (no double sharps/flats).
  function transposePitchXml(step, alter, octave, semitones, prefer) {
    var basePc = STEP_TO_PC[String(step).toUpperCase()];
    if (basePc === undefined) return { step: step, alter: alter, octave: octave };
    var midi = octave * 12 + basePc + Number(alter || 0);
    var newMidi = midi + normSemis(semitones);
    var newOct = Math.floor(newMidi / 12);
    var newPc = ((newMidi % 12) + 12) % 12;
    var sa = pcToStepAlter(newPc, prefer);
    // Octave sits under whichever step name we chose. E.g. C4 (midi 60) →
    // if spelled B#3 the octave is 3, and if spelled Cb4 it's 4. We use plain
    // steps so `newOct` matches.
    // Reconcile the octave with the letter-name: if we picked, say, "B" for
    // pc 11 but newMidi was one below newOct*12, the natural octave is newOct.
    // The math above already gives the right octave for the chosen step because
    // `pcToStepAlter` never introduces double accidentals.
    return { step: sa.step, alter: sa.alter, octave: newOct };
  }

  // ── Key signature transposition ───────────────────────────────────────────
  // Major-key pc → circle-of-fifths count (sharps positive, flats negative).
  var MAJOR_FIFTHS_BY_PC = {
    0: 0, 2: 2, 4: 4, 5: -1, 7: 1, 9: 3, 11: 5,
    // Chromatic majors
    1: -5, 3: -3, 6: 6, 8: -4, 10: -2,
  };
  // Minor key: pc of tonic → fifths.
  var MINOR_FIFTHS_BY_PC = {
    9: 0, 11: 2, 1: 4, 2: -1, 4: 1, 6: 3, 8: 5,
    10: -5, 0: -3, 3: 6, 5: -4, 7: -2,
  };

  // Root pc of a major key from fifths. Circle-of-fifths: F C G D A E B → -1 to +5.
  function pcFromFifthsMajor(fifths) {
    for (var pc = 0; pc < 12; pc++)
      if (MAJOR_FIFTHS_BY_PC[pc] === fifths) return pc;
    // Enharmonic overflow (fifths > +5 or < -5): normalize by mod 12.
    var pc2 = ((fifths * 7) % 12 + 12) % 12;
    return pc2;
  }
  function pcFromFifthsMinor(fifths) {
    for (var pc = 0; pc < 12; pc++)
      if (MINOR_FIFTHS_BY_PC[pc] === fifths) return pc;
    var pc2 = ((fifths * 7 + 9) % 12 + 12) % 12;
    return pc2;
  }

  // Prefer flats when the transposed key would carry >6 sharps → use the flat
  // enharmonic. Prefer sharps for the mirror case. This mirrors the family's
  // Bb·C#·Eb·F#·Ab default: transposition into flat keys stays flat, into
  // sharp keys stays sharp.
  function transposeFifths(fifths, mode, semitones, preferOverride) {
    var srcPc = mode === 'minor' ? pcFromFifthsMinor(fifths) : pcFromFifthsMajor(fifths);
    var newPc = ((srcPc + normSemis(semitones)) % 12 + 12) % 12;
    if (mode === 'minor') return { fifths: MINOR_FIFTHS_BY_PC[newPc], mode: 'minor' };
    return { fifths: MAJOR_FIFTHS_BY_PC[newPc], mode: mode || 'major' };
    // `preferOverride` reserved for future — the family-default spelling covers
    // all common transposition targets without ambiguity.
    /* eslint-disable-next-line no-unused-vars */
    void preferOverride;
  }

  // ── MusicXML transformation ───────────────────────────────────────────────
  // Regex-based; touches only pitch-carrying elements. Byte-identical for
  // semitones=0 unless a clef override is requested (trombone: G→F clef).
  function transposeMusicXml(xml, semitones, opts) {
    if (typeof xml !== 'string' || !xml.length) return xml || '';
    opts = opts || {};
    var semis = normSemis(semitones);
    var prefer = opts.prefer || null;
    var partName = opts.partName || null;
    var newClef = opts.clef || null; // 'treble' | 'bass'

    var out = xml;

    // 1. <key><fifths>N</fifths>[<mode>M</mode>]</key>
    out = out.replace(/<key>([\s\S]*?)<\/key>/g, function (_m, inner) {
      var fm = inner.match(/<fifths>(-?\d+)<\/fifths>/);
      if (!fm) return '<key>' + inner + '</key>';
      var mm = inner.match(/<mode>([a-zA-Z]+)<\/mode>/);
      var mode = mm ? mm[1].toLowerCase() : 'major';
      var t = transposeFifths(parseInt(fm[1], 10), mode, semis, prefer);
      var modeXml = mm ? '<mode>' + mode + '</mode>' : '';
      return '<key><fifths>' + t.fifths + '</fifths>' + modeXml + '</key>';
    });

    // 2. <pitch><step>X</step>[<alter>N</alter>]<octave>M</octave></pitch>
    out = out.replace(/<pitch>\s*<step>([A-Ga-g])<\/step>\s*(?:<alter>(-?\d+)<\/alter>\s*)?<octave>(-?\d+)<\/octave>\s*<\/pitch>/g,
      function (_m, step, alter, octave) {
        var t = transposePitchXml(step, alter ? parseInt(alter, 10) : 0, parseInt(octave, 10), semis, prefer);
        var alterXml = t.alter !== 0 ? '<alter>' + t.alter + '</alter>' : '';
        return '<pitch><step>' + t.step + '</step>' + alterXml + '<octave>' + t.octave + '</octave></pitch>';
      });

    // 3. <harmony>...<root>...</root>[<bass>...</bass>]...</harmony>
    out = out.replace(/<root>\s*<root-step>([A-G])<\/root-step>\s*(?:<root-alter>(-?\d+)<\/root-alter>\s*)?<\/root>/g,
      function (_m, step, alter) {
        var t = transposeHarmonyStep(step, alter ? parseInt(alter, 10) : 0, semis, prefer);
        var alterXml = t.alter !== 0 ? '<root-alter>' + t.alter + '</root-alter>' : '';
        return '<root><root-step>' + t.step + '</root-step>' + alterXml + '</root>';
      });
    out = out.replace(/<bass>\s*<bass-step>([A-G])<\/bass-step>\s*(?:<bass-alter>(-?\d+)<\/bass-alter>\s*)?<\/bass>/g,
      function (_m, step, alter) {
        var t = transposeHarmonyStep(step, alter ? parseInt(alter, 10) : 0, semis, prefer);
        var alterXml = t.alter !== 0 ? '<bass-alter>' + t.alter + '</bass-alter>' : '';
        return '<bass><bass-step>' + t.step + '</bass-step>' + alterXml + '</bass>';
      });

    // 4. Optional clef rewrite (trombone / tuba / bass-clef targets).
    if (newClef === 'bass') {
      out = out.replace(/<clef>\s*<sign>[A-Z]<\/sign>\s*<line>\d+<\/line>\s*<\/clef>/g,
        '<clef><sign>F</sign><line>4</line></clef>');
      // Slash noteheads emitted by the app sit at B4 (middle line of the treble
      // staff). In bass clef, B4 is FIVE ledger lines above the staff — many
      // notation apps refuse to render it in bass clef and silently keep the
      // treble clef, which is what the user sees. Slash-notehead pitch is purely
      // presentational (chord roots live in <harmony>), so drop the pitch to D3
      // (middle line of the bass staff) whenever the target is bass clef.
      out = out.replace(/<note>([\s\S]*?)<\/note>/g, function (m, inner) {
        if (!/<notehead>\s*slash\s*<\/notehead>/.test(inner)) return m;
        return '<note>' + inner.replace(
          /<pitch>[\s\S]*?<\/pitch>/,
          '<pitch><step>D</step><octave>3</octave></pitch>'
        ) + '</note>';
      });
    } else if (newClef === 'treble') {
      out = out.replace(/<clef>\s*<sign>[A-Z]<\/sign>\s*<line>\d+<\/line>\s*<\/clef>/g,
        '<clef><sign>G</sign><line>2</line></clef>');
    }

    // 5. Optional <part-name> override (used when emitting a single-part XML
    // for an individual instrument — e.g. "B♭ Trumpet" in place of the
    // generic "Rhythm Guitar" the CSMPN exporter uses).
    if (partName) {
      out = out.replace(/<part-name>[\s\S]*?<\/part-name>/,
        '<part-name>' + xmlEscape(partName) + '</part-name>');
    }

    return out;
  }

  // Harmony steps have no octave — return `{step, alter}` only.
  function transposeHarmonyStep(step, alter, semitones, prefer) {
    var pc = STEP_TO_PC[String(step).toUpperCase()];
    if (pc === undefined) return { step: step, alter: alter };
    var newPc = ((pc + Number(alter || 0) + normSemis(semitones)) % 12 + 12) % 12;
    return pcToStepAlter(newPc, prefer);
  }

  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Full-score assembly ───────────────────────────────────────────────────
  // Extract each `<measure>...</measure>` block from a score-partwise XML.
  // Returns an array of measure-body strings (without the surrounding <measure>
  // tag) preserving order.
  function extractMeasures(xml) {
    var out = [];
    var re = /<measure\b([^>]*)>([\s\S]*?)<\/measure>/g;
    var m;
    while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1], body: m[2] });
    return out;
  }

  // Build a multi-part `score-partwise` from an array of per-part inputs:
  //   parts = [{ id, name, measures:[{attrs, body}], midiProgram }]
  // Score meta (title, composer) comes from `meta`.
  function assemblePartwiseScore(parts, meta) {
    meta = meta || {};
    var title = meta.title || 'Untitled';
    var composer = meta.composer || '';

    // Every part must have the same measure count; align to the shortest so a
    // pathological mismatched input can't emit malformed XML.
    var barCount = 0;
    for (var i = 0; i < parts.length; i++) {
      var n = parts[i].measures.length;
      if (i === 0 || n < barCount) barCount = n;
    }
    if (!parts.length || !barCount) {
      return '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><part-list/></score-partwise>';
    }

    var partListXml = '';
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi];
      partListXml += '\n    <score-part id="' + xmlEscape(p.id) + '"><part-name>' + xmlEscape(p.name) + '</part-name>';
      if (p.midiProgram != null) {
        partListXml += '<score-instrument id="' + xmlEscape(p.id) + '-I"><instrument-name>' + xmlEscape(p.name) + '</instrument-name></score-instrument>';
        partListXml += '<midi-instrument id="' + xmlEscape(p.id) + '-I"><midi-program>' + Math.max(1, Math.min(128, Math.round(p.midiProgram + 1))) + '</midi-program></midi-instrument>';
      }
      partListXml += '</score-part>';
    }

    var partsXml = '';
    for (var pk = 0; pk < parts.length; pk++) {
      var pp = parts[pk];
      partsXml += '\n  <part id="' + xmlEscape(pp.id) + '">';
      for (var bi = 0; bi < barCount; bi++) {
        var mb = pp.measures[bi];
        partsXml += '\n    <measure' + (mb.attrs || '') + '>' + mb.body + '\n    </measure>';
      }
      partsXml += '\n  </part>';
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
      '<score-partwise version="4.0">\n' +
      '  <movement-title>' + xmlEscape(title) + '</movement-title>' +
      (composer ? '\n  <identification><creator type="composer">' + xmlEscape(composer) + '</creator></identification>' : '') +
      '\n  <part-list>' + partListXml + '\n  </part-list>' +
      partsXml + '\n</score-partwise>';
  }

  // Top-level: build brass-section outputs from ONE concert-pitch MusicXML.
  //   sourceXml — score-partwise MusicXML (one part; typically the app's
  //               `hrBuildMusicXml` / `csmlToMusicXml` output).
  //   instrumentIds — array of INSTRUMENTS ids.
  //   opts — { mode: 'parts'|'score', prefer, title, composer }.
  // Returns:
  //   mode='parts' → { parts: [{ id, name, filename, xml }] }
  //   mode='score' → { score: '<xml>', filename }
  function buildBrassMusicXml(sourceXml, instrumentIds, opts) {
    opts = opts || {};
    var mode = opts.mode === 'score' ? 'score' : 'parts';
    var ids = Array.isArray(instrumentIds) ? instrumentIds : [];
    var picked = [];
    for (var i = 0; i < ids.length; i++) {
      var inst = getInstrument(ids[i]);
      if (inst) picked.push(inst);
    }
    if (!picked.length) return mode === 'score' ? { score: '', filename: 'brass-section.xml' } : { parts: [] };

    var perPartXml = picked.map(function (inst) {
      return {
        inst: inst,
        xml: transposeMusicXml(sourceXml, inst.transposeSemitones, {
          prefer: opts.prefer || null,
          partName: inst.name,
          clef: inst.clef,
        }),
      };
    });

    if (mode === 'parts') {
      return {
        parts: perPartXml.map(function (p) {
          return {
            id: p.inst.id,
            name: p.inst.name,
            filename: safeFilename(opts.title || 'part', p.inst.name) + '.xml',
            xml: p.xml,
          };
        }),
      };
    }

    // Full score: pull each part's measures out of its transposed XML and
    // interleave them under one <part-list>.
    var assemblyParts = perPartXml.map(function (p) {
      return {
        id: p.inst.id,
        name: p.inst.name,
        midiProgram: p.inst.midiProgram,
        measures: extractMeasures(p.xml),
      };
    });
    var score = assemblePartwiseScore(assemblyParts, {
      title: opts.title || 'Brass Section',
      composer: opts.composer || '',
    });
    return { score: score, filename: safeFilename(opts.title || 'brass-section', '') + '.xml' };
  }

  function safeFilename(base, suffix) {
    var name = String(base || 'part').replace(/[^A-Za-z0-9._\- ]+/g, '').trim();
    if (!name) name = 'part';
    if (suffix) name += '-' + String(suffix).replace(/[^A-Za-z0-9._\- ]+/g, '').trim();
    return name;
  }

  // ── ABC transposition ─────────────────────────────────────────────────────
  // Transpose an ABC tune body by `semitones`. Adjusts:
  //   • K:<key>         → transposed key (family-default spelling)
  //   • note letters    → transposed pitch (with `,`/`'` octave markers)
  //   • chord "..."     → transposed chord symbol
  //   • [V:...] clef    → overridden if `opts.clef` is supplied
  //   • %%MIDI transpose N → removed (we bake the shift into the letters)
  function transposeAbc(abc, semitones, opts) {
    if (typeof abc !== 'string' || !abc.length) return abc || '';
    opts = opts || {};
    var semis = normSemis(semitones);
    var prefer = opts.prefer || null;

    var lines = abc.split(/\r?\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (/^%%MIDI\s+transpose\s+-?\d+/i.test(line)) continue;

      if (/^K:/.test(line)) {
        out.push(transposeAbcKeyLine(line, semis, prefer));
        continue;
      }
      if (/^V:/.test(line) && opts.clef) {
        out.push(setAbcVoiceClef(line, opts.clef));
        continue;
      }
      // Header lines like X:, T:, M:, L:, C: — passthrough.
      if (/^[A-Za-z]:/.test(line) && !/^[Kk]:/.test(line)) {
        out.push(line);
        continue;
      }
      // Body: transpose chord annotations then note letters.
      var t = transposeAbcBodyLine(line, semis, prefer);
      out.push(t);
    }

    // If a clef override was requested AND the tune has no V: header, inject one.
    if (opts.clef && !/^V:/m.test(abc)) {
      // Insert after K: line if present.
      for (var j = 0; j < out.length; j++) {
        if (/^K:/.test(out[j])) {
          out.splice(j + 1, 0, 'V:1 clef=' + (opts.clef === 'bass' ? 'bass' : 'treble'));
          break;
        }
      }
    }

    return out.join('\n');
  }

  function transposeAbcKeyLine(line, semis, prefer) {
    // K:Cmaj, K:Am, K:Bb, K:F# minor, K:G  Bassoon = clef=bass
    var m = line.match(/^K:\s*([A-G])([b#]?)(m|min|minor|maj|major|dor|dorian|mix|mixolydian|phr|phrygian|lyd|lydian|loc|locrian|aeol|aeolian|ion|ionian)?\s*(.*)$/i);
    if (!m) return line;
    var step = m[1].toUpperCase();
    var acc = m[2] || '';
    var modeRaw = (m[3] || '').toLowerCase();
    var tail = m[4] || '';
    var pc = STEP_TO_PC[step] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
    var newPc = ((pc + semis) % 12 + 12) % 12;
    var isMinor = /^m(in|inor)?$/.test(modeRaw) || /^aeol/i.test(modeRaw);
    var sa = pcToStepAlter(newPc, prefer);
    var accOut = sa.alter === 1 ? '#' : sa.alter === -1 ? 'b' : '';
    var modeOut = isMinor ? 'm' : (modeRaw && !/^(maj|major|ion|ionian)$/.test(modeRaw) ? modeRaw : '');
    return 'K:' + sa.step + accOut + modeOut + (tail ? ' ' + tail : '');
  }

  function setAbcVoiceClef(line, clef) {
    if (/clef\s*=/i.test(line)) return line.replace(/clef\s*=\s*\S+/i, 'clef=' + (clef === 'bass' ? 'bass' : 'treble'));
    return line + ' clef=' + (clef === 'bass' ? 'bass' : 'treble');
  }

  // Transpose an ABC body line — walk segment-by-segment so `"..."` (chord or
  // text annotations) and note letters never cross-contaminate. Bar lines,
  // rhythms, and ornaments outside quotes pass through untouched.
  function transposeAbcBodyLine(line, semis, prefer) {
    if (!semis) return line;
    var out = '';
    var i = 0;
    while (i < line.length) {
      var ch = line[i];
      if (ch === '"') {
        var end = line.indexOf('"', i + 1);
        if (end < 0) { out += line.slice(i); break; }
        var inner = line.slice(i + 1, end);
        // Text annotations (^ centre, _ below, > right, < left, @ absolute)
        // stay verbatim; chord annotations are transposed as chord tokens.
        if (/^[\^_<>@]/.test(inner)) out += '"' + inner + '"';
        else out += '"' + transposeChordText(inner, semis, prefer) + '"';
        i = end + 1;
        continue;
      }
      if (ch === '!') {
        // ABC decoration/dynamic like `!accent!` — skip through the closing '!'.
        var e2 = line.indexOf('!', i + 1);
        if (e2 < 0) { out += line.slice(i); break; }
        out += line.slice(i, e2 + 1);
        i = e2 + 1;
        continue;
      }
      // Try to consume an ABC pitch token here: (^|^^|_|__|=)?[A-Ga-g][,']*
      var pm = /^(\^{1,2}|_{1,2}|=)?([A-Ga-g])([,']*)/.exec(line.slice(i));
      if (pm) {
        out += spellAbcNote(pm[1] || '', pm[2], pm[3] || '', semis, prefer);
        i += pm[0].length;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // Convert an ABC note (accidental + letter + octave markers) to MIDI, add
  // semitones, spell back into ABC. Family-default spelling applies to the
  // transposed accidental unless `prefer` overrides.
  function spellAbcNote(acc, letter, octMarks, semis, prefer) {
    var isUpper = letter >= 'A' && letter <= 'G';
    var step = letter.toUpperCase();
    var basePc = STEP_TO_PC[step];
    if (basePc === undefined) return acc + letter + octMarks;

    // ABC octave: uppercase A..G = octave 4 (middle-C = C), each comma −1,
    // lowercase a..g = octave 5, each apostrophe +1.
    var octave = isUpper ? 4 : 5;
    for (var i = 0; i < octMarks.length; i++) octave += octMarks[i] === ',' ? -1 : 1;

    var accSemi = 0;
    if (acc === '^') accSemi = 1;
    else if (acc === '^^') accSemi = 2;
    else if (acc === '_') accSemi = -1;
    else if (acc === '__') accSemi = -2;
    // '=' natural is +0.

    var midi = octave * 12 + basePc + accSemi + normSemis(semis);
    var newOct = Math.floor(midi / 12);
    var newPc = ((midi % 12) + 12) % 12;
    var sa = pcToStepAlter(newPc, prefer);

    var outAcc = sa.alter === 1 ? '^' : sa.alter === -1 ? '_' : (acc === '=' ? '=' : '');
    var outLetter, outOctMarks;
    if (newOct >= 5) {
      outLetter = sa.step.toLowerCase();
      outOctMarks = new Array(Math.max(0, newOct - 5) + 1).join("'");
    } else {
      outLetter = sa.step;
      outOctMarks = new Array(Math.max(0, 4 - newOct) + 1).join(',');
    }
    return outAcc + outLetter + outOctMarks;
  }

  // Transpose a chord-symbol text ("Cmaj7", "Bb7/D") by `semitones`. Family
  // spelling default. Preserves quality suffix and slash-bass shape.
  function transposeChordText(text, semis, prefer) {
    var m = String(text).match(/^([A-G])([b#]?)(.*)$/);
    if (!m) return text;
    var pc = STEP_TO_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    var newPc = ((pc + normSemis(semis)) % 12 + 12) % 12;
    var sa = pcToStepAlter(newPc, prefer);
    var accOut = sa.alter === 1 ? '#' : sa.alter === -1 ? 'b' : '';
    var rest = m[3] || '';
    // Slash bass — recurse on the tail after '/'.
    var sm = rest.match(/^(.*?)\/([A-G])([b#]?)(.*)$/);
    if (sm) {
      var bassPc = STEP_TO_PC[sm[2]] + (sm[3] === '#' ? 1 : sm[3] === 'b' ? -1 : 0);
      var newBassPc = ((bassPc + normSemis(semis)) % 12 + 12) % 12;
      var bsa = pcToStepAlter(newBassPc, prefer);
      var bassAccOut = bsa.alter === 1 ? '#' : bsa.alter === -1 ? 'b' : '';
      rest = sm[1] + '/' + bsa.step + bassAccOut + (sm[4] || '');
    }
    return sa.step + accOut + rest;
  }

  // Build brass ABC outputs from ONE concert-pitch ABC tune.
  //   sourceAbc — the concert ABC.
  //   instrumentIds — array of INSTRUMENTS ids.
  //   opts — { prefer, title }.
  // Returns { parts: [{ id, name, filename, abc, midiProgram, transposeSemitones }] }.
  function buildBrassAbc(sourceAbc, instrumentIds, opts) {
    opts = opts || {};
    var ids = Array.isArray(instrumentIds) ? instrumentIds : [];
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var inst = getInstrument(ids[i]);
      if (!inst) continue;
      var abc = transposeAbc(sourceAbc, inst.transposeSemitones, {
        prefer: opts.prefer || null,
        clef: inst.clef,
      });
      // Inject a MIDI program hint for playback previews (respected by abcjs).
      if (!/^%%MIDI\s+program\s+/im.test(abc) && inst.midiProgram != null) {
        abc = abc.replace(/(\nK:[^\n]*\n)/, '$1%%MIDI program ' + inst.midiProgram + '\n');
      }
      parts.push({
        id: inst.id,
        name: inst.name,
        filename: safeFilename(opts.title || 'part', inst.name) + '.abc',
        abc: abc,
        midiProgram: inst.midiProgram,
        transposeSemitones: inst.transposeSemitones,
      });
    }
    return { parts: parts };
  }

  var API = {
    INSTRUMENTS: INSTRUMENTS,
    getInstrument: getInstrument,
    transposeMusicXml: transposeMusicXml,
    transposeAbc: transposeAbc,
    transposeChordText: transposeChordText,
    transposePitchXml: transposePitchXml,
    transposeFifths: transposeFifths,
    buildBrassMusicXml: buildBrassMusicXml,
    buildBrassAbc: buildBrassAbc,
    assemblePartwiseScore: assemblePartwiseScore,
    extractMeasures: extractMeasures,
    // Low-level helpers exposed for tests + composability.
    _pcToStepAlter: pcToStepAlter,
    _pcFromFifthsMajor: pcFromFifthsMajor,
    _pcFromFifthsMinor: pcFromFifthsMinor,
    _spellAbcNote: spellAbcNote,
  };

  if (typeof window !== 'undefined') window.BrassTranspose = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
