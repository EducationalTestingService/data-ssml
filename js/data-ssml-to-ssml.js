/*
 * data-ssml-to-ssml.js
 * ====================
 * Convert a parsed `data-ssml` object into a W3C SSML 1.1 document.
 *
 * JavaScript port of `data_ssml_to_ssml.py` from
 * https://github.com/mhakkinen/data-ssmlToJson — produces byte-comparable
 * output to the Python `to_ssml()` (attribute order, self-closing <break/>,
 * no XML declaration).
 *
 * The SSML produced here can be handed to any SSML-capable TTS engine:
 * SAPI5, Windows OneCore, AWS Polly, Google Cloud TTS, Azure TTS, and others.
 *
 * References
 * ----------
 * - W3C SSML 1.1: https://www.w3.org/TR/speech-synthesis11/
 * - 1EdTech data-ssml: https://www.1edtech.org/standards/data-ssml
 */
(function (root) {
  'use strict';

  var SSML_NS = 'http://www.w3.org/2001/10/synthesis';
  var SSML_VERSION = '1.0';

  // Inverse rate-keyword lookup (multiplier -> keyword).
  // Thresholds are the mid-points of each band.
  var RATE_THRESHOLDS = [
    [0.60, 'x-slow'],
    [0.875, 'slow'],
    [1.25, 'medium'],
    [1.75, 'fast']
  ];

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------
  // Minimal element model, so serialization mirrors ElementTree exactly.
  // ---------------------------------------------------------------------

  function El(tag) {
    this.tag = tag;
    this.attrs = [];       // ordered [name, value] pairs
    this.text = null;
    this.tail = null;
    this.children = [];
  }
  El.prototype.set = function (name, value) {
    this.attrs.push([name, String(value)]);
    return this;
  };
  El.prototype.sub = function (tag) {
    var child = new El(tag);
    this.children.push(child);
    return child;
  };
  El.prototype.serialize = function () {
    var out = '<' + this.tag;
    this.attrs.forEach(function (pair) {
      out += ' ' + pair[0] + '="' + escapeAttr(pair[1]) + '"';
    });

    var hasBody = (this.text !== null && this.text !== '') || this.children.length > 0;
    if (!hasBody) {
      out += ' />';
    } else {
      out += '>';
      if (this.text) out += escapeText(this.text);
      this.children.forEach(function (child) {
        out += child.serialize();
      });
      out += '</' + this.tag + '>';
    }
    if (this.tail) out += escapeText(this.tail);
    return out;
  };

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Build a W3C SSML 1.1 document from element text and a parsed data-ssml object.
   *
   * @param {string} elementText  Visible text content of the element bearing data-ssml.
   * @param {Object} parsed       Normalized object from DataSsmlParser.parse().
   * @param {string} [lang="en"]  BCP 47 tag written to xml:lang on <speak>.
   * @returns {string} SSML 1.1 XML, no XML declaration.
   */
  function toSsml(elementText, parsed, lang) {
    lang = lang || 'en';
    parsed = parsed || {};

    // Step 1: apply text substitutions (no markup needed).
    var text = applySub(elementText, parsed.sub || []);

    // Step 2: build the <speak> root.
    var speak = new El('speak');
    speak.set('version', SSML_VERSION);
    speak.set('xmlns', SSML_NS);
    speak.set('xml:lang', lang);

    var breaks = parsed['break'] || [];

    // Step 3: wrap with the appropriate SSML element.
    if (parsed.phoneme) {
      var ph = speak.sub('phoneme');
      ph.set('alphabet', parsed.phoneme.alphabet);
      ph.set('ph', parsed.phoneme.ph);
      ph.text = text;
      appendGlobalBreaks(speak, breaks);
    } else if (parsed.say_as && parsed.say_as.length) {
      var sa = parsed.say_as[0];
      var saEl = speak.sub('say-as');
      saEl.set('interpret-as', sa.interpret_as);
      saEl.text = sa.text ? sa.text : text;
      appendGlobalBreaks(speak, breaks);
    } else if (parsed.prosody && Object.keys(parsed.prosody).length) {
      var rateMult = parsed.prosody.rate_multiplier;
      if (rateMult === undefined) rateMult = 1.0;
      var pros = speak.sub('prosody');
      pros.set('rate', multiplierToRateKeyword(rateMult));
      buildTextWithBreaks(pros, text, breaks);
    } else {
      buildTextWithBreaks(speak, text, breaks);
    }

    return speak.serialize();
  }

  /**
   * Apply only text-transforming directives (`sub`), returning a plain string.
   * For engines with no SSML support that still want abbreviation expansion.
   */
  function applyTextOnly(elementText, parsed) {
    return applySub(elementText, (parsed || {}).sub || []);
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  function applySub(text, subs) {
    for (var i = 0; i < subs.length; i++) {
      var target = subs[i].text;
      var alias = subs[i].alias;
      if (target === null || target === undefined) {
        // Spec format: alias replaces the entire element text.
        return alias;
      }
      text = splitJoin(text, target, alias);
    }
    return text;
  }

  // String.prototype.replaceAll equivalent with literal (non-regex) semantics.
  function splitJoin(haystack, needle, replacement) {
    if (needle === '') return haystack;
    return haystack.split(needle).join(replacement);
  }

  /** Map a float multiplier to the nearest SSML rate keyword. */
  function multiplierToRateKeyword(multiplier) {
    for (var i = 0; i < RATE_THRESHOLDS.length; i++) {
      if (multiplier <= RATE_THRESHOLDS[i][0]) return RATE_THRESHOLDS[i][1];
    }
    return 'x-fast';
  }

  /**
   * Populate `parent` with `text`, inserting <break> elements at the positions
   * given by each break's `after` field. Breaks with no `after` are appended.
   */
  function buildTextWithBreaks(parent, text, breaks) {
    var positional = [];
    var trailing = [];

    breaks.forEach(function (brk) {
      var after = brk.after;
      if (after) {
        var idx = text.indexOf(after);
        if (idx >= 0) positional.push([idx + after.length, brk]);
        else trailing.push(brk);
      } else {
        trailing.push(brk);
      }
    });

    positional.sort(function (a, b) { return a[0] - b[0]; });

    if (!positional.length) {
      parent.text = text;
      trailing.forEach(function (brk) { appendBreak(parent, brk); });
      return;
    }

    var prevPos = 0;
    var lastAdded = null;

    positional.forEach(function (entry) {
      var pos = entry[0];
      var chunk = text.slice(prevPos, pos);
      if (lastAdded === null) parent.text = (parent.text || '') + chunk;
      else lastAdded.tail = (lastAdded.tail || '') + chunk;
      lastAdded = appendBreak(parent, entry[1]);
      prevPos = pos;
    });

    var remainder = text.slice(prevPos);
    if (remainder) {
      if (lastAdded === null) parent.text = (parent.text || '') + remainder;
      else lastAdded.tail = (lastAdded.tail || '') + remainder;
    }

    trailing.forEach(function (brk) { lastAdded = appendBreak(parent, brk); });
  }

  function appendBreak(parent, brk) {
    var b = parent.sub('break');
    b.set('time', brk.time_ms + 'ms');
    b.set('strength', brk.strength || 'medium');
    return b;
  }

  function appendGlobalBreaks(parent, breaks) {
    breaks.forEach(function (brk) {
      if (!brk.after) appendBreak(parent, brk);
    });
  }

  // ---------------------------------------------------------------------
  // Sentence-level composition
  // ---------------------------------------------------------------------
  //
  // `toSsml` above is the port of the reference library: one element, one
  // <speak> document. A read-aloud tool speaks a *sentence*, which may contain
  // several data-ssml elements side by side or nested. `composeSsml` builds one
  // <speak> document for such a sentence, nesting each element's markup over
  // exactly the text that element covers.

  /** Arrange scopes into a containment forest over the unit's text. */
  function buildScopeTree(scopes) {
    var sorted = scopes.slice()
      .filter(function (s) { return s.parsed && Object.keys(s.parsed).length; })
      .sort(function (a, b) {
        if (a.start !== b.start) return a.start - b.start;
        if (a.depth !== b.depth) return a.depth - b.depth;
        return b.end - a.end;
      })
      .map(function (s) {
        return {
          start: s.start, end: s.end, parsed: s.parsed, depth: s.depth,
          text: s.text, clampedRight: !!s.clampedRight, children: []
        };
      });

    var roots = [];
    var stack = [];

    sorted.forEach(function (node) {
      while (stack.length && !(stack[stack.length - 1].end >= node.end &&
                               stack[stack.length - 1].start <= node.start &&
                               stack[stack.length - 1].depth < node.depth)) {
        stack.pop();
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      stack.push(node);
    });

    return roots;
  }

  /**
   * Compose one <speak> document for a sentence.
   *
   * @param {string} text     The sentence's visible text.
   * @param {Array} scopes    Unit-relative scopes from Segmenter.build().
   * @param {string} [lang]
   */
  function composeSsml(text, scopes, lang) {
    lang = lang || 'en';
    var body = renderChildren(buildScopeTree(scopes || []), text, 0, text.length, null);
    return speakTag(lang) + body + '</speak>';
  }

  /**
   * Compose the same document with `<mark>` elements inserted, and return the
   * table that maps each mark name back to its source range.
   *
   * SSML-capable cloud engines report the time at which they reach each mark
   * (Polly speech marks, Google timepoints), which is how this tool gets real
   * word timings from a real SSML engine rather than inferring them.
   *
   * Marks are placed before each word in ordinary text, and once before any
   * element whose directives reinterpret its content — SSML 1.1 allows only
   * text inside `sub`, `say-as`, and `phoneme`, so nothing is inserted there,
   * and such an element highlights as a single span.
   *
   * @returns {{ssml: string, marks: Array<{name, srcStart, srcEnd}>}}
   */
  function composeSsmlWithMarks(text, scopes, lang) {
    lang = lang || 'en';
    var ctx = { marks: [], n: 0 };
    var body = renderChildren(buildScopeTree(scopes || []), text, 0, text.length, ctx);
    return { ssml: speakTag(lang) + body + '</speak>', marks: ctx.marks };
  }

  function speakTag(lang) {
    return '<speak version="' + SSML_VERSION + '" xmlns="' + SSML_NS +
      '" xml:lang="' + escapeAttr(lang) + '">';
  }

  /** True when a node's directives rewrite what its content says. */
  function reinterpretsContent(d) {
    return !!(d && (d.sub || d.say_as || d.phoneme));
  }

  function markTag(ctx, srcStart, srcEnd) {
    var name = 'm' + (ctx.n++);
    ctx.marks.push({ name: name, srcStart: srcStart, srcEnd: srcEnd });
    return '<mark name="' + name + '"/>';
  }

  /** Emit a text run, preceding each word with a mark when `ctx` is active. */
  function emitText(text, from, to, ctx, base) {
    var slice = text.slice(from, to);
    if (!ctx || !slice) return escapeText(slice);

    var origin = (base === undefined ? 0 : base) + from;
    var out = '';
    var cursor = 0;
    var re = /\S+/g;
    var m;

    while ((m = re.exec(slice)) !== null) {
      out += escapeText(slice.slice(cursor, m.index));
      out += markTag(ctx, origin + m.index, origin + m.index + m[0].length);
      out += escapeText(m[0]);
      cursor = m.index + m[0].length;
    }
    out += escapeText(slice.slice(cursor));
    return out;
  }

  function renderChildren(nodes, text, start, end, ctx) {
    var out = '';
    var cursor = start;

    nodes.forEach(function (node) {
      if (node.start > cursor) out += emitText(text, cursor, node.start, ctx);

      if (ctx && reinterpretsContent(node.parsed)) {
        // One mark for the whole element, placed outside it.
        out += markTag(ctx, node.start, node.end);
        out += renderScopeNode(node, text, null);
      } else {
        out += renderScopeNode(node, text, ctx);
      }
      cursor = Math.max(cursor, node.end);
    });

    if (cursor < end) out += emitText(text, cursor, end, ctx);
    return out;
  }

  function renderScopeNode(node, text, ctx) {
    var d = node.parsed || {};
    var slice = text.slice(node.start, node.end);
    var inner;

    if (node.children.length) {
      inner = renderChildren(node.children, text, node.start, node.end, ctx);
      // Only whole-element sub can be honoured over nested markup.
      var wholeSub = (d.sub || []).filter(function (s) { return s.text === null; })[0];
      if (wholeSub) inner = escapeText(wholeSub.alias);
    } else {
      inner = renderLeafText(slice, d, ctx, node.start);
    }

    // Wrap innermost-out: phoneme / say-as, then prosody.
    if (d.phoneme) {
      inner = '<phoneme alphabet="' + escapeAttr(d.phoneme.alphabet) +
        '" ph="' + escapeAttr(d.phoneme.ph) + '">' + inner + '</phoneme>';
    } else {
      var wholeSayAs = (d.say_as || []).filter(function (s) { return s.text === null; })[0];
      if (wholeSayAs) {
        inner = '<say-as interpret-as="' + escapeAttr(wholeSayAs.interpret_as) + '">' +
          inner + '</say-as>';
      }
    }

    // Trailing breaks sit inside prosody, matching the reference serializer.
    var trailing = '';
    (d['break'] || []).forEach(function (brk) {
      if (!brk.after && !node.clampedRight) trailing += breakTag(brk);
    });
    inner += trailing;

    if (d.prosody && Object.keys(d.prosody).length) {
      var rate = d.prosody.rate_multiplier;
      inner = '<prosody rate="' + rateAttrValue(rate === undefined ? 1 : rate) +
        '">' + inner + '</prosody>';
    }

    return inner;
  }

  /**
   * Rate value for composed output.
   *
   * `multiplierToRateKeyword` reproduces the reference library exactly, which
   * snaps every multiplier to the nearest of five keywords — `"90%"` comes back
   * out as `medium`. SSML 1.1 permits a percentage, so an authored value that
   * is not one of the keywords is preserved verbatim here instead.
   */
  function rateAttrValue(multiplier) {
    var keys = Object.keys(RATE_KEYWORD_VALUES);
    for (var i = 0; i < keys.length; i++) {
      if (Math.abs(RATE_KEYWORD_VALUES[keys[i]] - multiplier) < 1e-9) return keys[i];
    }
    return Math.round(multiplier * 100) + '%';
  }

  // Canonical keyword multipliers, matched exactly (not by band).
  var RATE_KEYWORD_VALUES = {
    'x-slow': 0.5, 'slow': 0.75, 'medium': 1.0, 'fast': 1.5, 'x-fast': 2.0
  };

  /**
   * Render a leaf element's text: whole-element `sub` replacement, then
   * substring-targeted `sub`, `say-as`, and positional `break`.
   */
  function renderLeafText(slice, d, ctx, base) {
    // `ctx` is only passed for nodes that do not rewrite their content, so the
    // source offsets below line up one-to-one with `slice`.
    var wholeSub = (d.sub || []).filter(function (s) { return s.text === null; })[0];
    var plain = wholeSub ? wholeSub.alias : applySub(slice, (d.sub || []).filter(function (s) {
      return s.text !== null;
    }));

    // Segment the text, wrapping substring-targeted say-as and inserting
    // positional breaks. Markers are resolved against `plain` in order.
    var marks = [];

    (d.say_as || []).forEach(function (sa) {
      if (sa.text === null) return;
      var idx = plain.indexOf(sa.text);
      if (idx >= 0) {
        marks.push({
          at: idx, length: sa.text.length, kind: 'say-as', value: sa.interpret_as
        });
      }
    });

    (d['break'] || []).forEach(function (brk) {
      if (!brk.after) return;
      var idx = plain.indexOf(brk.after);
      if (idx >= 0) marks.push({ at: idx + brk.after.length, length: 0, kind: 'break', value: brk });
    });

    // A word-mark context is only supplied when `plain` still matches the
    // source slice, so `base + offset` is a valid source position.
    var emit = function (from, to) {
      return ctx ? emitText(plain, from, to, ctx, base) : escapeText(plain.slice(from, to));
    };

    if (!marks.length) return emit(0, plain.length);

    marks.sort(function (a, b) { return a.at - b.at || a.length - b.length; });

    var out = '';
    var cursor = 0;
    marks.forEach(function (mark) {
      if (mark.at < cursor) return;  // overlapping markers: first one wins
      out += emit(cursor, mark.at);
      if (mark.kind === 'say-as') {
        out += '<say-as interpret-as="' + escapeAttr(mark.value) + '">' +
          escapeText(plain.substr(mark.at, mark.length)) + '</say-as>';
      } else {
        out += breakTag(mark.value);
      }
      cursor = mark.at + mark.length;
    });
    out += emit(cursor, plain.length);
    return out;
  }

  function breakTag(brk) {
    return '<break time="' + brk.time_ms + 'ms" strength="' +
      escapeAttr(brk.strength || 'medium') + '" />';
  }

  /** Pretty-print SSML for the inspector panel (does not change semantics). */
  function formatForDisplay(ssml) {
    return ssml
      .replace(/></g, '>\n<')
      .replace(/(<speak[^>]*>)/, '$1\n')
      .replace(/(<\/speak>)/, '\n$1');
  }

  root.DataSsmlToSsml = {
    toSsml: toSsml,
    applyTextOnly: applyTextOnly,
    composeSsml: composeSsml,
    composeSsmlWithMarks: composeSsmlWithMarks,
    formatForDisplay: formatForDisplay,
    SSML_NS: SSML_NS,
    _multiplierToRateKeyword: multiplierToRateKeyword,
    _buildScopeTree: buildScopeTree
  };
})(window);
