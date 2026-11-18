/*
 * ssml-emulate.js
 * ===============
 * Client-side emulation of SSML semantics for TTS engines that do not accept
 * SSML markup.
 *
 * The Web Speech API (SpeechSynthesisUtterance) has no SSML input path in any
 * shipping browser: markup handed to it is either stripped or read aloud as
 * literal tag text. To make `data-ssml` audible today, this module realizes
 * each directive using primitives the Web Speech API *does* expose:
 *
 *   sub      -> textual substitution before synthesis
 *   say-as   -> textual expansion (number/date/time/telephone/character spelling)
 *   break    -> the utterance is split and a timed silence inserted between parts
 *   prosody  -> SpeechSynthesisUtterance.rate multiplier on the affected part
 *   phoneme  -> approximate English respelling from IPA (lossy; opt-in)
 *
 * Everything is expressed as an ordered list of "pieces". A piece is either
 * spoken text or a silence. Spoken pieces carry a mapping back to the source
 * text offsets so that word-level highlighting still works after a directive
 * has rewritten what is said.
 *
 *   piece = {kind: 'speech', spoken: string, srcStart: number, srcEnd: number,
 *            exact: boolean, rate: number, note: string|null}
 *   piece = {kind: 'silence', ms: number, srcStart: number, srcEnd: number}
 *
 * `exact: true` means spoken text is character-identical to the source slice,
 * so a boundary event at spoken offset N maps to source offset srcStart + N.
 * `exact: false` means the piece was rewritten, so any boundary landing inside
 * it highlights the whole source slice.
 */
