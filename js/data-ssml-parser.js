/*
 * data-ssml-parser.js
 * ===================
 * Parse and normalize the 1EdTech/W3C `data-ssml` HTML attribute value.
 *
 * This is a faithful JavaScript port of `data_ssml_parser.py` from
 * https://github.com/mhakkinen/data-ssmlToJson — same accepted input, same
 * normalized output keys, same error conditions.
 *
 * Specification reference
 * -----------------------
 * "Support for Speech Synthesis Markup Language (SSML) Using the 'data-ssml'
 * Property", Version 1.0. 1EdTech Final Release, 1 July 2024.
 * https://www.1edtech.org/standards/data-ssml
 *
 * Two JSON formats are supported.
 *
 * Spec format (1EdTech v1.0 canonical — each key is a single object, the
 * directive applies to the whole element's text content):
 *
 *     {"sub": {"alias": "World Wide Web Consortium"}}
 *     {"break": {"time": "500ms", "strength": "medium"}}
 *     {"prosody": {"rate": "fast"}}
 *     {"say-as": {"interpret-as": "characters"}}
 *     {"phoneme": {"ph": "pɪˈkɑːn", "alphabet": "ipa"}}
 *
 * Extended format (found in QTI content and early implementations — each key
 * is an array, each item targets a specific substring via a "text" field):
 *
 *     {"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}
 *     {"break": [{"time": "500", "after": "Hello"}]}
 *     {"say-as": [{"text": "2023-04-15", "interpret-as": "date"}]}
 *
 * Both formats normalize to the same internal representation:
 *
 *   sub      -> [{text: string|null, alias: string}]
 *   break    -> [{text: null, after: string|null, time_ms: number, strength: string}]
 *   prosody  -> {rate_multiplier: number}
 *   say_as   -> [{text: string|null, interpret_as: string}]
 *   phoneme  -> {text: null, ph: string, alphabet: string}
 */
