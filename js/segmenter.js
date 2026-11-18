/*
 * segmenter.js
 * ============
 * Turn a rendered DOM subtree into an ordered list of readable units.
 *
 * The document is flattened into a single text string with a node map, so any
 * character offset can be converted back into a live DOM Range for
 * highlighting. `data-ssml` elements are recorded as offset spans over that
 * flat text and their directives attach to the units they cover.
 *
 * Sentence boundaries come from Intl.Segmenter where available, with a regex
 * fallback. A boundary is never allowed to fall inside an element whose
 * directives reinterpret its whole content (spec-format `sub`, `phoneme`,
 * spec-format `say-as`) — those elements are atomic and stay in one unit,
 * because splitting them would change what is spoken.
 *
 * Produced unit:
 *   {
 *     index:      number,           // position in the unit list
 *     start:      number,           // inclusive flat-text offset
 *     end:        number,           // exclusive flat-text offset
 *     text:       string,           // visible text for the unit
 *     directives: Object,           // merged normalized data-ssml
 *     elements:   Element[],        // data-ssml elements covering this unit
 *     atomic:     boolean,
 *     lang:       string            // nearest lang attribute, or ''
 *   }
 */
(function (root) {
  'use strict';

  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, CAPTION: 1, DD: 1, DIV: 1,
    DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HR: 1, LI: 1, MAIN: 1,
    NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1, TBODY: 1, TD: 1,
    TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1
  };

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1 };

  var SEGMENT_BREAK = '\n';

  // =====================================================================
  // Flatten
  // =====================================================================

  /**
   * Flatten `container` into {text, nodes, ssmlSpans}.
   *   nodes:     [{node, start, end}] for real text nodes, in document order
   *   ssmlSpans: [{el, start, end, parsed, error, warnings, depth, atomic}]
   */
  function flatten(container) {
    var text = '';
    var nodes = [];
    var spanStack = [];
    var ssmlSpans = [];

    var appendSyntheticBreak = function () {
      // Collapse repeated separators; they only exist to stop sentences from
      // running across block boundaries.
      if (text.length && text[text.length - 1] !== SEGMENT_BREAK) {
        text += SEGMENT_BREAK;
      }
    };

    var isHidden = function (el) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.hasAttribute('hidden')) return true;
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      return false;
    };

    var walk = function (node, depth) {
      if (node.nodeType === Node.TEXT_NODE) {
        var raw = node.nodeValue;
        if (!raw) return;
        // Normalize whitespace the way rendering does, so offsets line up with
        // what the reader sees. Preserve a single space for whitespace runs.
        var normalized = raw.replace(/\s+/g, ' ');
        if (normalized === ' ' && (text === '' || /[\s]$/.test(text))) return;
        if (normalized === '') return;

        var start = text.length;
        text += normalized;
        nodes.push({ node: node, start: start, end: text.length, raw: raw, normalized: normalized });
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      var tag = node.tagName;
      if (SKIP_TAGS[tag]) return;
      if (isHidden(node)) return;

      if (tag === 'BR') { appendSyntheticBreak(); return; }

      var isBlock = !!BLOCK_TAGS[tag];
      if (isBlock) appendSyntheticBreak();

      var record = null;
      if (node.hasAttribute && node.hasAttribute('data-ssml')) {
        record = {
          el: node,
          start: text.length,
          end: text.length,
          raw: node.getAttribute('data-ssml'),
          parsed: null,
          error: null,
          warnings: [],
          depth: depth,
          atomic: false
        };
        try {
          record.parsed = root.DataSsmlParser.parse(record.raw);
          record.warnings = root.DataSsmlParser.validate(record.parsed);
          record.atomic = isAtomic(record.parsed);
        } catch (err) {
          record.error = err.message || String(err);
          record.parsed = {};
        }
        spanStack.push(record);
        ssmlSpans.push(record);
      }

      for (var child = node.firstChild; child; child = child.nextSibling) {
        walk(child, depth + 1);
      }

      if (record) {
        record.end = text.length;
        spanStack.pop();
      }

      if (isBlock) appendSyntheticBreak();
    };

    for (var child = container.firstChild; child; child = child.nextSibling) {
      walk(child, 0);
    }

    return { text: text, nodes: nodes, ssmlSpans: ssmlSpans };
  }

  /**
   * True when the element's directives reinterpret its entire content, so the
   * element must not be split across units.
   */
  function isAtomic(parsed) {
    if (!parsed) return false;
    if (parsed.phoneme) return true;
    if (parsed.sub && parsed.sub.some(function (s) { return s.text === null; })) return true;
    if (parsed.say_as && parsed.say_as.some(function (s) { return s.text === null; })) return true;
    return false;
  }

  // =====================================================================
  // Sentence segmentation
  // =====================================================================

  var segmenterCache = {};

  function getIntlSegmenter(locale) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
    if (!(locale in segmenterCache)) {
      try {
        segmenterCache[locale] = new Intl.Segmenter(locale, { granularity: 'sentence' });
      } catch (e) {
        segmenterCache[locale] = null;
      }
    }
    return segmenterCache[locale];
  }

  // Abbreviations that must not end a sentence in the regex fallback.
  var ABBREV = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|e\.g|i\.e|approx|Fig|No|Inc|Ltd|Co|Sept|Oct|Nov|Dec|Jan|Feb|Aug)\.)$/i;

  /** Segment one line of text into [start, end) sentence ranges. */
  function segmentLine(line, offset, locale) {
    var ranges = [];
    var seg = getIntlSegmenter(locale || 'en');

    if (seg) {
      var iter = seg.segment(line);
      for (var part of iter) {
        var s = part.index;
        var e = s + part.segment.length;
        ranges.push([offset + s, offset + e]);
      }
      return ranges;
    }

    // Fallback: split after terminal punctuation followed by whitespace.
    var cursor = 0;
    var re = /[.!?…。！？]+["')\]]*(\s+|$)/g;
    var m;
    while ((m = re.exec(line)) !== null) {
      var endIdx = m.index + m[0].length;
      var candidate = line.slice(cursor, m.index + m[0].replace(/\s+$/, '').length);
      if (ABBREV.test(candidate.trimEnd())) continue;
      ranges.push([offset + cursor, offset + endIdx]);
      cursor = endIdx;
      if (re.lastIndex <= cursor - 1) re.lastIndex = cursor;
    }
    if (cursor < line.length) ranges.push([offset + cursor, offset + line.length]);
    return ranges;
  }

  /** Segment the whole flat text, treating synthetic breaks as hard boundaries. */
  function segmentSentences(text, locale) {
    var ranges = [];
    var pos = 0;

    text.split(SEGMENT_BREAK).forEach(function (line, i, arr) {
      if (line.length) {
        segmentLine(line, pos, locale).forEach(function (r) { ranges.push(r); });
      }
      pos += line.length + (i < arr.length - 1 ? SEGMENT_BREAK.length : 0);
    });

    return ranges;
  }

  // =====================================================================
  // Unit building
  // =====================================================================

  /**
   * Build the readable unit list for a container.
   *
   * @param {Element} container
   * @param {Object} [options] {locale: string, wordGranularity: boolean}
   * @returns {{units: Array, text: string, nodes: Array, ssmlSpans: Array}}
   */
  function build(container, options) {
    options = options || {};
    var locale = options.locale || documentLocale(container) || 'en';

    var flat = flatten(container);
    var ranges = segmentSentences(flat.text, locale);

    // Merge any sentence range that would cut through an atomic span.
    var atomicSpans = flat.ssmlSpans.filter(function (s) {
      return s.atomic && s.end > s.start;
    });

    ranges = mergeAcrossAtomics(ranges, atomicSpans);

    var units = [];
    ranges.forEach(function (r) {
      var start = r[0];
      var end = r[1];
      var slice = flat.text.slice(start, end);

      // Trim whitespace and synthetic breaks off the ends.
      var lead = slice.length - slice.replace(/^[\s ]+/, '').length;
      var trail = slice.length - slice.replace(/[\s ]+$/, '').length;
      start += lead;
      end -= trail;
      if (end <= start) return;

      var unitText = flat.text.slice(start, end);
      if (!/[\p{L}\p{N}]/u.test(unitText)) return;  // nothing speakable

      // Elements covering this unit, outermost first. Each one becomes a scope
      // clamped to the unit, because a directive applies to the text of *its
      // own element* — never to the whole sentence that contains it.
      var covering = flat.ssmlSpans.filter(function (span) {
        return (span.start < end && span.end > start) ||
          (span.start === span.end && span.start >= start && span.start <= end);
      }).sort(function (a, b) { return a.depth - b.depth; });

      var scopes = covering.map(function (span) {
        var s = Math.max(span.start, start);
        var e = Math.min(span.end, end);
        return {
          span: span,
          parsed: span.parsed,
          depth: span.depth,
          // Unit-relative bounds, which is what the emulator and composer use.
          start: s - start,
          end: e - start,
          text: flat.text.slice(s, e),
          // A trailing break belongs at the element's real end, so suppress it
          // when this unit only holds part of the element.
          clampedLeft: span.start < start,
          clampedRight: span.end > end
        };
      });

      units.push({
        index: units.length,
        start: start,
        end: end,
        text: unitText,
        scopes: scopes,
        // A merged view, for display and for "does this unit have directives".
        directives: root.DataSsmlParser.mergeDirectives(
          covering.map(function (s) { return s.parsed; })
        ),
        elements: covering,
        // Only flag the unit atomic when a whole-content directive covers all
        // of it — that is the case where sentence splitting had to be held off.
        atomic: covering.some(function (s) {
          return s.atomic && s.start <= start && s.end >= end;
        }),
        lang: nearestLang(covering, container) || locale
      });
    });

    return { units: units, text: flat.text, nodes: flat.nodes, ssmlSpans: flat.ssmlSpans };
  }

  function mergeAcrossAtomics(ranges, atomicSpans) {
    if (!atomicSpans.length) return ranges;

    var out = ranges.slice();
    atomicSpans.forEach(function (span) {
      var first = -1;
      var last = -1;
      for (var i = 0; i < out.length; i++) {
        if (out[i][1] > span.start && out[i][0] < span.end) {
          if (first === -1) first = i;
          last = i;
        }
      }
      if (first !== -1 && last > first) {
        var merged = [out[first][0], out[last][1]];
        out.splice(first, last - first + 1, merged);
      }
    });
    return out;
  }

  function nearestLang(covering, container) {
    for (var i = covering.length - 1; i >= 0; i--) {
      var el = covering[i].el;
      while (el && el !== container.parentNode) {
        if (el.lang) return el.lang;
        el = el.parentElement;
      }
    }
    return container.lang || '';
  }

  function documentLocale(container) {
    var el = container;
    while (el) {
      if (el.lang) return el.lang;
      el = el.parentElement;
    }
    return document.documentElement.lang || '';
  }

  // =====================================================================
  // Offset -> DOM Range
  // =====================================================================

  /** Find the node-map entry containing `offset` (binary search). */
  function findNode(nodes, offset, preferEnd) {
    var lo = 0;
    var hi = nodes.length - 1;
    var best = null;

    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var n = nodes[mid];
      if (offset < n.start) {
        hi = mid - 1;
      } else if (offset > n.end || (offset === n.end && !preferEnd && offset !== n.start)) {
        best = n;
        lo = mid + 1;
      } else {
        return n;
      }
    }
    return best || nodes[Math.min(nodes.length - 1, Math.max(0, lo))] || null;
  }

  /**
   * Map a flat-text offset to a position inside its DOM text node, accounting
   * for the whitespace normalization applied during flattening.
   */
  function nodeOffsetFor(entry, offset) {
    var local = Math.max(0, Math.min(offset - entry.start, entry.normalized.length));
    if (entry.raw === entry.normalized) return local;

    // Walk the raw text, counting normalized characters produced.
    var produced = 0;
    var i = 0;
    while (i < entry.raw.length && produced < local) {
      if (/\s/.test(entry.raw[i])) {
        // A whitespace run collapses to one normalized character.
        var j = i;
        while (j < entry.raw.length && /\s/.test(entry.raw[j])) j++;
        produced += 1;
        i = j;
      } else {
        produced += 1;
        i += 1;
      }
    }
    return Math.min(i, entry.raw.length);
  }

  /** Build a DOM Range spanning flat-text [start, end). Returns null if empty. */
  function rangeFor(nodes, start, end) {
    if (!nodes.length || end <= start) return null;

    var startEntry = findNode(nodes, start, false);
    var endEntry = findNode(nodes, end, true);
    if (!startEntry || !endEntry) return null;

    // If the offset fell in a synthetic gap, snap inward to real content.
    if (start > startEntry.end) {
      var idx = nodes.indexOf(startEntry);
      startEntry = nodes[Math.min(idx + 1, nodes.length - 1)];
      start = startEntry.start;
    }
    if (end < endEntry.start) {
      var eidx = nodes.indexOf(endEntry);
      endEntry = nodes[Math.max(eidx - 1, 0)];
      end = endEntry.end;
    }

    try {
      var range = document.createRange();
      range.setStart(startEntry.node, nodeOffsetFor(startEntry, start));
      range.setEnd(endEntry.node, nodeOffsetFor(endEntry, end));
      return range.collapsed ? null : range;
    } catch (e) {
      return null;
    }
  }

  /** Flat-text offset for a DOM point, or null when it is outside the model. */
  function offsetForPoint(nodes, node, offset) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].node === node) {
        var entry = nodes[i];
        if (entry.raw === entry.normalized) return entry.start + offset;
        // Count normalized characters up to the raw offset.
        var produced = 0;
        var j = 0;
        while (j < offset && j < entry.raw.length) {
          if (/\s/.test(entry.raw[j])) {
            var k = j;
            while (k < entry.raw.length && /\s/.test(entry.raw[k])) k++;
            produced += 1;
            j = k;
          } else {
            produced += 1;
            j += 1;
          }
        }
        return entry.start + produced;
      }
    }
    return null;
  }

  /** Extend [start, len] to cover the whole word under it, for word highlighting. */
  function expandToWord(text, start, len) {
    var isWordChar = function (ch) { return ch !== undefined && /[\p{L}\p{N}'’\-]/u.test(ch); };
    var s = start;
    var e = start + (len || 0);

    while (s > 0 && isWordChar(text[s - 1])) s--;
    if (e <= s) e = s + 1;
    while (e < text.length && isWordChar(text[e])) e++;

    return [s, e];
  }

  root.Segmenter = {
    build: build,
    rangeFor: rangeFor,
    offsetForPoint: offsetForPoint,
    expandToWord: expandToWord,
    segmentSentences: segmentSentences,
    isAtomic: isAtomic,
    SEGMENT_BREAK: SEGMENT_BREAK
  };
})(window);