(function (root) {
  'use strict';

  // =====================================================================
  // Number, date, and time expansion for say-as
  // =====================================================================

  var ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen'];

  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  var SCALES = ['', ' thousand', ' million', ' billion', ' trillion', ' quadrillion'];

  var ORDINAL_MAP = {
    one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth',
    six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth', ten: 'tenth',
    eleven: 'eleventh', twelve: 'twelfth', thirteen: 'thirteenth', fourteen: 'fourteenth',
    fifteen: 'fifteenth', sixteen: 'sixteenth', seventeen: 'seventeenth',
    eighteen: 'eighteenth', nineteen: 'nineteenth', twenty: 'twentieth',
    thirty: 'thirtieth', forty: 'fortieth', fifty: 'fiftieth', sixty: 'sixtieth',
    seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
    hundred: 'hundredth', thousand: 'thousandth', million: 'millionth',
    billion: 'billionth', trillion: 'trillionth', zero: 'zeroth'
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  /** Integer (0 .. 999) to words. */
  function under1000ToWords(n) {
    if (n < 20) return ONES[n];
    if (n < 100) {
      var t = TENS[Math.floor(n / 10)];
      var r = n % 10;
      return r ? t + '-' + ONES[r] : t;
    }
    var h = ONES[Math.floor(n / 100)] + ' hundred';
    var rest = n % 100;
    return rest ? h + ' ' + under1000ToWords(rest) : h;
  }

  /** Non-negative or negative integer to words. Falls back to digits when huge. */
  function intToWords(n) {
    if (!isFinite(n)) return String(n);
    if (n < 0) return 'minus ' + intToWords(-n);
    n = Math.trunc(n);
    if (n === 0) return 'zero';
    if (n >= 1e21) return digitsToWords(String(n));

    var groups = [];
    while (n > 0) {
      groups.push(n % 1000);
      n = Math.floor(n / 1000);
    }
    if (groups.length > SCALES.length) return digitsToWords(String(n));

    var parts = [];
    for (var i = groups.length - 1; i >= 0; i--) {
      if (groups[i] === 0) continue;
      parts.push(under1000ToWords(groups[i]) + SCALES[i]);
    }
    return parts.join(' ');
  }

  /** "cardinal": handles sign, decimals, thousands separators, and currency-free text. */
  function cardinalToWords(text) {
    var s = String(text).trim().replace(/,/g, '');
    var m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(s);
    if (!m || (!m[2] && !m[3])) return digitsToWords(String(text));

    var sign = m[1] === '-' ? 'minus ' : '';
    var whole = m[2] === '' ? '0' : m[2];
    var frac = m[3];

    var out = sign + intToWords(parseInt(whole, 10));
    if (frac) out += ' point ' + digitsToWords(frac);
    return out;
  }

  /** "ordinal": 3 -> third, 21 -> twenty-first, 100 -> one hundredth. */
  function ordinalToWords(text) {
    var s = String(text).trim().replace(/,/g, '').replace(/(st|nd|rd|th)$/i, '');
    var n = parseInt(s, 10);
    if (isNaN(n)) return String(text);

    var words = intToWords(n);
    // Transform only the final word (and only its final hyphenated part).
    var spaceIdx = words.lastIndexOf(' ');
    var head = spaceIdx === -1 ? '' : words.slice(0, spaceIdx + 1);
    var last = spaceIdx === -1 ? words : words.slice(spaceIdx + 1);

    var hyphenIdx = last.lastIndexOf('-');
    var lHead = hyphenIdx === -1 ? '' : last.slice(0, hyphenIdx + 1);
    var lLast = hyphenIdx === -1 ? last : last.slice(hyphenIdx + 1);

    var ord = ORDINAL_MAP[lLast] || (lLast + 'th');
    return head + lHead + ord;
  }

  /** Each digit/character spoken separately: "2023" -> "two zero two three". */
  function digitsToWords(text) {
    return String(text).split('').map(function (ch) {
      if (/\d/.test(ch)) return ONES[Number(ch)];
      if (ch === '.') return 'point';
      if (ch === '-') return 'dash';
      if (ch === ' ') return '';
      return ch;
    }).filter(Boolean).join(' ');
  }

  /** Years read the conventional English way: 2023 -> "twenty twenty-three". */
  function yearToWords(y) {
    var n = parseInt(y, 10);
    if (isNaN(n)) return String(y);
    if (n < 1000 || n > 9999) return intToWords(n);

    var hi = Math.floor(n / 100);
    var lo = n % 100;

    if (lo === 0) {
      // 1900 -> "nineteen hundred", 2000 -> "two thousand"
      return hi % 10 === 0 ? intToWords(n) : under1000ToWords(hi) + ' hundred';
    }
    if (hi % 10 === 0 && lo < 10) {
      // 2005 -> "two thousand five"
      return intToWords(n);
    }
    if (lo < 10) {
      // 1905 -> "nineteen oh five"
      return under1000ToWords(hi) + ' oh ' + ONES[lo];
    }
    return under1000ToWords(hi) + ' ' + under1000ToWords(lo);
  }

  /**
   * "date": accepts ISO (YYYY-MM-DD, YYYY-MM, YYYY), US (M/D/YYYY),
   * and D-M-YYYY when the first field cannot be a month.
   */
  function dateToWords(text) {
    var s = String(text).trim();
    var m;

    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) return monthDayYear(+m[2], +m[3], m[1]);

    m = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (m) return monthName(+m[2]) + ' ' + yearToWords(m[1]);

    m = /^(\d{4})$/.exec(s);
    if (m) return yearToWords(m[1]);

    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (m) {
      var a = +m[1], b = +m[2];
      var year = m[3].length === 2 ? '20' + m[3] : m[3];
      if (a > 12 && b <= 12) return monthDayYear(b, a, year);  // D/M/Y
      return monthDayYear(a, b, year);                          // M/D/Y (default)
    }

    m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(s);
    if (m) return monthName(+m[1]) + ' ' + ordinalToWords(m[2]);

    return s;  // Not a recognized date shape — leave it to the engine.
  }

  function monthName(m) {
    return MONTHS[m - 1] || String(m);
  }

  function monthDayYear(mo, day, year) {
    return monthName(mo) + ' ' + ordinalToWords(day) + ', ' + yearToWords(year);
  }

  /** "time": 14:30 -> "two thirty PM", 09:05 -> "nine oh five AM". */
  function timeToWords(text) {
    var s = String(text).trim();
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(s);
    if (!m) {
      m = /^(\d{1,2})\s*([ap]\.?m\.?)$/i.exec(s);
      if (m) return under1000ToWords(+m[1]) + ' ' + meridiem(m[2]);
      return s;
    }

    var h = +m[1];
    var min = +m[2];
    var sec = m[3] === undefined ? null : +m[3];
    var mer = m[4] ? meridiem(m[4]) : null;

    if (!mer && m[1].length <= 2) {
      // 24-hour input with no explicit meridiem: derive one.
      if (h === 0) { mer = 'A M'; h = 12; }
      else if (h === 12) { mer = 'P M'; }
      else if (h > 12) { mer = 'P M'; h -= 12; }
      else { mer = 'A M'; }
    }

    var out = under1000ToWords(h);
    if (min === 0) out += " o'clock";
    else if (min < 10) out += ' oh ' + ONES[min];
    else out += ' ' + under1000ToWords(min);

    if (sec !== null && sec > 0) out += ' and ' + under1000ToWords(sec) + ' seconds';
    if (mer) out += ' ' + mer;
    return out;
  }

  function meridiem(raw) {
    return /^a/i.test(raw) ? 'A M' : 'P M';
  }

  /** "telephone": digits individually, grouped with commas for natural pauses. */
  function telephoneToWords(text) {
    var s = String(text).trim();
    var out = [];
    var group = [];

    var flush = function () {
      if (group.length) { out.push(group.join(' ')); group = []; }
    };

    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (/\d/.test(ch)) {
        group.push(ONES[Number(ch)]);
      } else if (ch === '+') {
        flush();
        out.push('plus');
      } else if (/[xX]/.test(ch) && group.length) {
        flush();
        out.push('extension');
      } else if (/[-.()\s/]/.test(ch)) {
        flush();
      } else {
        group.push(ch);
      }
    }
    flush();
    return out.filter(Boolean).join(', ');
  }

  /** "characters": spell out, letter by letter. */
  function charactersToWords(text) {
    return String(text).split('').map(function (ch) {
      if (/\s/.test(ch)) return null;
      if (/\d/.test(ch)) return ONES[Number(ch)];
      if (/[a-z]/.test(ch)) return ch.toUpperCase();
      if (/[A-Z]/.test(ch)) return ch;
      return PUNCT_NAMES[ch] || ch;
    }).filter(Boolean).join(' ');
  }

  var PUNCT_NAMES = {
    '.': 'dot', ',': 'comma', '-': 'dash', '_': 'underscore', '/': 'slash',
    '@': 'at', '#': 'hash', '&': 'and', '+': 'plus', '=': 'equals',
    '(': 'open paren', ')': 'close paren', ':': 'colon', ';': 'semicolon',
    "'": 'apostrophe', '"': 'quote', '!': 'exclamation point', '?': 'question mark'
  };

  /** Dispatch a say-as interpret-as value to its expansion. */
  function expandSayAs(text, interpretAs) {
    switch (String(interpretAs).toLowerCase()) {
      case 'characters': return charactersToWords(text);
      case 'cardinal':   return cardinalToWords(text);
      case 'ordinal':    return ordinalToWords(text);
      case 'date':       return dateToWords(text);
      case 'time':       return timeToWords(text);
      case 'telephone':  return telephoneToWords(text);
      // Common SSML 1.1 values outside the data-ssml list, handled anyway.
      case 'digits':
      case 'number:digits': return digitsToWords(text);
      case 'spell-out':     return charactersToWords(text);
      default:              return text;
    }
  }

  // =====================================================================
  // IPA -> approximate English respelling (lossy, opt-in)
  // =====================================================================

  // Longest-match-first table. This cannot reproduce a phoneme faithfully; it
  // steers a general-purpose voice toward the intended pronunciation, which is
  // usually a large improvement over the unmarked spelling.
  var IPA_MAP = [
    ['t͡ʃ', 'ch'], ['d͡ʒ', 'j'], ['tʃ', 'ch'], ['dʒ', 'j'],
    ['aʊ', 'ow'], ['aɪ', 'eye'], ['eɪ', 'ay'], ['oʊ', 'oh'], ['ɔɪ', 'oy'],
    ['ɪə', 'eer'], ['eə', 'air'], ['ʊə', 'oor'],
    ['iː', 'ee'], ['uː', 'oo'], ['ɑː', 'ah'], ['ɔː', 'aw'], ['ɜː', 'ur'], ['ɛː', 'air'],
    ['ŋ', 'ng'], ['ʃ', 'sh'], ['ʒ', 'zh'], ['θ', 'th'], ['ð', 'th'], ['j', 'y'],
    ['ɹ', 'r'], ['ɾ', 'r'], ['ʔ', ''], ['x', 'kh'], ['ɡ', 'g'],
    ['i', 'ee'], ['ɪ', 'ih'], ['e', 'eh'], ['ɛ', 'eh'], ['æ', 'a'],
    ['ɑ', 'ah'], ['ɒ', 'o'], ['ɔ', 'aw'], ['o', 'oh'], ['u', 'oo'],
    ['ʊ', 'uu'], ['ʌ', 'uh'], ['ə', 'uh'], ['ɜ', 'ur'], ['ɐ', 'uh'], ['ɘ', 'uh'],
    ['a', 'ah'], ['y', 'ee'], ['ɵ', 'uh'], ['ɶ', 'a'], ['ø', 'uh'], ['œ', 'uh']
  ];

  // Suprasegmentals and length marks that carry no respelling.
  var IPA_STRIP = /[ˈˌː̃ ̯͡ˈˌːˑ̯̃͡‍/\[\]()]/g;

  /**
   * Approximate an English respelling from an IPA string.
   * Returns null when the input yields nothing usable.
   */
  function ipaToRespelling(ph) {
    var s = String(ph);
    // Stress marks become syllable hints before being removed.
    s = s.replace(IPA_STRIP, '');
    if (!s) return null;

    var out = '';
    var i = 0;
    outer: while (i < s.length) {
      for (var k = 0; k < IPA_MAP.length; k++) {
        var sym = IPA_MAP[k][0];
        if (s.startsWith(sym, i)) {
          out += IPA_MAP[k][1];
          i += sym.length;
          continue outer;
        }
      }
      out += s[i];
      i += 1;
    }

    out = out.replace(/\s+/g, ' ').trim();
    return out || null;
  }

  // =====================================================================
  // Piece list construction
  // =====================================================================

  function speechPiece(spoken, srcStart, srcEnd, exact, rate, note) {
    return {
      kind: 'speech',
      spoken: spoken,
      srcStart: srcStart,
      srcEnd: srcEnd,
      exact: !!exact,
      rate: rate === undefined ? 1 : rate,
      note: note || null
    };
  }

  function silencePiece(ms, srcStart, srcEnd) {
    return { kind: 'silence', ms: ms, srcStart: srcStart, srcEnd: srcEnd };
  }

  /**
   * Literal markup handed to the engine rather than realized here.
   *
   * Some services honour part of SSML natively — ElevenLabs takes `<break>` and
   * `<phoneme>` but has no `sub`, `say-as`, or `prosody`. For those, the tag is
   * passed through as text while the rest of the directives are still emulated.
   * A markup piece occupies no source range, so highlighting skips over it.
   */
  function markupPiece(tag, srcPos) {
    return {
      kind: 'speech',
      spoken: tag,
      srcStart: srcPos,
      srcEnd: srcPos,
      exact: false,
      rate: 1,
      markup: true,
      note: 'native markup'
    };
  }

  function breakTagFor(brk, native) {
    var seconds = Math.min(brk.time_ms, native.breakMaxMs || brk.time_ms) / 1000;
    // Trim trailing zeros so "1s" reads better than "1.000s".
    var value = String(Math.round(seconds * 1000) / 1000);
    return '<break time="' + value + 's" />';
  }

  /** Whether a phoneme directive can be passed through to this engine. */
  function phonemeIsNative(phoneme, native) {
    if (!native || !native.phoneme) return false;
    if (!native.phonemeAlphabets) return true;
    return native.phonemeAlphabets.indexOf(phoneme.alphabet) !== -1;
  }

  /**
   * Replace every literal occurrence of `target` inside the exact-mapped
   * speech pieces, splitting them so the rewritten span is marked inexact.
   */
  function replaceInPieces(pieces, target, replacement, note) {
    if (!target) return pieces;
    var out = [];
    var replaced = false;

    pieces.forEach(function (p) {
      if (p.kind !== 'speech' || !p.exact) { out.push(p); return; }

      var text = p.spoken;
      var cursor = 0;
      var idx = text.indexOf(target);

      if (idx === -1) { out.push(p); return; }

      while (idx !== -1) {
        if (idx > cursor) {
          out.push(speechPiece(text.slice(cursor, idx),
            p.srcStart + cursor, p.srcStart + idx, true, p.rate));
        }
        out.push(speechPiece(replacement,
          p.srcStart + idx, p.srcStart + idx + target.length, false, p.rate, note));
        replaced = true;
        cursor = idx + target.length;
        idx = text.indexOf(target, cursor);
      }
      if (cursor < text.length) {
        out.push(speechPiece(text.slice(cursor),
          p.srcStart + cursor, p.srcStart + text.length, true, p.rate));
      }
    });

    return replaced ? out : pieces;
  }

  /**
   * Ensure a piece boundary exists at source offset `offset`, so a scope's
   * range can be selected exactly. Only exact pieces can be split; a rewritten
   * piece has no character correspondence to cut at.
   */
  function splitPiecesAt(pieces, offset) {
    var out = [];
    pieces.forEach(function (p) {
      if (p.kind === 'speech' && p.exact && p.srcStart < offset && p.srcEnd > offset) {
        var cut = offset - p.srcStart;
        out.push(speechPiece(p.spoken.slice(0, cut), p.srcStart, offset, true, p.rate, p.note));
        out.push(speechPiece(p.spoken.slice(cut), offset, p.srcEnd, true, p.rate, p.note));
      } else {
        out.push(p);
      }
    });
    return out;
  }

  /**
   * Partition an ordered piece list around the source range [s, e).
   * A zero-width scope (an empty element carrying only a break) yields an
   * empty `inside`, so whatever it contributes lands between the neighbours.
   */
  function selectRange(pieces, s, e) {
    var before = [];
    var inside = [];
    var after = [];

    pieces.forEach(function (p) {
      if (p.srcEnd <= s && p.srcStart <= s) before.push(p);
      else if (p.srcStart >= e) after.push(p);
      else inside.push(p);
    });

    return { before: before, inside: inside, after: after };
  }

  /**
   * Merge adjacent speech pieces that are exact, contiguous in the source, and
   * share a rate. Scope splitting leaves seams that carry no information, and
   * a minimal list means fewer utterances handed to the synthesizer.
   */
  function coalesce(pieces) {
    var out = [];
    pieces.forEach(function (p) {
      var last = out[out.length - 1];
      if (last && last.kind === 'speech' && p.kind === 'speech' &&
          last.exact && p.exact &&
          Math.abs(last.rate - p.rate) < 1e-9 &&
          last.srcEnd === p.srcStart) {
        last.spoken += p.spoken;
        last.srcEnd = p.srcEnd;
        return;
      }
      if (p.kind !== 'speech') { out.push(p); return; }
      var copy = speechPiece(p.spoken, p.srcStart, p.srcEnd, p.exact, p.rate, p.note);
      if (p.markup) copy.markup = true;
      out.push(copy);
    });
    return out;
  }

  /** Insert a silence after the first literal occurrence of `after`. */
  function insertSilenceAfter(pieces, after, ms) {
    return insertAfter(pieces, after, function (srcPos) {
      return silencePiece(ms, srcPos, srcPos);
    });
  }

  /** Insert native markup after the first literal occurrence of `after`. */
  function insertMarkupAfter(pieces, after, tag) {
    return insertAfter(pieces, after, function (srcPos) {
      return markupPiece(tag, srcPos);
    });
  }

  function insertAfter(pieces, after, makePiece) {
    var out = [];
    var done = false;

    pieces.forEach(function (p) {
      if (done || p.kind !== 'speech') { out.push(p); return; }

      var idx = p.spoken.indexOf(after);
      if (idx === -1) { out.push(p); return; }

      var cut = idx + after.length;
      if (cut >= p.spoken.length) {
        out.push(p);
        out.push(makePiece(p.srcEnd));
      } else if (p.exact) {
        out.push(speechPiece(p.spoken.slice(0, cut), p.srcStart, p.srcStart + cut, true, p.rate));
        out.push(makePiece(p.srcStart + cut));
        out.push(speechPiece(p.spoken.slice(cut), p.srcStart + cut, p.srcEnd, true, p.rate));
      } else {
        // Cannot split a rewritten piece without losing the source mapping.
        out.push(p);
        out.push(makePiece(p.srcEnd));
      }
      done = true;
    });

    if (!done) out.push(makePiece(Infinity));
    return out;
  }

  /**
   * Normalize the second argument of emulate() into a scope list.
   * A bare directives object is treated as one scope over the whole text,
   * which is what a single-element call means.
   */
  function normalizeScopes(text, scopesOrDirectives) {
    if (Array.isArray(scopesOrDirectives)) return scopesOrDirectives;
    var directives = scopesOrDirectives || {};
    if (!Object.keys(directives).length) return [];
    return [{
      parsed: directives,
      depth: 0,
      start: 0,
      end: text.length,
      text: text,
      clampedLeft: false,
      clampedRight: false
    }];
  }

  function rateOf(pieces) {
    for (var i = 0; i < pieces.length; i++) {
      if (pieces[i].kind === 'speech') return pieces[i].rate;
    }
    return 1;
  }

  function quote(s) {
    var t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > 48 ? '"' + t.slice(0, 45) + '…"' : '"' + t + '"';
  }

  /**
   * Apply one element's directives to the piece range that element covers,
   * leaving the rest of the unit untouched.
   */
  function applyScope(pieces, scope, options, notes) {
    var d = scope.parsed || {};
    if (!Object.keys(d).length) return pieces;

    // Tags this engine consumes itself, if any. Everything else is emulated.
    var native = options.nativeTags || null;

    pieces = splitPiecesAt(pieces, scope.start);
    pieces = splitPiecesAt(pieces, scope.end);

    var sel = selectRange(pieces, scope.start, scope.end);
    var inside = sel.inside;

    var sourceText = function () {
      return inside.filter(function (p) { return p.kind === 'speech'; })
        .map(function (p) { return p.spoken; }).join('');
    };

    // --- sub ---------------------------------------------------------
    (d.sub || []).forEach(function (s) {
      if (s.text === null || s.text === undefined) {
        var was = sourceText() || scope.text;
        inside = [speechPiece(s.alias, scope.start, scope.end, false, rateOf(inside), 'sub')];
        notes.push('sub: ' + quote(was) + ' spoken as ' + quote(s.alias));
      } else {
        var before = inside;
        inside = replaceInPieces(inside, s.text, s.alias, 'sub');
        notes.push(inside === before
          ? 'sub: target ' + quote(s.text) + ' not found in ' + quote(scope.text)
          : 'sub: ' + quote(s.text) + ' → ' + quote(s.alias));
      }
    });

    // --- say-as ------------------------------------------------------
    (d.say_as || []).forEach(function (sa) {
      if (sa.text === null || sa.text === undefined) {
        var base = sourceText();
        var expanded = expandSayAs(base, sa.interpret_as);
        inside = [speechPiece(expanded, scope.start, scope.end, false,
          rateOf(inside), 'say-as ' + sa.interpret_as)];
        notes.push('say-as ' + sa.interpret_as + ': ' + quote(base) + ' → ' + quote(expanded));
      } else {
        var expandedTarget = expandSayAs(sa.text, sa.interpret_as);
        var prev = inside;
        inside = replaceInPieces(inside, sa.text, expandedTarget, 'say-as ' + sa.interpret_as);
        notes.push(inside === prev
          ? 'say-as: target ' + quote(sa.text) + ' not found in ' + quote(scope.text)
          : 'say-as ' + sa.interpret_as + ': ' + quote(sa.text) + ' → ' + quote(expandedTarget));
      }
    });

    // --- phoneme -----------------------------------------------------
    if (d.phoneme) {
      if (phonemeIsNative(d.phoneme, native)) {
        // Wrap the element's own text, leaving the inner mapping intact so
        // highlighting still tracks through it.
        inside = [markupPiece('<phoneme alphabet="' + d.phoneme.alphabet +
          '" ph="' + d.phoneme.ph.replace(/"/g, '&quot;') + '">', scope.start)]
          .concat(inside, [markupPiece('</phoneme>', scope.end)]);
        notes.push('phoneme: /' + d.phoneme.ph + '/ sent as native <phoneme> markup');
      } else if (options.phonemeRespelling) {
        var respell = ipaToRespelling(d.phoneme.ph);
        if (respell) {
          inside = [speechPiece(respell, scope.start, scope.end, false,
            rateOf(inside), 'phoneme (respelled)')];
          notes.push('phoneme: /' + d.phoneme.ph + '/ approximated as ' + quote(respell) +
            ' (respelling is lossy)');
        } else {
          notes.push('phoneme: could not respell /' + d.phoneme.ph + '/; spelling spoken as-is');
        }
      } else {
        notes.push('phoneme: /' + d.phoneme.ph + '/ needs an SSML-capable engine; ' +
          quote(scope.text) + ' is spoken as spelled. Enable IPA respelling to approximate it.');
      }
    }

    // --- prosody -----------------------------------------------------
    if (d.prosody && d.prosody.rate_multiplier !== undefined) {
      var mult = d.prosody.rate_multiplier;
      inside.forEach(function (p) {
        if (p.kind === 'speech') p.rate = p.rate * mult;
      });
      notes.push('prosody: rate ×' + mult + ' on ' + quote(scope.text));
    }

    // --- break -------------------------------------------------------
    (d['break'] || []).forEach(function (brk) {
      var asMarkup = !!(native && native['break']);
      var tag = asMarkup ? breakTagFor(brk, native) : null;
      var how = asMarkup ? ' as native ' + tag : '';

      if (brk.after) {
        var was = inside;
        inside = asMarkup
          ? insertMarkupAfter(inside, brk.after, tag)
          : insertSilenceAfter(inside, brk.after, brk.time_ms);
        notes.push(was === inside
          ? 'break: ' + brk.time_ms + 'ms (target ' + quote(brk.after) + ' not found)'
          : 'break: ' + brk.time_ms + 'ms after ' + quote(brk.after) + how);
      } else if (scope.clampedRight) {
        // The element continues into a later sentence; its trailing break
        // belongs there, not at this sentence's end.
        notes.push('break: ' + brk.time_ms + 'ms deferred to the end of the element');
      } else {
        inside.push(asMarkup
          ? markupPiece(tag, scope.end)
          : silencePiece(brk.time_ms, scope.end, scope.end));
        notes.push('break: ' + brk.time_ms + 'ms after ' +
          quote(scope.text || 'this element') + how);
      }
    });

    return sel.before.concat(inside, sel.after);
  }

  /**
   * Build the emulated piece list for one unit of source text.
   *
   * @param {string} text  Visible source text for the unit.
   * @param {Array|Object} scopesOrDirectives
   *        Either the unit's scope list from Segmenter.build() — each entry
   *        carrying unit-relative {start, end, parsed, depth} — or a single
   *        normalized directives object applying to the whole text.
   * @param {Object} [options]
   *        {phonemeRespelling: boolean,
   *         nativeTags: {break, phoneme, phonemeAlphabets, breakMaxMs} | null}
   *        `nativeTags` names the SSML a partially-capable engine consumes
   *        itself; those directives are passed through as markup while the rest
   *        are still realized here.
   * @returns {{pieces: Array, notes: Array<string>, spoken: string}}
   */
  function emulate(text, scopesOrDirectives, options) {
    options = options || {};

    var scopes = normalizeScopes(text, scopesOrDirectives);
    var pieces = [speechPiece(text, 0, text.length, true, 1)];
    var notes = [];

    // Innermost first, so an inner element's rewrite is already in place when
    // an enclosing element's prosody or break is applied around it.
    scopes.slice().sort(function (a, b) {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return a.start - b.start;
    }).forEach(function (scope) {
      pieces = applyScope(pieces, scope, options, notes);
    });

    // Drop empty speech pieces and zero-length silences, then close the seams
    // left behind by scope splitting.
    pieces = coalesce(pieces.filter(function (p) {
      if (p.kind === 'silence') return p.ms > 0;
      return p.spoken.length > 0;
    }));

    var spoken = pieces.filter(function (p) { return p.kind === 'speech'; })
      .map(function (p) { return p.spoken; }).join('');

    return { pieces: pieces, notes: notes, spoken: spoken };
  }

  root.SsmlEmulate = {
    emulate: emulate,
    breakTagFor: breakTagFor,
    phonemeIsNative: phonemeIsNative,
    expandSayAs: expandSayAs,
    ipaToRespelling: ipaToRespelling,
    intToWords: intToWords,
    cardinalToWords: cardinalToWords,
    ordinalToWords: ordinalToWords,
    dateToWords: dateToWords,
    timeToWords: timeToWords,
    telephoneToWords: telephoneToWords,
    charactersToWords: charactersToWords,
    yearToWords: yearToWords,
    digitsToWords: digitsToWords
  };
})(window);