(function (root) {
  'use strict';

  /** Raised when a `data-ssml` value cannot be parsed or violates the spec. */
  function DataSsmlError(message) {
    var err = Error.call(this, message);
    this.name = 'DataSsmlError';
    this.message = message;
    this.stack = err.stack;
  }
  DataSsmlError.prototype = Object.create(Error.prototype);
  DataSsmlError.prototype.constructor = DataSsmlError;

  /** Rate keyword to multiplier, per 1EdTech spec / W3C SSML 1.1. */
  var RATE_KEYWORDS = {
    'x-slow': 0.5,
    'slow': 0.75,
    'medium': 1.0,
    'default': 1.0,
    'fast': 1.5,
    'x-fast': 2.0
  };

  /** Break strength to milliseconds (approximation used for AT fallback). */
  var STRENGTH_MS = {
    'none': 0,
    'x-weak': 100,
    'weak': 200,
    'medium': 400,
    'strong': 600,
    'x-strong': 1000
  };

  /** Valid `say-as` interpret-as values per the 1EdTech spec. */
  var VALID_INTERPRET_AS = ['date', 'time', 'telephone', 'characters', 'cardinal', 'ordinal'];

  /** Valid phoneme alphabet values per W3C SSML 1.1. */
  var VALID_ALPHABETS = ['ipa', 'x-sampa'];

  var typeName = function (v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'list';
    if (typeof v === 'object') return 'dict';
    if (typeof v === 'string') return 'str';
    if (typeof v === 'number') return 'int';
    if (typeof v === 'boolean') return 'bool';
    return typeof v;
  };

  var isPlainObject = function (v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  };

  // Python's str() on a JSON-decoded value; keeps numbers/bools readable.
  var asStr = function (v) {
    if (v === null) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    return String(v);
  };

  /**
   * Parse a `data-ssml` attribute value and return a normalized object.
   * Throws DataSsmlError for invalid JSON, non-object input, or spec violations.
   */
  function parse(attributeValue) {
    var raw;
    try {
      raw = JSON.parse(attributeValue);
    } catch (exc) {
      throw new DataSsmlError('Invalid JSON in data-ssml: ' + exc.message);
    }

    if (!isPlainObject(raw)) {
      throw new DataSsmlError('data-ssml value must be a JSON object, got ' + typeName(raw));
    }

    var result = {};

    if ('sub' in raw) result.sub = parseSub(raw.sub);
    if ('break' in raw) result['break'] = parseBreak(raw['break']);
    if ('prosody' in raw) {
      var prosody = parseProsody(raw.prosody);
      if (Object.keys(prosody).length) result.prosody = prosody;
    }
    if ('say-as' in raw) result.say_as = parseSayAs(raw['say-as']);
    if ('phoneme' in raw) result.phoneme = parsePhoneme(raw.phoneme);

    return result;
  }

  function parseSub(value) {
    if (isPlainObject(value)) {
      if (!('alias' in value)) throw new DataSsmlError("sub object requires 'alias' field");
      return [{ text: null, alias: asStr(value.alias) }];
    }
    if (Array.isArray(value)) {
      return value.map(function (item, i) {
        if (!isPlainObject(item)) throw new DataSsmlError('sub[' + i + '] must be an object');
        if (!('alias' in item)) throw new DataSsmlError('sub[' + i + "] requires 'alias' field");
        return {
          text: 'text' in item ? asStr(item.text) : null,
          alias: asStr(item.alias)
        };
      });
    }
    throw new DataSsmlError('sub must be an object or array, got ' + typeName(value));
  }

  function parseBreak(value) {
    if (isPlainObject(value)) {
      return [normalizeBreakItem(value, null)];
    }
    if (Array.isArray(value)) {
      return value.map(function (item, i) {
        if (!isPlainObject(item)) throw new DataSsmlError('break[' + i + '] must be an object');
        return normalizeBreakItem(item, 'after' in item ? item.after : null);
      });
    }
    throw new DataSsmlError('break must be an object or array');
  }

  function normalizeBreakItem(item, after) {
    var strength = 'strength' in item ? asStr(item.strength) : 'medium';
    var timeMs;

    if ('time' in item) {
      timeMs = parseTime(asStr(item.time));
    } else if (Object.prototype.hasOwnProperty.call(STRENGTH_MS, strength)) {
      timeMs = STRENGTH_MS[strength];
    } else {
      timeMs = STRENGTH_MS.medium;
    }

    return {
      text: null,
      after: after === null || after === undefined ? null : asStr(after),
      time_ms: timeMs,
      strength: strength
    };
  }

  /** Parse a CSS time value to milliseconds: "500ms", "3s", or bare "500". */
  function parseTime(timeStr) {
    var s = String(timeStr).trim();
    var m;

    m = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(s);
    if (m) return Math.trunc(parseFloat(m[1]));

    m = /^(\d+(?:\.\d+)?)\s*s$/i.exec(s);
    if (m) return Math.trunc(parseFloat(m[1]) * 1000);

    // Bare integer — milliseconds (extended format convention).
    m = /^(\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10);

    throw new DataSsmlError("Cannot parse time value: '" + timeStr + "'");
  }

  function parseProsody(value) {
    if (!isPlainObject(value)) throw new DataSsmlError('prosody must be an object');
    var result = {};
    if ('rate' in value) result.rate_multiplier = parseRate(asStr(value.rate));
    return result;
  }

  function parseRate(rateStr) {
    var s = String(rateStr).trim();
    if (Object.prototype.hasOwnProperty.call(RATE_KEYWORDS, s)) return RATE_KEYWORDS[s];
    var m = /^(\d+(?:\.\d+)?)%$/.exec(s);
    if (m) return parseFloat(m[1]) / 100.0;
    throw new DataSsmlError("Cannot parse prosody rate: '" + rateStr + "'");
  }

  function parseSayAs(value) {
    if (isPlainObject(value)) {
      if (!('interpret-as' in value)) {
        throw new DataSsmlError("say-as requires 'interpret-as' field");
      }
      return [{ text: null, interpret_as: asStr(value['interpret-as']) }];
    }
    if (Array.isArray(value)) {
      return value.map(function (item, i) {
        if (!isPlainObject(item)) throw new DataSsmlError('say-as[' + i + '] must be an object');
        if (!('interpret-as' in item)) {
          throw new DataSsmlError('say-as[' + i + "] requires 'interpret-as'");
        }
        return {
          text: 'text' in item ? asStr(item.text) : null,
          interpret_as: asStr(item['interpret-as'])
        };
      });
    }
    throw new DataSsmlError('say-as must be an object or array');
  }

  function parsePhoneme(value) {
    if (!isPlainObject(value)) throw new DataSsmlError('phoneme must be an object');
    if (!('ph' in value)) throw new DataSsmlError("phoneme requires 'ph' field");
    return {
      text: null,
      ph: asStr(value.ph),
      alphabet: ('alphabet' in value ? asStr(value.alphabet) : 'ipa').toLowerCase()
    };
  }

  /**
   * Non-fatal spec advisories for an already-parsed directive set.
   * `parse()` deliberately mirrors the Python library and accepts these values;
   * an authoring tool still wants to surface them. Returns an array of strings.
   */
  function validate(parsed) {
    var warnings = [];

    (parsed.say_as || []).forEach(function (sa) {
      if (VALID_INTERPRET_AS.indexOf(sa.interpret_as) === -1) {
        warnings.push(
          'say-as interpret-as "' + sa.interpret_as + '" is not one of the values listed in the ' +
          'data-ssml spec (' + VALID_INTERPRET_AS.join(', ') + ')'
        );
      }
    });

    if (parsed.phoneme && VALID_ALPHABETS.indexOf(parsed.phoneme.alphabet) === -1) {
      warnings.push(
        'phoneme alphabet "' + parsed.phoneme.alphabet + '" is not an SSML 1.1 alphabet (' +
        VALID_ALPHABETS.join(', ') + ')'
      );
    }

    (parsed.sub || []).forEach(function (s) {
      if (s.alias === '') warnings.push('sub alias is empty — nothing will be spoken for this content');
    });

    return warnings;
  }

  /**
   * Merge directive sets from an ancestor chain (outermost first).
   * An inner element wins for any key it defines; keys it omits are inherited.
   */
  function mergeDirectives(chain) {
    var merged = {};
    chain.forEach(function (parsed) {
      if (!parsed) return;
      Object.keys(parsed).forEach(function (key) {
        merged[key] = parsed[key];
      });
    });
    return merged;
  }

  root.DataSsmlParser = {
    parse: parse,
    validate: validate,
    mergeDirectives: mergeDirectives,
    DataSsmlError: DataSsmlError,
    RATE_KEYWORDS: RATE_KEYWORDS,
    STRENGTH_MS: STRENGTH_MS,
    VALID_INTERPRET_AS: VALID_INTERPRET_AS,
    VALID_ALPHABETS: VALID_ALPHABETS,
    _parseTime: parseTime,
    _parseRate: parseRate
  };
})(window);
