/*
 * sheetOcr.js — pure core for the Sheet Music Chord OCR importer
 * (sheet-ocr-importer.html).
 *
 * Everything in this file is DOM-free and canvas-free: functions operate on
 * plain grayscale pixel buffers ({ data, width, height }) and strings, so the
 * whole pipeline below the browser glue (canvas decode + Tesseract.js) is
 * unit-testable in Node via vm (same pattern as chordsheetPdf.js /
 * chordTheory.js).
 *
 * Pipeline (see sheet-ocr-importer.html for the browser orchestration):
 *   1. grayFromRgba        RGBA ImageData -> Uint8 grayscale
 *   2. otsuThreshold       histogram -> ink/paper threshold (fade-adaptive)
 *   3. cropContentBounds   trim letterbox bands + margins to the page area
 *   4. estimateSkew        shear-scored projection -> small skew angle
 *   5. rowInkProfile       dark-pixel count per row (optionally sheared)
 *   6. detectStaffLines    profile peaks -> staff-line center rows
 *   7. groupStaves         line centers -> 5-line staves (spacing regularity)
 *   8. groupSystems        staves -> systems (grand staff / vocal+piano merge)
 *   9. chordStripBands     band above each system's TOP staff (chord text)
 *  10. OCR (browser)       Tesseract word boxes from each band
 *  11. normalizeOcrChord   confusion repair + chord grammar filter
 *  12. buildTimeline       x positions -> {chord, measure, beat, staffIndex}
 *  13. timelineToCsmpn     timeline -> CSMPN chart (family lingua franca)
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1-2. Grayscale + adaptive (Otsu) threshold
   * ------------------------------------------------------------------ */

  // RGBA byte array -> Uint8ClampedArray of luma values (Rec.601 weights).
  function grayFromRgba(rgba, width, height) {
    var n = width * height;
    var out = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      out[i] = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
    }
    return out;
  }

  // Histogram, optionally restricted to a crop box. Restricting matters:
  // letterboxed screenshots carry huge pure-black bands that would dominate
  // a whole-image histogram and drag Otsu's split down to black-vs-page
  // instead of ink-vs-paper (found on the Minute by Minute fixtures: global
  // Otsu said 109 while the soft anti-aliased staff lines live at ~140-180).
  function buildHistogram(gray, width, bounds) {
    var hist = new Array(256).fill(0);
    if (!bounds) {
      for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
      return hist;
    }
    for (var y = bounds.y0; y < bounds.y1; y++) {
      var base = y * width;
      for (var x = bounds.x0; x < bounds.x1; x++) hist[gray[base + x]]++;
    }
    return hist;
  }

  // Otsu's method: pick the threshold that maximizes between-class variance.
  // Handles faded scans / tinted paper (this corpus is cream-colored stock)
  // far better than a fixed cutoff.
  function otsuThreshold(hist) {
    var total = 0;
    var sum = 0;
    for (var t = 0; t < 256; t++) {
      total += hist[t];
      sum += t * hist[t];
    }
    if (!total) return 128;
    var sumB = 0;
    var wB = 0;
    var best = 128;
    var bestVar = -1;
    for (var i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) {
        bestVar = between;
        best = i;
      }
    }
    // best is the last bin of the ink class; return the exclusive boundary
    // so callers can test `pixel < thresh` (ink at exactly the mode level
    // still counts as ink).
    return best + 1;
  }

  /* ------------------------------------------------------------------ *
   * 3. Content crop — phone screenshots arrive letterboxed in black and
   *    the page itself has white/cream margins. Detection must run on the
   *    page area only: the black bands would otherwise dominate every
   *    dark-pixel projection.
   * ------------------------------------------------------------------ */

  function cropContentBounds(gray, width, height, opts) {
    opts = opts || {};
    // A row/col belongs to the page when its mean brightness is "paper-like".
    // Black letterbox rows have mean ~0-40; paper rows are typically > 120.
    var minMean = opts.minMean != null ? opts.minMean : 80;
    var rowMean = function (y) {
      var s = 0;
      var base = y * width;
      // stride 4 keeps this O(w/4) per row — plenty for a mean estimate
      for (var x = 0; x < width; x += 4) s += gray[base + x];
      return s / Math.ceil(width / 4);
    };
    var colMean = function (x, y0, y1) {
      var s = 0;
      var count = 0;
      for (var y = y0; y < y1; y += 4) {
        s += gray[y * width + x];
        count++;
      }
      return count ? s / count : 0;
    };
    var y0 = 0;
    var y1 = height;
    while (y0 < height && rowMean(y0) < minMean) y0++;
    while (y1 > y0 && rowMean(y1 - 1) < minMean) y1--;
    var x0 = 0;
    var x1 = width;
    while (x0 < width && colMean(x0, y0, y1) < minMean) x0++;
    while (x1 > x0 && colMean(x1 - 1, y0, y1) < minMean) x1--;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* ------------------------------------------------------------------ *
   * 4-5. Row ink profile (with optional shear for deskew)
   * ------------------------------------------------------------------ */

  // Count of ink (dark) pixels per row inside the crop box. `shear` is a
  // tangent value: pixel (x,y) contributes to row y + shear*(x - cx), which
  // straightens a slightly rotated staff without resampling the image.
  function rowInkProfile(gray, width, bounds, thresh, shear) {
    shear = shear || 0;
    var x0 = bounds.x0;
    var x1 = bounds.x1;
    var y0 = bounds.y0;
    var y1 = bounds.y1;
    var rows = y1 - y0;
    var profile = new Float64Array(rows > 0 ? rows : 0);
    var cx = (x0 + x1) / 2;
    for (var y = y0; y < y1; y++) {
      var base = y * width;
      for (var x = x0; x < x1; x += 2) {
        if (gray[base + x] < thresh) {
          var ry = Math.round(y + shear * (x - cx)) - y0;
          if (ry >= 0 && ry < rows) profile[ry] += 2; // stride-2 compensation
        }
      }
    }
    return profile;
  }

  // Long-run row profile: per row, the total length of dark RUNS that are at
  // least `minRun` px long (small gaps <= gapBridge px are bridged so an
  // anti-aliased faint line still counts as one run). This is the same
  // insight as ugProPdfImporter's longestDarkRun, applied per row: a staff
  // line is a very long horizontal run; text, lyrics, noteheads and even
  // beams never sustain runs like that. It separates faint staff lines
  // (weak raw ink counts) from dense notation rows (strong raw counts but
  // only short runs) — which a plain dark-pixel count provably cannot do on
  // the fixture corpus.
  function rowLongRunProfile(gray, width, bounds, thresh, opts) {
    opts = opts || {};
    // minRun must sit ABOVE the scale of fret-diagram grid lines (~85px on
    // the fixtures), lyric melisma extenders and beams, or those register as
    // phantom staff lines; real staff lines run continuously for hundreds
    // of px, so a high floor costs nothing.
    var minRun = opts.minRun != null ? opts.minRun : 150;
    var gapBridge = opts.gapBridge != null ? opts.gapBridge : 2;
    var x0 = bounds.x0;
    var x1 = bounds.x1;
    var y0 = bounds.y0;
    var y1 = bounds.y1;
    var profile = new Float64Array(y1 - y0 > 0 ? y1 - y0 : 0);
    for (var y = y0; y < y1; y++) {
      var base = y * width;
      var total = 0;
      var runStart = -1;
      var gap = 0;
      for (var x = x0; x <= x1; x++) {
        var dark = x < x1 && gray[base + x] < thresh;
        if (dark) {
          if (runStart < 0) runStart = x;
          gap = 0;
        } else if (runStart >= 0) {
          gap++;
          if (gap > gapBridge || x >= x1) {
            var len = x - gap + 1 - runStart;
            if (len >= minRun) total += len;
            runStart = -1;
            gap = 0;
          }
        }
      }
      profile[y - y0] = total;
    }
    return profile;
  }

  // Sharpness score for a profile: sum of squares rewards tall, narrow peaks.
  // A skewed staff smears its lines across many rows, flattening the peaks,
  // so the shear angle that maximizes this score is the deskew estimate.
  function profileSharpness(profile) {
    var s = 0;
    for (var i = 0; i < profile.length; i++) s += profile[i] * profile[i];
    return s;
  }

  // Try a small set of shear values (±maxShear) and return the best. On the
  // downscaled analysis canvas this is cheap (few hundred ms worst case).
  function estimateSkew(gray, width, bounds, thresh, opts) {
    opts = opts || {};
    var maxShear = opts.maxShear != null ? opts.maxShear : 0.02; // ~1.1 deg
    var steps = opts.steps != null ? opts.steps : 8;
    var best = 0;
    var bestScore = -1;
    for (var i = -steps; i <= steps; i++) {
      var shear = (i / steps) * maxShear;
      var score = profileSharpness(rowInkProfile(gray, width, bounds, thresh, shear));
      if (score > bestScore) {
        bestScore = score;
        best = shear;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 6. Staff-line detection — profile peaks
   * ------------------------------------------------------------------ */

  // Staff lines are near-continuous horizontal runs, so their rows have far
  // more ink than text/notehead rows. A row qualifies when its ink exceeds
  // `lineFrac` of the page width; adjacent qualifying rows merge into one
  // line (scans render a line 2-6 px thick).
  function detectStaffLines(profile, pageWidth, opts) {
    opts = opts || {};
    // Fraction of the page width a row's LONG-RUN total must reach to count
    // as a staff-line row. Long runs are highly selective (see
    // rowLongRunProfile), so this sits low; the 5-evenly-spaced-lines
    // regularity check in groupStaves() is the second fence.
    var lineFrac = opts.lineFrac != null ? opts.lineFrac : 0.2;
    var minInk = pageWidth * lineFrac;
    // A single physical line can split into sibling centers a few px apart
    // when one of its rows dips under the threshold mid-line; merge centers
    // closer than mergeDist (well under any real staff-line gap).
    var mergeDist = opts.mergeDist != null ? opts.mergeDist : 7;
    var centers = [];
    var runStart = -1;
    for (var y = 0; y <= profile.length; y++) {
      var isLine = y < profile.length && profile[y] >= minInk;
      if (isLine && runStart < 0) runStart = y;
      if (!isLine && runStart >= 0) {
        centers.push((runStart + y - 1) / 2);
        runStart = -1;
      }
    }
    var merged = [];
    for (var i = 0; i < centers.length; i++) {
      if (merged.length && centers[i] - merged[merged.length - 1] < mergeDist) {
        merged[merged.length - 1] = (merged[merged.length - 1] + centers[i]) / 2;
      } else {
        merged.push(centers[i]);
      }
    }
    return merged;
  }

  /* ------------------------------------------------------------------ *
   * 7. Staff grouping — runs of 5 evenly spaced lines
   * ------------------------------------------------------------------ */

  // Group line centers into staves by spacing REGULARITY (all gaps within
  // maxGapRatio of each other) — what rejects lyric rows, title underlines
  // and diagram grids: none of those produce evenly spaced full-width line
  // rows. Nominal staves have 5 lines; a 6-line group is accepted as a TAB
  // staff, and a 4-line group is accepted as a staff with one line lost to
  // thresholding (observed on faint fixture staves) — safe because the
  // long-run profile already excludes every non-staff line source.
  function groupStaves(centers, opts) {
    opts = opts || {};
    var maxGapRatio = opts.maxGapRatio != null ? opts.maxGapRatio : 1.45;
    var minGap = opts.minGap != null ? opts.minGap : 3;
    var maxGap = opts.maxGap != null ? opts.maxGap : 80;
    var minLines = opts.minLines != null ? opts.minLines : 4;
    var staves = [];
    var i = 0;
    while (i < centers.length) {
      // Greedily extend a run of consistent gaps starting at line i.
      var run = [centers[i]];
      var gaps = [];
      var j = i + 1;
      while (j < centers.length && run.length < 6) {
        var gap = centers[j] - run[run.length - 1];
        if (gap < minGap || gap > maxGap) break;
        var lo = gap;
        var hi = gap;
        for (var g = 0; g < gaps.length; g++) {
          if (gaps[g] < lo) lo = gaps[g];
          if (gaps[g] > hi) hi = gaps[g];
        }
        if (hi / lo > maxGapRatio) break;
        run.push(centers[j]);
        gaps.push(gap);
        j++;
      }
      if (run.length >= minLines) {
        var top = run[0];
        var bottom = run[run.length - 1];
        var lineGap = (bottom - top) / (run.length - 1);
        staves.push({
          lines: run,
          top: top,
          bottom: bottom,
          gap: lineGap,
          height: bottom - top,
          // Height normalized to a nominal 5-line staff (4 gaps): a staff
          // detected with a missing line must not shrink every
          // staff-height-relative window downstream.
          nominalHeight: lineGap * 4,
        });
        i += run.length;
      } else {
        i++;
      }
    }
    return staves;
  }

  /* ------------------------------------------------------------------ *
   * 8. System grouping — merge staves that belong to one system
   * ------------------------------------------------------------------ */

  // Piano/vocal books print systems of 2-3 staves (vocal + grand staff) with
  // lyrics in the inner gaps. Staves separated by less than
  // `systemGapFactor` x median staff height are merged into one system, so
  // the chord strip is computed above the TOPMOST staff only (chords are
  // never printed between the staves of one system). Tuned against the
  // "Minute by Minute" fixture pages (intra-system gaps ~2.1x staff height,
  // between-system gaps ~3.2x).
  function groupSystems(staves, opts) {
    opts = opts || {};
    var factor = opts.systemGapFactor != null ? opts.systemGapFactor : 2.7;
    if (!staves.length) return [];
    var heights = staves.map(function (s) {
      return s.nominalHeight != null ? s.nominalHeight : s.height;
    });
    heights.sort(function (a, b) {
      return a - b;
    });
    var medianH = heights[Math.floor(heights.length / 2)] || 1;
    var systems = [];
    var cur = null;
    for (var i = 0; i < staves.length; i++) {
      var st = staves[i];
      if (cur && st.top - cur.bottom < factor * medianH) {
        cur.staves.push(st);
        cur.bottom = st.bottom;
      } else {
        cur = { staves: [st], top: st.top, bottom: st.bottom };
        systems.push(cur);
      }
    }
    return systems;
  }

  /* ------------------------------------------------------------------ *
   * 9. Chord strip bands — where the chord names live
   * ------------------------------------------------------------------ */

  // The band ABOVE each system's top staff holds the chord names (and, in
  // songbooks like this corpus, a fret-diagram box under each name plus
  // "3 fr." annotations — all filtered downstream by the chord grammar).
  // The band reaches up to `stripFactor` x staff height above the staff but
  // never into the previous system (prevBottom + pad guard) or above the
  // page content. Chord names sit at the TOP of the name+diagram block, so
  // the band must be generous: ~2x staff height covers name + markers +
  // diagram on the fixtures.
  function chordStripBands(systems, contentTop, opts) {
    opts = opts || {};
    var stripFactor = opts.stripFactor != null ? opts.stripFactor : 2.9;
    var pad = opts.pad != null ? opts.pad : 6;
    var bands = [];
    for (var i = 0; i < systems.length; i++) {
      var sys = systems[i];
      var topStaff = sys.staves[0];
      var staffH = topStaff.nominalHeight || topStaff.height || 1;
      // A staff detected with fewer than 5 lines may have lost its TOP line
      // to thresholding — anchor the band above where the nominal top line
      // would be, or the band swallows the real line + on-staff notation
      // and becomes un-segmentable. (Costs one line-gap of band height when
      // the missing line was actually the bottom one — harmless.)
      var missing = topStaff.lines ? Math.max(0, 5 - topStaff.lines.length) : 0;
      var anchor = sys.top - missing * (topStaff.gap || 0);
      var floor = i > 0 ? systems[i - 1].bottom + pad : contentTop;
      var top = Math.max(floor, anchor - stripFactor * staffH);
      var bottom = anchor - pad;
      if (bottom > top) bands.push({ top: top, bottom: bottom, systemIndex: i });
    }
    return bands;
  }

  /* ------------------------------------------------------------------ *
   * 9b. Text-row clusters inside a chord band
   * ------------------------------------------------------------------ */

  // A chord band in a songbook contains more than chord names: fret-diagram
  // grids under each name, x/o string-marker rows, "3 fr." annotations.
  // Feeding the whole band to Tesseract wrecks its segmentation and DPI
  // estimate (measured on the Minute by Minute fixtures: 35% recall whole-
  // band vs. clean per-row results). This clusters the band's inky rows into
  // separate horizontal text lines so each can be OCR'd alone: the chord-
  // name line comes out clean, and diagram-grid clusters produce rejectable
  // garbage instead of polluting the names.
  function textRowClusters(gray, width, bounds, band, thresh, opts) {
    opts = opts || {};
    var minInkFrac = opts.minInkFrac != null ? opts.minInkFrac : 0.004;
    var maxGapRows = opts.maxGapRows != null ? opts.maxGapRows : 4;
    var x0 = bounds.x0;
    var x1 = bounds.x1;
    var minInk = (x1 - x0) * minInkFrac;
    var top = Math.max(bounds.y0, Math.floor(band.top));
    var bottom = Math.min(bounds.y1, Math.ceil(band.bottom));
    var clusters = [];
    var cur = null;
    var gap = 0;
    for (var y = top; y < bottom; y++) {
      var base = y * width;
      var ink = 0;
      for (var x = x0; x < x1; x += 2) {
        if (gray[base + x] < thresh) ink += 2;
      }
      if (ink >= minInk) {
        if (cur) {
          cur.bottom = y + 1;
        } else {
          cur = { top: y, bottom: y + 1 };
          clusters.push(cur);
        }
        gap = 0;
      } else if (cur) {
        gap++;
        if (gap > maxGapRows) cur = null;
      }
    }
    return clusters;
  }

  /* ------------------------------------------------------------------ *
   * 9c. Word segmentation inside a text row
   * ------------------------------------------------------------------ */

  // Split one text-row cluster into word segments by column whitespace gaps.
  // Chord names in a strip are separated by large gaps (hundreds of px)
  // while letters within one name sit a few px apart, so a fixed-ish gap
  // threshold cleanly isolates each printed token. Each tiny crop is then
  // OCR'd alone as a single word (PSM 8) — measured far more accurate on
  // engraved songbook type than line/sparse OCR of the whole row.
  function wordSegmentsInRow(gray, width, bounds, cluster, thresh, opts) {
    opts = opts || {};
    var minGap = opts.minGap != null ? opts.minGap : 14; // px between words
    var minWidth = opts.minWidth != null ? opts.minWidth : 6; // reject specks
    var x0 = bounds.x0;
    var x1 = bounds.x1;
    var segments = [];
    var runStart = -1;
    var gap = 0;
    for (var x = x0; x <= x1; x++) {
      var ink = false;
      if (x < x1) {
        for (var y = cluster.top; y < cluster.bottom; y++) {
          if (gray[y * width + x] < thresh) {
            ink = true;
            break;
          }
        }
      }
      if (ink) {
        if (runStart < 0) runStart = x;
        gap = 0;
      } else if (runStart >= 0) {
        gap++;
        if (gap >= minGap || x >= x1) {
          var end = x - gap + 1;
          if (end - runStart >= minWidth) segments.push({ x0: runStart, x1: end });
          runStart = -1;
          gap = 0;
        }
      }
    }
    return segments;
  }

  /* ------------------------------------------------------------------ *
   * 9d. Recursive XY-cut — atomic content blocks inside a chord band
   * ------------------------------------------------------------------ */

  // Ink bounding box of a region, or null when the region is empty.
  function inkBBox(gray, width, box, thresh) {
    var minX = box.x1;
    var maxX = box.x0;
    var minY = box.y1;
    var maxY = box.y0;
    for (var y = box.y0; y < box.y1; y++) {
      var base = y * width;
      for (var x = box.x0; x < box.x1; x++) {
        if (gray[base + x] < thresh) {
          if (x < minX) minX = x;
          if (x >= maxX) maxX = x + 1;
          if (y < minY) minY = y;
          if (y >= maxY) maxY = y + 1;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) return null;
    return { x0: minX, x1: maxX, y0: minY, y1: maxY };
  }

  // Split a box along one axis at whitespace gaps >= minGap px. On the row
  // axis, a row whose ink spans nearly the whole box is treated as BLANK:
  // chord-band content (names, markers, diagrams) never fills a full page
  // width, so such a row is staff-line bleed at the band edge — and leaving
  // it "inky" would make the entire band one unsplittable block (observed
  // on the fixtures: the anti-aliased top edge of the staff line leaked
  // into two bands and collapsed each to a single 2000px-wide block).
  function splitBoxOnGaps(gray, width, box, thresh, axis, minGap) {
    var isRow = axis === 'row';
    var lo = isRow ? box.y0 : box.x0;
    var hi = isRow ? box.y1 : box.x1;
    var boxW = box.x1 - box.x0;
    var fullRowCut = boxW * 0.88;
    var parts = [];
    var runStart = -1;
    var gap = 0;
    for (var i = lo; i <= hi; i++) {
      var ink = false;
      if (i < hi) {
        if (isRow) {
          var base = i * width;
          var count = 0;
          for (var x = box.x0; x < box.x1; x++) {
            if (gray[base + x] < thresh) count++;
          }
          ink = count > 0 && count < fullRowCut;
        } else {
          for (var y = box.y0; y < box.y1; y++) {
            if (gray[y * width + i] < thresh) {
              ink = true;
              break;
            }
          }
        }
      }
      if (ink) {
        if (runStart < 0) runStart = i;
        gap = 0;
      } else if (runStart >= 0) {
        gap++;
        if (gap >= minGap || i >= hi) {
          var end = i - gap + 1;
          parts.push(
            isRow
              ? { x0: box.x0, x1: box.x1, y0: runStart, y1: end }
              : { x0: runStart, x1: end, y0: box.y0, y1: box.y1 }
          );
          runStart = -1;
          gap = 0;
        }
      }
    }
    // A row-axis pass that found only full-width (blanked) rows returns
    // nothing; callers treat 0/1 parts as "no split".
    return parts;
  }

  // Recursive XY-cut: alternately split on row and column whitespace until
  // no further cut is possible. This is what separates a crowded chord band
  // — 12 name+diagram blocks in a row on the densest fixture page — into
  // atomic pieces: chord-name text, x/o marker rows, diagram grids, "3 fr."
  // annotations all end up as separate blocks. Names are then selected by
  // text-like height and OCR'd individually (single-word mode); the
  // non-text blocks either fail the height filter or OCR to garbage that
  // the chord grammar rejects.
  function xyCutBlocks(gray, width, box, thresh, opts, axis, depth) {
    opts = opts || {};
    var rowGap = opts.rowGap != null ? opts.rowGap : 5;
    var colGap = opts.colGap != null ? opts.colGap : 14;
    if (axis == null) axis = 'row';
    if (depth == null) depth = 0;
    var tight = inkBBox(gray, width, box, thresh);
    if (!tight) return [];
    if (depth > 8) return [tight];
    var boxArea = function (b) {
      return (b.x1 - b.x0) * (b.y1 - b.y0);
    };
    var first = splitBoxOnGaps(gray, width, tight, thresh, axis, axis === 'row' ? rowGap : colGap);
    var other = axis === 'row' ? 'col' : 'row';
    // A single part SMALLER than the tight box still made progress: the
    // full-width-row guard blanked edge rows (staff-line bleed) out of it,
    // and recursing into the shrunken part lets the column split succeed
    // where the line's ink would otherwise defeat it. Only a single part
    // identical to the input means this axis is truly unsplittable.
    var shrunk = first.length === 1 && boxArea(first[0]) < boxArea(tight);
    if (first.length <= 1 && !shrunk) {
      var second = splitBoxOnGaps(gray, width, tight, thresh, other, other === 'row' ? rowGap : colGap);
      var secondShrunk = second.length === 1 && boxArea(second[0]) < boxArea(tight);
      if (second.length <= 1 && !secondShrunk) return [tight]; // atomic
      first = second;
      other = axis; // recurse flipping back
    }
    var out = [];
    for (var i = 0; i < first.length; i++) {
      var sub = xyCutBlocks(gray, width, first[i], thresh, opts, other, depth + 1);
      for (var j = 0; j < sub.length; j++) out.push(sub[j]);
    }
    return out;
  }

  // Pick the blocks inside a band that look like chord-name text: height in
  // a text-plausible window relative to the system's staff height, sane
  // width, sane aspect. Returned in reading order (top row first, then x).
  //
  // Tall blocks get a second chance: a chord name printed directly above its
  // fret diagram often fuses with it (a slash-chord descender or a crowded
  // layout leaves no whitespace row between them), producing one block the
  // height filter would drop. Since the NAME is always the top of such a
  // block, the top ~half-staff-height slice is emitted as a candidate box
  // (marked topSlice for debugging).
  function chordTextBlocks(blocks, staffH, opts) {
    opts = opts || {};
    var minH = (opts.minHFactor != null ? opts.minHFactor : 0.14) * staffH;
    var maxH = (opts.maxHFactor != null ? opts.maxHFactor : 0.85) * staffH;
    var maxW = (opts.maxWFactor != null ? opts.maxWFactor : 5) * staffH;
    var tallMaxH = (opts.tallMaxHFactor != null ? opts.tallMaxHFactor : 2.8) * staffH;
    var sliceH = (opts.sliceHFactor != null ? opts.sliceHFactor : 0.52) * staffH;
    var picked = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var h = b.y1 - b.y0;
      var w = b.x1 - b.x0;
      if (w > maxW || h < minH) continue;
      if (w < h * 0.25 && h <= maxH) continue; // vertical slivers
      if (h <= maxH) {
        picked.push(b);
      } else if (h <= tallMaxH && w >= staffH * 0.5) {
        picked.push({ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y0 + sliceH, topSlice: true });
      }
    }
    picked.sort(function (a, b) {
      // group into rows by y overlap, then left-to-right
      var vOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (vOverlap > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) return a.x0 - b.x0;
      return a.y0 - b.y0;
    });
    return picked;
  }

  /* ------------------------------------------------------------------ *
   * 10-11. OCR token repair + chord grammar filter
   * ------------------------------------------------------------------ */

  // OCR confusion repairs, applied BEFORE grammar validation. Deliberately
  // conservative: each rule only fires in a position where the repaired
  // character is the only musically plausible reading. This (plus the
  // grammar below) is the real filter — Tesseract's LSTM engine does not
  // reliably honour tessedit_char_whitelist, so whitelisting is treated as
  // best-effort only (see docs/CHORD-EXTRACTION-RISK-ASSESSMENT.md risk 2).
  function repairOcrToken(raw) {
    var t = String(raw || '').trim();
    if (!t) return '';
    // Unicode accidentals / quality glyphs -> ASCII family spelling
    t = t
      .replace(/[♭]/g, 'b') // flat sign
      .replace(/[♯]/g, '#') // sharp sign
      .replace(/[°º˚⁰]/g, 'o') // degree-ish marks -> dim "o"
      .replace(/[Øøϕ]/g, 'o') // slashed-O misreads of dim
      .replace(/[’‘']/g, '') // stray apostrophes
      .replace(/\s+/g, '')
      .replace(/[.,]+$/, ''); // trailing punctuation from crowded print
    // Leading digit misread as a root letter: 6->G, 8->B (common LSTM swaps)
    if (/^[68]/.test(t)) t = (t[0] === '6' ? 'G' : 'B') + t.slice(1);
    // Doubled root letter ("Gg#o7" for "G#o7"): drop the lowercase echo.
    // NEVER when the echo is "b" — that is a flat (Bb7), not a doubled B.
    t = t.replace(/^([A-G])([acdefg])(?=[#b0-9moaidsu(+/-])/, function (all, up, low) {
      return up.toLowerCase() === low ? up : all;
    });
    // Zero standing where dim "o" belongs: F#07 -> F#o7 (only inside suffix)
    t = t.replace(/^([A-G][#b]?)0(?=\d)/, '$1o');
    t = t.replace(/^([A-G][#b]?)O(?=\d|$)/, '$1o');
    // Trailing "4" misread as "d" after sus ("Am7susd" -> "Am7sus4")
    t = t.replace(/susd\b/g, 'sus4');
    // Dropped/misread "m" in maj ("Caj9" -> "Cmaj9", "Craj9" -> "Cmaj9") —
    // the engraved lowercase m thins out or reads as r
    t = t.replace(/^([A-G][#b]?)aj(?=\d)/, '$1maj');
    t = t.replace(/^([A-G][#b]?)raj(?=\d)/, '$1maj');
    // Small-print sharp misread before "dim" ("Fodim7"/"C4dim7"/"F2dim7" ->
    // F#dim7/C#dim7): root + o/2/4 + dim is never a real chord, so the
    // stray glyph can only be a mangled #.
    t = t.replace(/^([A-G])[o24](?=dim)/, '$1#');
    // "m17" is not a chord; it is how this corpus's engraved "m7" misreads
    t = t.replace(/^([A-G][#b]?)m17/, '$1m7');
    // A lone trailing "1" after a quality letter is a misread "7"
    // ("Cmaj1" -> "Cmaj7", "G#o1" -> "G#o7"); 11/13 endings untouched.
    t = t.replace(/([a-z#)])1$/, '$17');
    t = t.replace(/([a-z#)])1(?=\/)/, '$17');
    // Lowercase b that OCR uppercased after an accidental-capable root:
    // "Bb" is fine; "BB7" was almost certainly "Bb7".
    t = t.replace(/^([A-G])B(?=[0-9m]|maj|dim|sus|$)/, '$1b');
    // "rn" -> "m" (the classic OCR confusion), only in the suffix position
    t = t.replace(/^([A-G][#b]?)rn/, '$1m');
    return t;
  }

  // Chord grammar. Root + optional accidental + bounded quality vocabulary +
  // optional slash bass. The quality alternation is intentionally explicit
  // (not "any letters"): this is the fence that keeps lyric fragments, fret
  // annotations ("3 fr."), diagram x/o marker rows and page numbers out of
  // the chart. Kept aligned with the family's normalizeChordSymbol
  // vocabulary (importPipeline.js / ugProPdfUtils.ts).
  var CHORD_QUALITY_RE =
    '(?:maj|min|dim|aug|sus|add|M|m|o|\\+|-|b|#|[0-9]|\\(|\\))*';
  var CHORD_RE = new RegExp(
    '^([A-G])([#b]?)(' + CHORD_QUALITY_RE + ')(?:/([A-G])([#b]?))?$'
  );

  // Words that mean "no chord" in print.
  var NC_RE = /^(N\.?C\.?|NoChord|nochord)$/i;

  // Chord extensions actually used in print. Any digit RUN in a quality must
  // be one of these — this is what rejects OCR inventions like "F373" or
  // "Am17" that the character-class fence alone would accept.
  var VALID_DIGIT_RUNS = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 9: 1, 11: 1, 13: 1, 69: 1 };

  // Validate the quality string beyond the character-class fence: reject
  // things like "bb" runs or all-paren husks that the loose alternation
  // would let through.
  function isPlausibleQuality(q) {
    if (q.length > 10) return false;
    if (/\({2,}|\){2,}/.test(q)) return false;
    if (/^[()]+$/.test(q)) return false;
    // A quality that is ONLY accidentals is a misread ("Cbb", "C#b")
    if (/^[b#]+$/.test(q)) return false;
    var digitRuns = q.match(/\d+/g) || [];
    for (var i = 0; i < digitRuns.length; i++) {
      if (!VALID_DIGIT_RUNS[digitRuns[i]]) return false;
    }
    return true;
  }

  // Full token -> normalized chord string, or null if it is not a chord.
  // Returns family-normalized output: ASCII accidentals, "o" for dim,
  // "N.C." for no-chord. opts.confidence (0-100, Tesseract word confidence)
  // gates the riskiest class of token: a BARE root letter ("A", "E") is a
  // real chord but also the most common surviving misread of diagram noise,
  // so low-confidence bare letters are dropped.
  function normalizeOcrChord(raw, opts) {
    opts = opts || {};
    var t = repairOcrToken(raw);
    if (!t) return null;
    if (NC_RE.test(t)) return 'N.C.';
    var m = CHORD_RE.exec(t);
    if (!m) return null;
    if (!isPlausibleQuality(m[3] || '')) return null;
    var out = m[1] + (m[2] || '') + (m[3] || '');
    // Family alias cleanup (mirrors normalizeChordSymbol's M7 rule)
    out = out.replace(/^([A-G][#b]?)M7/, '$1maj7');
    out = out.replace(/^([A-G][#b]?)min/, '$1m');
    if (m[4]) out += '/' + m[4] + (m[5] || '');
    if (
      out.length <= 2 &&
      !m[4] &&
      opts.confidence != null &&
      opts.confidence < (opts.minBareConfidence != null ? opts.minBareConfidence : 60)
    ) {
      return null;
    }
    return out;
  }

  // Join adjacent OCR words that Tesseract split mid-chord ("F#" + "07",
  // "Cmaj" + "7"). Words are {text, x0, x1, y0, y1}; two words merge when
  // they overlap vertically, the gap is under `maxGapPx`, and ONLY the
  // merged text (not either half... the left half alone may also pass, so
  // the merged candidate must parse while the right half alone must not
  // start a new chord root).
  function mergeSplitChordWords(words, maxGapPx) {
    if (maxGapPx == null) maxGapPx = 18;
    var out = [];
    var i = 0;
    while (i < words.length) {
      var w = words[i];
      if (i + 1 < words.length) {
        var nx = words[i + 1];
        var vOverlap = Math.min(w.y1, nx.y1) - Math.max(w.y0, nx.y0);
        var gap = nx.x0 - w.x1;
        var merged = String(w.text) + String(nx.text);
        if (
          vOverlap > 0 &&
          gap >= -2 &&
          gap <= maxGapPx &&
          !normalizeOcrChord(nx.text) &&
          normalizeOcrChord(merged)
        ) {
          out.push({ text: merged, x0: w.x0, x1: nx.x1, y0: Math.min(w.y0, nx.y0), y1: Math.max(w.y1, nx.y1) });
          i += 2;
          continue;
        }
      }
      out.push(w);
      i++;
    }
    return out;
  }

  // "No chord" is printed as two words; stitch it before per-word filtering.
  function stitchNoChord(words) {
    var out = [];
    var i = 0;
    while (i < words.length) {
      var w = words[i];
      if (
        i + 1 < words.length &&
        /^no$/i.test(String(w.text).trim()) &&
        /^c?hord\.?$/i.test(String(words[i + 1].text).trim())
      ) {
        out.push({ text: 'N.C.', x0: w.x0, x1: words[i + 1].x1, y0: w.y0, y1: w.y1 });
        i += 2;
        continue;
      }
      out.push(w);
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 12. Timeline mapping
   * ------------------------------------------------------------------ */

  // OCR words per strip -> ordered chord events with measure/beat estimates.
  // `systemsChords` is an array (one entry per system) of arrays of
  // {chord, xNorm} where xNorm is the chord's horizontal position 0..1
  // across the page content width. Measure numbers assume a fixed
  // `barsPerSystem` (user-adjustable in the UI — honest v1 approximation;
  // real barline detection is the planned v2). Beat is the position within
  // the estimated measure snapped to `beatsPerBar`.
  function buildTimeline(systemsChords, opts) {
    opts = opts || {};
    var barsPerSystem = opts.barsPerSystem != null ? opts.barsPerSystem : 4;
    var beatsPerBar = opts.beatsPerBar != null ? opts.beatsPerBar : 4;
    var systemOffset = opts.systemOffset != null ? opts.systemOffset : 0;
    var measureOffset = opts.measureOffset != null ? opts.measureOffset : 0;
    var timeline = [];
    for (var s = 0; s < systemsChords.length; s++) {
      var chords = systemsChords[s];
      for (var c = 0; c < chords.length; c++) {
        var xNorm = Math.min(0.999, Math.max(0, chords[c].xNorm));
        var barFloat = xNorm * barsPerSystem;
        var barInSystem = Math.floor(barFloat);
        var beat = Math.floor((barFloat - barInSystem) * beatsPerBar) + 1;
        timeline.push({
          chord: chords[c].chord,
          measure: measureOffset + s * barsPerSystem + barInSystem + 1,
          beat: beat,
          staffIndex: systemOffset + s,
          xNorm: xNorm,
        });
      }
    }
    return timeline;
  }

  /* ------------------------------------------------------------------ *
   * 13. CSMPN emission — one bar per estimated measure
   * ------------------------------------------------------------------ */

  function timelineToCsmpn(timeline, opts) {
    opts = opts || {};
    var barsPerRow = opts.barsPerRow != null ? opts.barsPerRow : 4;
    var title = opts.title || '';
    if (!timeline.length) return '';
    var maxMeasure = 0;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].measure > maxMeasure) maxMeasure = timeline[i].measure;
    }
    // Collect chords per measure (in x order; joined with "_" per CSMPN's
    // multi-chord bar syntax).
    var byMeasure = new Array(maxMeasure + 1);
    for (var t = 0; t < timeline.length; t++) {
      var ev = timeline[t];
      if (!byMeasure[ev.measure]) byMeasure[ev.measure] = [];
      byMeasure[ev.measure].push(ev.chord);
    }
    var bars = [];
    var lastChord = null;
    for (var m = 1; m <= maxMeasure; m++) {
      var list = byMeasure[m];
      if (list && list.length) {
        // De-dup a chord OCR'd twice at the same measure position
        var uniq = [];
        for (var u = 0; u < list.length; u++) {
          if (uniq[uniq.length - 1] !== list[u]) uniq.push(list[u]);
        }
        var token = uniq.join('_');
        bars.push(token);
        lastChord = token;
      } else {
        // Empty measure: simile once a chord is established, honest N.C.
        // before the first chord (mirrors the PDF importer's barToken rule)
        bars.push(lastChord ? '%' : 'N.C.');
      }
    }
    var lines = [];
    if (title) lines.push('Title: ' + title);
    if (opts.time) lines.push('Time: ' + opts.time);
    if (lines.length) lines.push('');
    lines.push('- Chart');
    for (var r = 0; r < bars.length; r += barsPerRow) {
      lines.push('| ' + bars.slice(r, r + barsPerRow).join(' | ') + ' |');
    }
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------------------ *
   * Orchestration helper (pure part of the page pipeline)
   * ------------------------------------------------------------------ */

  // Run steps 2-9 on a grayscale buffer. Returns everything the browser
  // glue needs to crop OCR strips and draw the overlay.
  function analyzePage(gray, width, height, opts) {
    opts = opts || {};
    // Crop FIRST, threshold SECOND: Otsu must see only the page pixels
    // (see buildHistogram note about letterbox bands).
    var bounds = cropContentBounds(gray, width, height, opts);
    if (bounds.x1 - bounds.x0 < width * 0.2 || bounds.y1 - bounds.y0 < height * 0.2) {
      // Crop collapsed (all-dark or all-light input) — treat whole image as page
      bounds = { x0: 0, y0: 0, x1: width, y1: height };
    }
    var hist = buildHistogram(gray, width, bounds);
    var thresh = otsuThreshold(hist);
    var shear = opts.deskew === false ? 0 : estimateSkew(gray, width, bounds, thresh, opts);
    // Staff detection runs on the LONG-RUN profile (skew-tolerant by nature:
    // a tilted line still passes through each row for a long stretch, and
    // adjacent peak rows merge in detectStaffLines). The plain ink profile
    // remains what the deskew estimator scores.
    var profile = rowLongRunProfile(gray, width, bounds, thresh, opts);
    var pageWidth = bounds.x1 - bounds.x0;
    var lines = detectStaffLines(profile, pageWidth, opts).map(function (c) {
      return c + bounds.y0; // back to absolute image rows
    });
    var staves = groupStaves(lines, opts);
    var systems = groupSystems(staves, opts);
    var bands = chordStripBands(systems, bounds.y0, opts);
    return {
      thresh: thresh,
      bounds: bounds,
      shear: shear,
      lineCenters: lines,
      staves: staves,
      systems: systems,
      bands: bands,
    };
  }

  var api = {
    grayFromRgba: grayFromRgba,
    buildHistogram: buildHistogram,
    otsuThreshold: otsuThreshold,
    cropContentBounds: cropContentBounds,
    rowInkProfile: rowInkProfile,
    rowLongRunProfile: rowLongRunProfile,
    profileSharpness: profileSharpness,
    estimateSkew: estimateSkew,
    detectStaffLines: detectStaffLines,
    groupStaves: groupStaves,
    groupSystems: groupSystems,
    chordStripBands: chordStripBands,
    textRowClusters: textRowClusters,
    wordSegmentsInRow: wordSegmentsInRow,
    inkBBox: inkBBox,
    xyCutBlocks: xyCutBlocks,
    chordTextBlocks: chordTextBlocks,
    repairOcrToken: repairOcrToken,
    normalizeOcrChord: normalizeOcrChord,
    mergeSplitChordWords: mergeSplitChordWords,
    stitchNoChord: stitchNoChord,
    buildTimeline: buildTimeline,
    timelineToCsmpn: timelineToCsmpn,
    analyzePage: analyzePage,
  };

  if (typeof window !== 'undefined') window.SheetOcr = api;
  else if (typeof globalThis !== 'undefined') globalThis.SheetOcr = api;
})();
