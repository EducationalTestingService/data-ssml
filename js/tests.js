/*
 * tests.js
 * ========
 * In-page self-test. Ports the pytest suites from
 * https://github.com/mhakkinen/data-ssmlToJson (test_parser.py and
 * test_to_ssml.py) so the JavaScript parser and serializer can be checked
 * against the same expectations as the reference Python library, and adds
 * cases for the emulation layer and the sentence segmenter.
 *
 * Also runnable headlessly under Node — see run-tests.js.
 */
(function (root) {
  'use strict';

  var groups = [];
  var currentGroup = null;
  var pending = [];

  function group(name, fn) {
    currentGroup = { name: name, cases: [] };
    groups.push(currentGroup);
    fn();
  }

  function record(target, name, err) {
    target.cases.push(err
      ? { name: name, ok: false, detail: (err && err.message) ? err.message : String(err) }
      : { name: name, ok: true, detail: '' });
  }

  function test(name, fn) {
    try {
      fn();
      record(currentGroup, name);
    } catch (err) {
      record(currentGroup, name, err);
    }
  }

  /**
   * An asynchronous case. The callback returns a promise; results are collected
   * before run() resolves, and a case that never settles cannot hang the suite.
   */
  function atest(name, fn) {
    var target = currentGroup;
    var promise;
    try {
      promise = Promise.resolve(fn());
    } catch (err) {
      record(target, name, err);
      return;
    }

    var timeout = new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('timed out after 5s')); }, 5000);
    });

    pending.push(Promise.race([promise, timeout]).then(function () {
      record(target, name);
    }, function (err) {
      record(target, name, err);
    }));
  }

  function fail(message) { throw new Error(message); }

  function eq(actual, expected, label) {
    var a = JSON.stringify(actual);
    var e = JSON.stringify(expected);
    if (a !== e) fail((label ? label + ': ' : '') + 'expected ' + e + ', got ' + a);
  }

  function close(actual, expected, label) {
    if (Math.abs(actual - expected) > 1e-9) {
      fail((label ? label + ': ' : '') + 'expected ~' + expected + ', got ' + actual);
    }
  }

  function truthy(value, label) {
    if (!value) fail((label || 'assertion') + ' was falsy');
  }

  function contains(haystack, needle) {
    if (String(haystack).indexOf(needle) === -1) {
      fail('expected to contain "' + needle + '" in: ' + haystack);
    }
  }

  function notContains(haystack, needle) {
    if (String(haystack).indexOf(needle) !== -1) {
      fail('expected NOT to contain "' + needle + '" in: ' + haystack);
    }
  }

  function raises(fn, match) {
    var threw = false;
    try {
      fn();
    } catch (err) {
      threw = true;
      if (!(err instanceof root.DataSsmlParser.DataSsmlError)) {
        fail('threw ' + err.name + ', expected DataSsmlError');
      }
      if (match && String(err.message).indexOf(match) === -1) {
        fail('error message "' + err.message + '" did not contain "' + match + '"');
      }
    }
    if (!threw) fail('expected DataSsmlError, nothing thrown');
  }

  // Read an attribute out of the serialized SSML (avoids needing a DOM here).
  function attrOf(xml, tag, attr) {
    var re = new RegExp('<' + tag.replace('-', '\\-') + '\\b[^>]*\\s' + attr + '="([^"]*)"');
    var m = re.exec(xml);
    return m ? m[1] : null;
  }

  function textInside(xml, tag) {
    var re = new RegExp('<' + tag.replace('-', '\\-') + '\\b[^>]*>([^<]*)<');
    var m = re.exec(xml);
    return m ? m[1] : null;
  }

  function stripTags(xml) {
    return xml.replace(/<[^>]*>/g, '');
  }

  // =====================================================================

  function run() {
    groups = [];
    pending = [];

    var parse = root.DataSsmlParser.parse;
    var toSsml = root.DataSsmlToSsml.toSsml;
    var applyTextOnly = root.DataSsmlToSsml.applyTextOnly;
    var E = root.SsmlEmulate;

    // ---------------- parser: sub -------------------------------------
    group('parser · sub', function () {
      test('spec format applies to whole element', function () {
        eq(parse('{"sub": {"alias": "World Wide Web Consortium"}}').sub,
          [{ text: null, alias: 'World Wide Web Consortium' }]);
      });
      test('extended format targets a substring', function () {
        eq(parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}').sub,
          [{ text: 'W3C', alias: 'World Wide Web Consortium' }]);
      });
      test('extended format with multiple items', function () {
        var r = parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}, ' +
          '{"text": "HTML", "alias": "HyperText Markup Language"}]}');
        eq(r.sub.length, 2);
        eq(r.sub[1].alias, 'HyperText Markup Language');
      });
      test('missing alias raises', function () {
        raises(function () { parse('{"sub": {"text": "W3C"}}'); }, 'alias');
      });
      test('array item missing alias raises', function () {
        raises(function () { parse('{"sub": [{"text": "W3C"}]}'); });
      });
    });

    // ---------------- parser: break -----------------------------------
    group('parser · break', function () {
      test('spec time in ms', function () {
        var r = parse('{"break": {"time": "500ms"}}');
        eq(r['break'][0].time_ms, 500);
        eq(r['break'][0].after, null);
      });
      test('spec time in seconds', function () {
        eq(parse('{"break": {"time": "3s"}}')['break'][0].time_ms, 3000);
      });
      test('strength only', function () {
        var r = parse('{"break": {"strength": "strong"}}');
        eq(r['break'][0].time_ms, 600);
        eq(r['break'][0].strength, 'strong');
      });
      test('extended bare integer is milliseconds', function () {
        var r = parse('{"break": [{"time": "500", "after": "Hello"}]}');
        eq(r['break'][0].time_ms, 500);
        eq(r['break'][0].after, 'Hello');
      });
      test('extended item without after', function () {
        eq(parse('{"break": [{"time": "200ms"}]}')['break'][0].after, null);
      });
      test('unparseable time raises', function () {
        raises(function () { parse('{"break": {"time": "five hundred"}}'); }, 'time');
      });
      test('all strength keywords map to spec milliseconds', function () {
        var expected = { none: 0, 'x-weak': 100, weak: 200, medium: 400, strong: 600, 'x-strong': 1000 };
        Object.keys(expected).forEach(function (k) {
          eq(parse('{"break": {"strength": "' + k + '"}}')['break'][0].time_ms, expected[k], k);
        });
      });
    });

    // ---------------- parser: prosody ---------------------------------
    group('parser · prosody', function () {
      test('rate keyword fast', function () {
        eq(parse('{"prosody": {"rate": "fast"}}').prosody.rate_multiplier, 1.5);
      });
      test('rate keyword x-slow', function () {
        eq(parse('{"prosody": {"rate": "x-slow"}}').prosody.rate_multiplier, 0.5);
      });
      test('rate keyword default', function () {
        eq(parse('{"prosody": {"rate": "default"}}').prosody.rate_multiplier, 1.0);
      });
      test('percentage 90%', function () {
        close(parse('{"prosody": {"rate": "90%"}}').prosody.rate_multiplier, 0.9);
      });
      test('percentage 120%', function () {
        close(parse('{"prosody": {"rate": "120%"}}').prosody.rate_multiplier, 1.2);
      });
      test('unknown rate raises', function () {
        raises(function () { parse('{"prosody": {"rate": "ludicrous-speed"}}'); }, 'rate');
      });
    });

    // ---------------- parser: say-as ----------------------------------
    group('parser · say-as', function () {
      test('spec format', function () {
        eq(parse('{"say-as": {"interpret-as": "characters"}}').say_as,
          [{ text: null, interpret_as: 'characters' }]);
      });
      test('extended format', function () {
        eq(parse('{"say-as": [{"text": "2023-04-15", "interpret-as": "date"}]}').say_as[0],
          { text: '2023-04-15', interpret_as: 'date' });
      });
      test('missing interpret-as raises', function () {
        raises(function () { parse('{"say-as": {"text": "hello"}}'); }, 'interpret-as');
      });
    });

    // ---------------- parser: phoneme ---------------------------------
    group('parser · phoneme', function () {
      test('ipa', function () {
        var r = parse('{"phoneme": {"ph": "pɪˈkɑːn", "alphabet": "ipa"}}');
        eq(r.phoneme.ph, 'pɪˈkɑːn');
        eq(r.phoneme.alphabet, 'ipa');
        eq(r.phoneme.text, null);
      });
      test('alphabet defaults to ipa', function () {
        eq(parse('{"phoneme": {"ph": "abc"}}').phoneme.alphabet, 'ipa');
      });
      test('x-sampa', function () {
        eq(parse('{"phoneme": {"ph": "pIkA:n", "alphabet": "x-sampa"}}').phoneme.alphabet, 'x-sampa');
      });
      test('missing ph raises', function () {
        raises(function () { parse('{"phoneme": {"alphabet": "ipa"}}'); }, "'ph'");
      });
    });

    // ---------------- parser: combined --------------------------------
    group('parser · combined & edge cases', function () {
      test('sub and prosody together', function () {
        var r = parse('{"sub": {"alias": "Acme Corporation"}, "prosody": {"rate": "slow"}}');
        truthy(r.sub, 'sub');
        eq(r.prosody.rate_multiplier, 0.75);
      });
      test('all five keys', function () {
        var r = parse('{"sub": {"alias": "Acme"}, "break": {"time": "300ms"}, ' +
          '"prosody": {"rate": "fast"}, "say-as": {"interpret-as": "cardinal"}, ' +
          '"phoneme": {"ph": "abc", "alphabet": "ipa"}}');
        eq(Object.keys(r).sort(), ['break', 'phoneme', 'prosody', 'say_as', 'sub']);
      });
      test('empty object', function () { eq(parse('{}'), {}); });
      test('invalid JSON raises', function () {
        raises(function () { parse('{not valid json}'); }, 'JSON');
      });
      test('non-object raises', function () {
        raises(function () { parse('"just a string"'); }, 'object');
      });
      test('unknown keys are ignored', function () {
        var r = parse('{"sub": {"alias": "Acme"}, "unknown_key": 42}');
        truthy(r.sub, 'sub');
        eq('unknown_key' in r, false);
      });
      test('prosody with no rate produces no prosody key', function () {
        eq('prosody' in parse('{"prosody": {}}'), false);
      });
    });

    // ---------------- to_ssml: sub ------------------------------------
    group('to_ssml · sub', function () {
      test('spec format replaces whole element', function () {
        var x = toSsml('W3C', parse('{"sub": {"alias": "World Wide Web Consortium"}}'));
        eq(stripTags(x), 'World Wide Web Consortium');
      });
      test('extended format replaces substring', function () {
        var x = toSsml('The W3C publishes standards.',
          parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}'));
        contains(stripTags(x), 'World Wide Web Consortium');
        notContains(stripTags(x), 'W3C');
      });
      test('sub adds no child elements', function () {
        var x = toSsml('ACME', parse('{"sub": {"alias": "Acme Corporation"}}'));
        eq(/<(?!\/?speak)/.test(x), false, 'no non-speak tags');
      });
    });

    // ---------------- to_ssml: break ----------------------------------
    group('to_ssml · break', function () {
      test('trailing break', function () {
        var x = toSsml('Hello world.', parse('{"break": {"time": "500ms"}}'));
        eq((x.match(/<break/g) || []).length, 1);
        eq(attrOf(x, 'break', 'time'), '500ms');
      });
      test('positional break after a substring', function () {
        var x = toSsml('Hello world.', parse('{"break": [{"time": "300ms", "after": "Hello"}]}'));
        eq((x.match(/<break/g) || []).length, 1);
        contains(x, '>Hello<break');
        contains(x, '/> world.</speak>');
      });
      test('strength attribute preserved', function () {
        var x = toSsml('Text.', parse('{"break": {"strength": "strong", "time": "600ms"}}'));
        eq(attrOf(x, 'break', 'strength'), 'strong');
      });
      test('two positional breaks are ordered by position', function () {
        var x = toSsml('Ready set go.',
          parse('{"break": [{"time": "400", "after": "set"}, {"time": "700", "after": "Ready"}]}'));
        eq(x.indexOf('700ms') < x.indexOf('400ms'), true, 'Ready break comes first');
      });
      test('an after value not present in the text becomes trailing', function () {
        var x = toSsml('Hello world.', parse('{"break": [{"time": "300ms", "after": "nope"}]}'));
        contains(x, 'Hello world.<break');
      });
    });

    // ---------------- to_ssml: prosody --------------------------------
    group('to_ssml · prosody', function () {
      test('rate keyword fast', function () {
        var x = toSsml('This is fast.', parse('{"prosody": {"rate": "fast"}}'));
        eq(attrOf(x, 'prosody', 'rate'), 'fast');
        eq(textInside(x, 'prosody'), 'This is fast.');
      });
      test('rate keyword slow', function () {
        eq(attrOf(toSsml('Slowly.', parse('{"prosody": {"rate": "slow"}}')), 'prosody', 'rate'), 'slow');
      });
      test('150% maps to the fast keyword', function () {
        eq(attrOf(toSsml('Fast.', parse('{"prosody": {"rate": "150%"}}')), 'prosody', 'rate'), 'fast');
      });
      test('prosody wraps a break', function () {
        var x = toSsml('Slow text.', parse('{"prosody": {"rate": "slow"}, "break": {"time": "200ms"}}'));
        contains(x, '<prosody');
        eq(x.indexOf('<break') > x.indexOf('<prosody'), true, 'break is inside prosody');
        eq(x.indexOf('<break') < x.indexOf('</prosody>'), true, 'break closes before prosody');
      });
    });

    // ---------------- to_ssml: say-as ---------------------------------
    group('to_ssml · say-as', function () {
      test('characters', function () {
        var x = toSsml('NVDA', parse('{"say-as": {"interpret-as": "characters"}}'));
        eq(attrOf(x, 'say-as', 'interpret-as'), 'characters');
        eq(textInside(x, 'say-as'), 'NVDA');
      });
      test('cardinal', function () {
        eq(attrOf(toSsml('42', parse('{"say-as": {"interpret-as": "cardinal"}}')),
          'say-as', 'interpret-as'), 'cardinal');
      });
      test('extended format uses the targeted text', function () {
        var x = toSsml('The deadline was 2023-04-15 exactly.',
          parse('{"say-as": [{"text": "2023-04-15", "interpret-as": "date"}]}'));
        eq(textInside(x, 'say-as'), '2023-04-15');
      });
    });

    // ---------------- to_ssml: phoneme --------------------------------
    group('to_ssml · phoneme', function () {
      test('ipa phoneme', function () {
        var x = toSsml('pecan', parse('{"phoneme": {"ph": "pɪˈkɑːn", "alphabet": "ipa"}}'));
        eq(attrOf(x, 'phoneme', 'alphabet'), 'ipa');
        eq(attrOf(x, 'phoneme', 'ph'), 'pɪˈkɑːn');
        eq(textInside(x, 'phoneme'), 'pecan');
      });
    });

    // ---------------- to_ssml: structure -----------------------------
    group('to_ssml · structure', function () {
      test('speak carries version 1.0', function () {
        eq(attrOf(toSsml('test', parse('{"sub": {"alias": "test"}}')), 'speak', 'version'), '1.0');
      });
      test('speak carries the SSML namespace', function () {
        contains(toSsml('t', {}), 'xmlns="http://www.w3.org/2001/10/synthesis"');
      });
      test('custom lang', function () {
        eq(attrOf(toSsml('test', parse('{"sub": {"alias": "test"}}'), 'fr-FR'), 'speak', 'xml:lang'), 'fr-FR');
      });
      test('empty directives yields the plain text', function () {
        eq(stripTags(toSsml('Hello world.', {})), 'Hello world.');
      });
      test('XML special characters are escaped', function () {
        var x = toSsml('5 < 7 & "quoted"', {});
        contains(x, '5 &lt; 7 &amp; "quoted"');
      });
      test('phoneme ph attribute is attribute-escaped', function () {
        var x = toSsml('x', parse('{"phoneme": {"ph": "a\\"b"}}'));
        contains(x, 'ph="a&quot;b"');
      });
    });

    // ---------------- apply_text_only ---------------------------------
    group('apply_text_only', function () {
      test('sub applied', function () {
        eq(applyTextOnly('W3C', parse('{"sub": {"alias": "World Wide Web Consortium"}}')),
          'World Wide Web Consortium');
      });
      test('sub substring', function () {
        eq(applyTextOnly('The W3C publishes standards.',
          parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}')),
          'The World Wide Web Consortium publishes standards.');
      });
      test('break ignored', function () {
        eq(applyTextOnly('Hello world.', parse('{"break": {"time": "500ms"}}')), 'Hello world.');
      });
      test('prosody ignored', function () {
        eq(applyTextOnly('Fast text.', parse('{"prosody": {"rate": "fast"}}')), 'Fast text.');
      });
      test('phoneme ignored', function () {
        eq(applyTextOnly('pecan', parse('{"phoneme": {"ph": "abc", "alphabet": "ipa"}}')), 'pecan');
      });
    });

    // ---------------- emulation: say-as expansion ---------------------
    group('emulation · say-as expansion', function () {
      test('characters spells letters and digits', function () {
        eq(E.charactersToWords('NaCl'), 'N A C L');
        eq(E.charactersToWords('63105'), 'six three one zero five');
      });
      test('cardinal integers', function () {
        eq(E.cardinalToWords('42'), 'forty-two');
        eq(E.cardinalToWords('1024'), 'one thousand twenty-four');
        eq(E.cardinalToWords('1000000'), 'one million');
        eq(E.cardinalToWords('0'), 'zero');
        eq(E.cardinalToWords('-7'), 'minus seven');
      });
      test('cardinal decimals and separators', function () {
        eq(E.cardinalToWords('58.44'), 'fifty-eight point four four');
        eq(E.cardinalToWords('1,234'), 'one thousand two hundred thirty-four');
      });
      test('ordinals', function () {
        eq(E.ordinalToWords('1'), 'first');
        eq(E.ordinalToWords('2'), 'second');
        eq(E.ordinalToWords('3'), 'third');
        eq(E.ordinalToWords('12'), 'twelfth');
        eq(E.ordinalToWords('21'), 'twenty-first');
        eq(E.ordinalToWords('40'), 'fortieth');
        eq(E.ordinalToWords('100'), 'one hundredth');
        eq(E.ordinalToWords('1000'), 'one thousandth');
      });
      test('years read conventionally', function () {
        eq(E.yearToWords('2023'), 'twenty twenty-three');
        eq(E.yearToWords('1999'), 'nineteen ninety-nine');
        eq(E.yearToWords('2000'), 'two thousand');
        eq(E.yearToWords('2005'), 'two thousand five');
        eq(E.yearToWords('1905'), 'nineteen oh five');
        eq(E.yearToWords('1900'), 'nineteen hundred');
      });
      test('ISO and US dates', function () {
        eq(E.dateToWords('2023-04-15'), 'April fifteenth, twenty twenty-three');
        eq(E.dateToWords('4/15/2023'), 'April fifteenth, twenty twenty-three');
        eq(E.dateToWords('2024-07'), 'July twenty twenty-four');
        eq(E.dateToWords('25/12/2024'), 'December twenty-fifth, twenty twenty-four');
      });
      test('times', function () {
        eq(E.timeToWords('14:30'), 'two thirty P M');
        eq(E.timeToWords('09:05'), 'nine oh five A M');
        eq(E.timeToWords('12:00'), "twelve o'clock P M");
        eq(E.timeToWords('00:15'), 'twelve fifteen A M');
      });
      test('telephone groups digits', function () {
        eq(E.telephoneToWords('617-555-0143'),
          'six one seven, five five five, zero one four three');
      });
      test('dispatch by interpret-as', function () {
        eq(E.expandSayAs('42', 'cardinal'), 'forty-two');
        eq(E.expandSayAs('42', 'ordinal'), 'forty-second');
        eq(E.expandSayAs('AB', 'characters'), 'A B');
        eq(E.expandSayAs('anything', 'unsupported-value'), 'anything');
      });
    });

    // ---------------- emulation: piece list ---------------------------
    group('emulation · piece list', function () {
      test('plain text is one exact piece', function () {
        var r = E.emulate('Hello world.', {});
        eq(r.pieces.length, 1);
        eq(r.pieces[0].exact, true);
        eq(r.spoken, 'Hello world.');
      });
      test('whole-element sub is inexact and covers the source', function () {
        var r = E.emulate('NaCl', parse('{"sub": {"alias": "sodium chloride"}}'));
        eq(r.spoken, 'sodium chloride');
        eq(r.pieces[0].exact, false);
        eq(r.pieces[0].srcStart, 0);
        eq(r.pieces[0].srcEnd, 4);
      });
      test('substring sub splits into exact / inexact / exact', function () {
        var r = E.emulate('The W3C publishes standards.',
          parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}'));
        eq(r.spoken, 'The World Wide Web Consortium publishes standards.');
        eq(r.pieces.map(function (p) { return p.exact; }), [true, false, true]);
        eq(r.pieces[0].srcStart, 0);
        eq(r.pieces[1].srcStart, 4);
        eq(r.pieces[1].srcEnd, 7);
        eq(r.pieces[2].srcStart, 7);
      });
      test('offsets stay aligned so a boundary maps back to the source', function () {
        var r = E.emulate('The W3C publishes standards.',
          parse('{"sub": [{"text": "W3C", "alias": "World Wide Web Consortium"}]}'));
        var tail = r.pieces[2];
        eq('The W3C publishes standards.'.slice(tail.srcStart, tail.srcEnd), tail.spoken);
      });
      test('say-as expands in place', function () {
        var r = E.emulate('63105', parse('{"say-as": {"interpret-as": "characters"}}'));
        eq(r.spoken, 'six three one zero five');
      });
      test('trailing break becomes a silence piece', function () {
        var r = E.emulate('Hello.', parse('{"break": {"time": "500ms"}}'));
        eq(r.pieces.length, 2);
        eq(r.pieces[1].kind, 'silence');
        eq(r.pieces[1].ms, 500);
      });
      test('positional break splits the text', function () {
        var r = E.emulate('Ready set go.', parse('{"break": [{"time": "700", "after": "Ready"}]}'));
        eq(r.pieces.map(function (p) { return p.kind; }), ['speech', 'silence', 'speech']);
        eq(r.pieces[0].spoken, 'Ready');
        eq(r.pieces[2].spoken, ' set go.');
      });
      test('zero-length break is dropped', function () {
        var r = E.emulate('Hello.', parse('{"break": {"strength": "none"}}'));
        eq(r.pieces.length, 1);
      });
      test('prosody multiplies every speech piece rate', function () {
        var r = E.emulate('Slow text.', parse('{"prosody": {"rate": "slow"}}'));
        eq(r.pieces[0].rate, 0.75);
      });
      test('sub then prosody compose', function () {
        var r = E.emulate('NaCl', parse('{"sub": {"alias": "sodium chloride"}, "prosody": {"rate": "x-slow"}}'));
        eq(r.spoken, 'sodium chloride');
        eq(r.pieces[0].rate, 0.5);
      });
      test('phoneme without respelling leaves the spelling and notes the gap', function () {
        var r = E.emulate('pecan', parse('{"phoneme": {"ph": "pɪˈkɑːn"}}'));
        eq(r.spoken, 'pecan');
        contains(r.notes.join(' '), 'SSML-capable engine');
      });
      test('phoneme respelling is applied when enabled', function () {
        var r = E.emulate('pecan', parse('{"phoneme": {"ph": "pɪˈkɑːn"}}'),
          { phonemeRespelling: true });
        eq(r.spoken, 'pihkahn');
      });
      test('IPA respelling handles digraphs', function () {
        eq(E.ipaToRespelling('təˈmeɪtoʊ'), 'tuhmaytoh');
        eq(E.ipaToRespelling('ˈtʃɪldrən'), 'chihldruhn');
      });
      test('a sub target that is absent is reported, not silently dropped', function () {
        var r = E.emulate('Hello world.', parse('{"sub": [{"text": "W3C", "alias": "x"}]}'));
        eq(r.spoken, 'Hello world.');
        contains(r.notes.join(' '), 'not found');
      });
    });

    // ---------------- emulation: element scoping ----------------------
    // A directive applies to the text of its own element, never to the whole
    // sentence containing it. These cases pin that down.
    group('emulation · element scoping', function () {
      var scope = function (start, end, json, depth) {
        var text = arguments[4];
        return {
          parsed: parse(json), depth: depth || 0, start: start, end: end,
          text: text === undefined ? '' : text, clampedLeft: false, clampedRight: false
        };
      };

      test('whole-element sub only replaces its own span', function () {
        var text = 'A student dissolves NaCl in water.';
        var r = E.emulate(text, [scope(20, 24, '{"sub":{"alias":"sodium chloride"}}', 1, 'NaCl')]);
        eq(r.spoken, 'A student dissolves sodium chloride in water.');
      });

      test('surrounding text keeps exact source mapping', function () {
        var text = 'A student dissolves NaCl in water.';
        var r = E.emulate(text, [scope(20, 24, '{"sub":{"alias":"sodium chloride"}}', 1, 'NaCl')]);
        eq(r.pieces.map(function (p) { return p.exact; }), [true, false, true]);
        eq(text.slice(r.pieces[0].srcStart, r.pieces[0].srcEnd), 'A student dissolves ');
        eq(text.slice(r.pieces[2].srcStart, r.pieces[2].srcEnd), ' in water.');
      });

      test('say-as characters only spells its own span', function () {
        var text = 'The formula unit is NaCl.';
        var r = E.emulate(text, [scope(20, 24, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')]);
        eq(r.spoken, 'The formula unit is N A C L.');
      });

      test('three sibling say-as elements each expand independently', function () {
        var text = 'Call 617-555-0143 before 14:30 on 2024-07-01.';
        var r = E.emulate(text, [
          scope(5, 17, '{"say-as":{"interpret-as":"telephone"}}', 1, '617-555-0143'),
          scope(25, 30, '{"say-as":{"interpret-as":"time"}}', 1, '14:30'),
          scope(34, 44, '{"say-as":{"interpret-as":"date"}}', 1, '2024-07-01')
        ]);
        eq(r.spoken, 'Call six one seven, five five five, zero one four three before ' +
          'two thirty P M on July first, twenty twenty-four.');
      });

      test('phoneme only affects its own span', function () {
        var text = 'The word is pecan, not the other one.';
        var r = E.emulate(text, [scope(12, 17, '{"phoneme":{"ph":"pɪˈkɑːn"}}', 1, 'pecan')],
          { phonemeRespelling: true });
        eq(r.spoken, 'The word is pihkahn, not the other one.');
      });

      test('outer prosody wraps an inner say-as span', function () {
        var text = 'Outer AB tail.';
        var r = E.emulate(text, [
          scope(0, 14, '{"prosody":{"rate":"slow"}}', 0, text),
          scope(6, 8, '{"say-as":{"interpret-as":"characters"}}', 1, 'AB')
        ]);
        eq(r.spoken, 'Outer A B tail.');
        eq(r.pieces.every(function (p) { return p.rate === 0.75; }), true, 'rate applied to all');
      });

      test('a scoped break splits mid-sentence, not at the end', function () {
        var text = 'Take a breath and then continue.';
        var r = E.emulate(text, [scope(7, 13, '{"break":{"time":"1s"}}', 1, 'breath')]);
        eq(r.pieces.map(function (p) { return p.kind; }), ['speech', 'silence', 'speech']);
        eq(r.pieces[0].spoken, 'Take a breath');
        eq(r.pieces[1].ms, 1000);
        eq(r.pieces[2].spoken, ' and then continue.');
      });

      test('an empty element still contributes its break', function () {
        var text = 'Pause here then go.';
        var r = E.emulate(text, [scope(10, 10, '{"break":{"strength":"x-strong"}}', 1, '')]);
        eq(r.pieces.map(function (p) { return p.kind; }), ['speech', 'silence', 'speech']);
        eq(r.pieces[1].ms, 1000);
        eq(r.pieces[0].spoken + r.pieces[2].spoken, text);
      });

      test('a trailing break is deferred when the element spans further sentences', function () {
        var s = scope(0, 5, '{"break":{"time":"500ms"}}', 0, 'Hello');
        s.clampedRight = true;
        var r = E.emulate('Hello', [s]);
        eq(r.pieces.length, 1);
        contains(r.notes.join(' '), 'deferred');
      });

      test('a bare directives object still applies to the whole text', function () {
        eq(E.emulate('NaCl', parse('{"sub":{"alias":"salt"}}')).spoken, 'salt');
      });
    });

    // ---------------- composeSsml -------------------------------------
    group('composeSsml · sentence-level markup', function () {
      var compose = root.DataSsmlToSsml.composeSsml;
      var scope = function (start, end, json, depth, text) {
        return {
          parsed: parse(json), depth: depth || 0, start: start, end: end,
          text: text || '', clampedLeft: false, clampedRight: false
        };
      };

      test('markup wraps only the element it belongs to', function () {
        var x = compose('The formula unit is NaCl.',
          [scope(20, 24, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')]);
        contains(x, '>The formula unit is <say-as interpret-as="characters">NaCl</say-as>.<');
      });

      test('whole-element sub substitutes text without adding markup', function () {
        var x = compose('A student dissolves NaCl in water.',
          [scope(20, 24, '{"sub":{"alias":"sodium chloride"}}', 1, 'NaCl')]);
        contains(x, 'A student dissolves sodium chloride in water.');
        eq(/<(?!\/?speak)/.test(x), false, 'no extra elements');
      });

      test('three siblings each get their own element', function () {
        var x = compose('Call 617-555-0143 before 14:30 on 2024-07-01.', [
          scope(5, 17, '{"say-as":{"interpret-as":"telephone"}}', 1, '617-555-0143'),
          scope(25, 30, '{"say-as":{"interpret-as":"time"}}', 1, '14:30'),
          scope(34, 44, '{"say-as":{"interpret-as":"date"}}', 1, '2024-07-01')
        ]);
        eq((x.match(/<say-as /g) || []).length, 3);
        contains(x, 'interpret-as="telephone">617-555-0143</say-as>');
        contains(x, 'interpret-as="time">14:30</say-as>');
        contains(x, 'interpret-as="date">2024-07-01</say-as>');
      });

      test('nesting produces nested elements', function () {
        var x = compose('Outer AB tail.', [
          scope(0, 14, '{"prosody":{"rate":"slow"}}', 0, 'Outer AB tail.'),
          scope(6, 8, '{"say-as":{"interpret-as":"characters"}}', 1, 'AB')
        ]);
        contains(x, '<prosody rate="slow">Outer <say-as interpret-as="characters">AB</say-as> tail.</prosody>');
      });

      test('phoneme wraps its own word', function () {
        var x = compose('The word is pecan here.',
          [scope(12, 17, '{"phoneme":{"ph":"pɪˈkɑːn","alphabet":"ipa"}}', 1, 'pecan')]);
        contains(x, 'The word is <phoneme alphabet="ipa" ph="pɪˈkɑːn">pecan</phoneme> here.');
      });

      test('a scoped break lands after its element', function () {
        var x = compose('Take a breath and then continue.',
          [scope(7, 13, '{"break":{"time":"1s"}}', 1, 'breath')]);
        contains(x, 'Take a breath<break time="1000ms" strength="medium" /> and then continue.');
      });

      test('extended-format substring targets are wrapped', function () {
        var x = compose('The deadline was 2023-04-15 exactly.',
          [scope(0, 36, '{"say-as":[{"text":"2023-04-15","interpret-as":"date"}]}', 0,
            'The deadline was 2023-04-15 exactly.')]);
        contains(x, '<say-as interpret-as="date">2023-04-15</say-as>');
      });

      test('extended-format sub is applied as text', function () {
        var x = compose('The W3C publishes standards.',
          [scope(0, 28, '{"sub":[{"text":"W3C","alias":"World Wide Web Consortium"}]}', 0,
            'The W3C publishes standards.')]);
        contains(x, 'The World Wide Web Consortium publishes standards.');
      });

      test('text outside every scope is preserved and escaped', function () {
        var x = compose('5 < 7 and AB.',
          [scope(10, 12, '{"say-as":{"interpret-as":"characters"}}', 1, 'AB')]);
        contains(x, '5 &lt; 7 and <say-as');
      });

      test('keyword rates stay keywords', function () {
        contains(compose('x', [scope(0, 1, '{"prosody":{"rate":"slow"}}', 0, 'x')]),
          '<prosody rate="slow">');
      });

      test('a percentage rate is preserved rather than snapped to a keyword', function () {
        // to_ssml() reproduces the reference library and yields "medium" here.
        eq(attrOf(toSsml('x', parse('{"prosody":{"rate":"90%"}}')), 'prosody', 'rate'), 'medium');
        contains(compose('x', [scope(0, 1, '{"prosody":{"rate":"90%"}}', 0, 'x')]),
          '<prosody rate="90%">');
      });

      test('no scopes yields the plain sentence', function () {
        eq(stripTags(compose('Just text.', [])), 'Just text.');
      });

      test('speak element carries version, namespace, and lang', function () {
        var x = compose('t', [], 'fr-FR');
        contains(x, 'version="1.0"');
        contains(x, 'xmlns="http://www.w3.org/2001/10/synthesis"');
        contains(x, 'xml:lang="fr-FR"');
      });
    });

    // ---------------- partial-SSML engines ----------------------------
    // An engine that consumes only some SSML gets those tags passed through
    // while the rest of the directives are still emulated.
    group('emulation · native tag passthrough', function () {
      var NATIVE = { 'break': true, phoneme: true, phonemeAlphabets: ['ipa'], breakMaxMs: 3000 };
      var scope = function (start, end, json, depth, text) {
        return {
          parsed: parse(json), depth: depth || 0, start: start, end: end,
          text: text || '', clampedLeft: false, clampedRight: false
        };
      };

      test('a trailing break becomes a tag, not a client-side silence', function () {
        var r = E.emulate('Take a breath.', parse('{"break":{"time":"1s"}}'),
          { nativeTags: NATIVE });
        eq(r.pieces.some(function (p) { return p.kind === 'silence'; }), false);
        eq(r.spoken, 'Take a breath.<break time="1s" />');
      });

      test('a positional break is placed inline', function () {
        var r = E.emulate('Take a breath and go.',
          [scope(7, 13, '{"break":{"time":"1s"}}', 1, 'breath')], { nativeTags: NATIVE });
        eq(r.spoken, 'Take a breath<break time="1s" /> and go.');
      });

      test('break strength converts to a time the engine accepts', function () {
        var r = E.emulate('Wait.', parse('{"break":{"strength":"weak"}}'),
          { nativeTags: NATIVE });
        contains(r.spoken, '<break time="0.2s" />');
      });

      test('a break longer than the engine allows is clamped', function () {
        var r = E.emulate('Wait.', parse('{"break":{"time":"9s"}}'), { nativeTags: NATIVE });
        contains(r.spoken, '<break time="3s" />');
      });

      test('phoneme is wrapped in native markup', function () {
        var r = E.emulate('pecan', parse('{"phoneme":{"ph":"pɪˈkɑːn","alphabet":"ipa"}}'),
          { nativeTags: NATIVE });
        eq(r.spoken, '<phoneme alphabet="ipa" ph="pɪˈkɑːn">pecan</phoneme>');
        contains(r.notes.join(' '), 'native <phoneme> markup');
      });

      test('an alphabet the engine does not accept falls back to emulation', function () {
        var r = E.emulate('pecan', parse('{"phoneme":{"ph":"pIkA:n","alphabet":"x-sampa"}}'),
          { nativeTags: NATIVE });
        notContains(r.spoken, '<phoneme');
        contains(r.notes.join(' '), 'SSML-capable engine');
      });

      test('sub is still emulated because the engine has no sub', function () {
        var r = E.emulate('The W3C ships specs.',
          [scope(4, 7, '{"sub":{"alias":"World Wide Web Consortium"}}', 1, 'W3C')],
          { nativeTags: NATIVE });
        eq(r.spoken, 'The World Wide Web Consortium ships specs.');
        notContains(r.spoken, '<sub');
      });

      test('say-as is still expanded in place', function () {
        var r = E.emulate('Unit is NaCl.',
          [scope(8, 12, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')],
          { nativeTags: NATIVE });
        eq(r.spoken, 'Unit is N A C L.');
        notContains(r.spoken, '<say-as');
      });

      test('prosody still becomes a playback rate', function () {
        var r = E.emulate('Slow.', parse('{"prosody":{"rate":"slow"}}'), { nativeTags: NATIVE });
        eq(r.pieces[0].rate, 0.75);
        notContains(r.spoken, '<prosody');
      });

      test('markup pieces carry no source range, so highlighting skips them', function () {
        var r = E.emulate('Take a breath.', parse('{"break":{"time":"1s"}}'),
          { nativeTags: NATIVE });
        var tag = r.pieces.filter(function (p) { return p.markup; })[0];
        truthy(tag, 'markup piece present');
        eq(tag.srcStart, tag.srcEnd);
      });

      test('text around native markup keeps exact source mapping', function () {
        var text = 'Take a breath and go.';
        var r = E.emulate(text, [scope(7, 13, '{"break":{"time":"1s"}}', 1, 'breath')],
          { nativeTags: NATIVE });
        var exact = r.pieces.filter(function (p) { return p.exact; });
        exact.forEach(function (p) {
          eq(text.slice(p.srcStart, p.srcEnd), p.spoken, 'piece maps back');
        });
      });

      test('without nativeTags the same input is fully emulated', function () {
        var r = E.emulate('Take a breath.', parse('{"break":{"time":"1s"}}'));
        eq(r.pieces.some(function (p) { return p.kind === 'silence'; }), true);
        notContains(r.spoken, '<break');
      });
    });

    // ---------------- mark-instrumented SSML --------------------------
    // Cloud engines report the time they reach each <mark>; these cases pin
    // down where marks may appear and that the table maps back to the source.
    group('composeSsmlWithMarks', function () {
      var withMarks = root.DataSsmlToSsml.composeSsmlWithMarks;
      var scope = function (start, end, json, depth, text) {
        return {
          parsed: parse(json), depth: depth || 0, start: start, end: end,
          text: text || '', clampedLeft: false, clampedRight: false
        };
      };

      test('one mark per word in plain text', function () {
        var r = withMarks('Alpha bravo charlie.', []);
        eq(r.marks.length, 3);
        eq((r.ssml.match(/<mark /g) || []).length, 3);
      });

      test('the mark table maps back to the source words', function () {
        var text = 'Alpha bravo charlie.';
        var r = withMarks(text, []);
        eq(r.marks.map(function (m) { return text.slice(m.srcStart, m.srcEnd); }),
          ['Alpha', 'bravo', 'charlie.']);
      });

      test('marks precede the word they time', function () {
        var r = withMarks('Alpha bravo', []);
        contains(r.ssml, '<mark name="m0"/>Alpha <mark name="m1"/>bravo');
      });

      test('a reinterpreting element gets one mark, placed outside it', function () {
        var text = 'Unit is NaCl.';
        var r = withMarks(text, [scope(8, 12, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')]);
        contains(r.ssml, '<mark name="m2"/><say-as interpret-as="characters">NaCl</say-as>');
        var elementMark = r.marks[2];
        eq(text.slice(elementMark.srcStart, elementMark.srcEnd), 'NaCl');
      });

      test('no marks are placed inside say-as, sub, or phoneme content', function () {
        var r = withMarks('Say NaCl now.', [
          scope(4, 8, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')
        ]);
        eq(/<say-as[^>]*>[^<]*<mark/.test(r.ssml), false, 'no mark inside say-as');
      });

      test('marks appear inside a prosody element', function () {
        var r = withMarks('Slow words here.', [
          scope(0, 16, '{"prosody":{"rate":"slow"}}', 0, 'Slow words here.')
        ]);
        contains(r.ssml, '<prosody rate="slow"><mark name="m0"/>Slow');
        eq(r.marks.length, 3);
      });

      test('mark names are unique and sequential', function () {
        var r = withMarks('One two three four.', []);
        eq(r.marks.map(function (m) { return m.name; }), ['m0', 'm1', 'm2', 'm3']);
      });

      test('the unmarked composer output stays free of marks', function () {
        notContains(root.DataSsmlToSsml.composeSsml('Alpha bravo', []), '<mark');
      });

      test('marked and unmarked output agree once marks are stripped', function () {
        var scopes = [scope(8, 12, '{"say-as":{"interpret-as":"characters"}}', 1, 'NaCl')];
        var marked = withMarks('Unit is NaCl.', scopes).ssml.replace(/<mark name="m\d+"\/>/g, '');
        eq(marked, root.DataSsmlToSsml.composeSsml('Unit is NaCl.', scopes));
      });
    });

    // ---------------- cloud provider helpers --------------------------
    group('cloud providers', function () {
      var P = root.TtsProviders;

      test('the registry exposes every backend', function () {
        eq(P.list().map(function (p) { return p.id; }).sort(),
          ['azure', 'elevenlabs', 'google', 'polly', 'webspeech']);
      });

      test('every cloud backend declares SSML support', function () {
        ['polly', 'azure', 'google', 'elevenlabs'].forEach(function (id) {
          eq(P.get(id).kind, 'audio', id + ' kind');
          eq(P.get(id).supports.ssml, true, id + ' ssml');
        });
      });

      test('only ElevenLabs declares a partial SSML subset', function () {
        ['polly', 'azure', 'google'].forEach(function (id) {
          eq(P.get(id).supports.ssmlSubset, null, id + ' is a full SSML engine');
        });
        var subset = P.get('elevenlabs').supports.ssmlSubset;
        truthy(subset, 'elevenlabs subset');
        eq(subset['break'], true);
      });

      test('the browser backend declares no SSML input', function () {
        eq(P.get('webspeech').supports.ssml, false);
      });

      test('only the backends that report timings claim word marks', function () {
        eq(P.get('polly').supports.wordMarks, true);
        eq(P.get('google').supports.wordMarks, true);
        eq(P.get('azure').supports.wordMarks, false);
      });

      test('cloud backends require credentials and start unconfigured', function () {
        ['polly', 'azure', 'google', 'elevenlabs'].forEach(function (id) {
          truthy(P.get(id).credentialFields.length, id + ' has credential fields');
        });
      });

      test('retagSpeak strips attributes for Polly', function () {
        eq(P.retagSpeak('<speak version="1.0" xmlns="x" xml:lang="en">hi</speak>', ''),
          '<speak>hi</speak>');
      });

      test('Azure SSML names the voice and carries the locale', function () {
        var out = P.get('azure')._toAzureSsml(
          '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">' +
          'Unit is <say-as interpret-as="characters">NaCl</say-as>.</speak>',
          'en-US-JennyNeural', 'en-US');
        contains(out, 'xml:lang="en-US"');
        contains(out, '<voice name="en-US-JennyNeural">');
        contains(out, '<say-as interpret-as="characters">NaCl</say-as>');
        contains(out, '</voice></speak>');
      });

      test('Polly speech marks parse to name and time', function () {
        var raw = [
          '{"time":0,"type":"sentence","start":0,"end":12,"value":"Unit is NaCl"}',
          '{"time":6,"type":"ssml","start":30,"end":48,"value":"m0"}',
          '{"time":312,"type":"ssml","start":60,"end":78,"value":"m1"}',
          ''
        ].join('\n');
        eq(P.get('polly')._parseSpeechMarks(raw),
          [{ name: 'm0', timeMs: 6 }, { name: 'm1', timeMs: 312 }]);
      });

      test('ElevenLabs enables phoneme passthrough only on models that apply it', function () {
        var eleven = P.get('elevenlabs');
        eq(eleven._subsetFor('eleven_multilingual_v2').phoneme, false);
        eq(eleven._subsetFor('eleven_flash_v2_5').phoneme, false);
        eq(eleven._subsetFor('eleven_turbo_v2').phoneme, true);
        eq(eleven._subsetFor('eleven_flash_v2').phoneme, true);
      });

      test('ElevenLabs drops break passthrough on the model that lost the tag', function () {
        var eleven = P.get('elevenlabs');
        eq(eleven._subsetFor('eleven_multilingual_v2')['break'], true);
        eq(eleven._subsetFor('eleven_v3')['break'], false);
      });

      test('ElevenLabs caps a break at the 3 second maximum it honours', function () {
        eq(root.SsmlEmulate.breakTagFor({ time_ms: 8000 },
          P.get('elevenlabs')._subsetFor('eleven_multilingual_v2')),
          '<break time="3s" />');
      });

      test('ElevenLabs alignment maps to word marks over the sent string', function () {
        var eleven = P.get('elevenlabs');
        var sent = 'Hi there';
        var marks = eleven._alignmentToMarks({
          characters: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e'],
          character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
        }, sent);
        eq(marks.length, 2);
        eq(sent.substr(marks[0].outStart, marks[0].outLen), 'Hi');
        eq(sent.substr(marks[1].outStart, marks[1].outLen), 'there');
        eq(marks[1].timeMs, 300);
      });

      test('alignment offsets survive inline tags the alignment omits', function () {
        var eleven = P.get('elevenlabs');
        // The engine reports the spoken characters; the sent string also holds
        // a <break> tag, so offsets must skip over it.
        var sent = 'Hi<break time="1s" /> there';
        var marks = eleven._alignmentToMarks({
          characters: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e'],
          character_start_times_seconds: [0, 0.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7]
        }, sent);
        eq(marks.length, 2);
        eq(sent.substr(marks[0].outStart, marks[0].outLen), 'Hi');
        eq(sent.substr(marks[1].outStart, marks[1].outLen), 'there');
      });

      test('Polly picks the neural engine when a voice supports it', function () {
        var polly = P.get('polly');
        eq(polly._engineFor({ raw: { SupportedEngines: ['standard', 'neural'] } }), 'neural');
        eq(polly._engineFor({ raw: { SupportedEngines: ['standard'] } }), 'standard');
        eq(polly._engineFor(null), 'standard');
      });

      test('textToSsml escapes and carries the language', function () {
        var out = P.textToSsml('5 < 7 & up', 'fr-FR');
        contains(out, 'xml:lang="fr-FR"');
        contains(out, '5 &lt; 7 &amp; up');
      });

      if (typeof Blob !== 'undefined' && typeof btoa !== 'undefined') {
        test('base64ToBlob produces bytes of the right length', function () {
          var blob = P.base64ToBlob(btoa('hello'), 'audio/mpeg');
          eq(blob.size, 5);
          eq(blob.type, 'audio/mpeg');
        });
      }
    });

    // ---------------- directive merging -------------------------------
    group('directive merging', function () {
      test('inner element overrides the same key', function () {
        var merged = root.DataSsmlParser.mergeDirectives([
          parse('{"prosody": {"rate": "slow"}, "say-as": {"interpret-as": "cardinal"}}'),
          parse('{"say-as": {"interpret-as": "characters"}}')
        ]);
        eq(merged.say_as[0].interpret_as, 'characters');
        eq(merged.prosody.rate_multiplier, 0.75, 'outer prosody inherited');
      });
      test('outer keys the inner omits are inherited', function () {
        var merged = root.DataSsmlParser.mergeDirectives([
          parse('{"prosody": {"rate": "fast"}}'),
          parse('{"sub": {"alias": "x"}}')
        ]);
        eq(Object.keys(merged).sort(), ['prosody', 'sub']);
      });
    });

    // ---------------- validation advisories ---------------------------
    group('validation advisories', function () {
      test('off-spec interpret-as warns but parses', function () {
        var parsed = parse('{"say-as": {"interpret-as": "fraction"}}');
        eq(parsed.say_as[0].interpret_as, 'fraction');
        eq(root.DataSsmlParser.validate(parsed).length, 1);
      });
      test('non-SSML alphabet warns', function () {
        eq(root.DataSsmlParser.validate(parse('{"phoneme": {"ph": "x", "alphabet": "klingon"}}')).length, 1);
      });
      test('spec-conformant values produce no warnings', function () {
        eq(root.DataSsmlParser.validate(parse('{"say-as": {"interpret-as": "date"}}')), []);
      });
    });

    // ---------------- segmenter (DOM required) ------------------------
    if (typeof document !== 'undefined' && root.Segmenter) {
      group('segmenter', function () {
        var withFixture = function (html, fn) {
          var host = document.createElement('div');
          host.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:600px');
          host.innerHTML = html;
          document.body.appendChild(host);
          try {
            fn(root.Segmenter.build(host, { locale: 'en' }), host);
          } finally {
            document.body.removeChild(host);
          }
        };

        test('splits a paragraph into sentences', function () {
          withFixture('<p>One two. Three four. Five six.</p>', function (m) {
            eq(m.units.length, 3);
            eq(m.units[0].text, 'One two.');
          });
        });
        test('block boundaries prevent sentence merging', function () {
          withFixture('<p>No terminal punctuation</p><p>Second block</p>', function (m) {
            eq(m.units.length, 2);
          });
        });
        test('directives on an ancestor reach each sentence', function () {
          withFixture('<p data-ssml=\'{"prosody":{"rate":"slow"}}\'>First. Second.</p>', function (m) {
            eq(m.units.length, 2);
            eq(m.units[0].directives.prosody.rate_multiplier, 0.75);
            eq(m.units[1].directives.prosody.rate_multiplier, 0.75);
          });
        });
        test('an atomic whole-element sub is never split', function () {
          withFixture('<p><span data-ssml=\'{"sub":{"alias":"ASAP"}}\'>One. Two. Three.</span></p>',
            function (m) {
              eq(m.units.length, 1);
              eq(m.units[0].atomic, true);
            });
        });
        test('invalid attributes are recorded and do not throw', function () {
          withFixture('<p><span data-ssml=\'not json\'>alpha</span> beta.</p>', function (m) {
            eq(m.ssmlSpans.length, 1);
            truthy(m.ssmlSpans[0].error, 'error recorded');
            eq(m.units.length, 1, 'content still readable');
          });
        });
        test('aria-hidden content is skipped', function () {
          withFixture('<p>Spoken.</p><p aria-hidden="true">Hidden.</p>', function (m) {
            eq(m.units.length, 1);
            eq(m.units[0].text, 'Spoken.');
          });
        });
        test('offsets round-trip to a DOM range', function () {
          withFixture('<p>Alpha bravo charlie.</p>', function (m) {
            var range = root.Segmenter.rangeFor(m.nodes, m.units[0].start, m.units[0].end);
            truthy(range, 'range built');
            eq(range.toString(), 'Alpha bravo charlie.');
          });
        });
        test('word expansion covers whole words', function () {
          var bounds = root.Segmenter.expandToWord('Alpha bravo charlie.', 7, 1);
          eq('Alpha bravo charlie.'.slice(bounds[0], bounds[1]), 'bravo');
        });
        test('nested spans merge outermost-first', function () {
          withFixture('<p data-ssml=\'{"prosody":{"rate":"slow"}}\'>Outer ' +
            '<span data-ssml=\'{"say-as":{"interpret-as":"characters"}}\'>AB</span> tail.</p>',
            function (m) {
              var unit = m.units[0];
              eq(unit.directives.prosody.rate_multiplier, 0.75);
              eq(unit.directives.say_as[0].interpret_as, 'characters');
            });
        });
      });
    }

    // ---------------- playback engine (DOM + stub synthesizer) --------
    // Drives the transport with a substituted synthesizer so the queue,
    // silences, and boundary mapping can be checked without audio.
    if (typeof document !== 'undefined' && root.TtsEngine && root.Segmenter) {
      group('playback engine', function () {
        function StubUtterance(text) {
          this.text = text;
          this.onend = null;
          this.onerror = null;
          this.onboundary = null;
        }

        // Speaks synchronously: emits a boundary per word, then ends.
        function stubSynth(record) {
          return {
            speaking: false,
            pending: false,
            paused: false,
            speak: function (utt) {
              record.spoken.push(utt.text);
              record.rates.push(utt.rate);
              if (utt.onboundary) {
                var re = /\S+/g;
                var m;
                while ((m = re.exec(utt.text)) !== null) {
                  utt.onboundary({ name: 'word', charIndex: m.index, charLength: m[0].length });
                }
              }
              if (utt.onend) utt.onend();
            },
            cancel: function () {},
            pause: function () {},
            resume: function () {}
          };
        }

        function drive(html, config, fn) {
          var host = document.createElement('div');
          host.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:600px');
          host.innerHTML = html;
          document.body.appendChild(host);

          var record = { spoken: [], rates: [], units: [], words: [], silences: [] };
          var realSynth = root.TtsEngine.synth;
          var realUtt = root.TtsEngine.Utterance;
          var realTimeout = window.setTimeout;

          root.TtsEngine.Utterance = StubUtterance;
          root.TtsEngine.synth = stubSynth(record);
          // Run silences immediately so the whole queue drains synchronously.
          window.setTimeout = function (cb, ms) { record.silences.push(ms); cb(); return 0; };

          try {
            var model = root.Segmenter.build(host, { locale: 'en' });
            var engine = new root.TtsEngine({});
            engine.on('unitStart', function (p) { record.units.push(p.unit.index); });
            engine.on('word', function (p) {
              record.words.push(model.units[p.unitIndex].text.slice(p.start, p.end));
            });
            engine.prepare(model.units, config || { mode: 'emulate', rate: 1 });
            engine.play();
            fn(record, engine, model);
          } finally {
            root.TtsEngine.synth = realSynth;
            root.TtsEngine.Utterance = realUtt;
            window.setTimeout = realTimeout;
            document.body.removeChild(host);
          }
        }

        test('speaks every sentence in order and finishes idle', function () {
          drive('<p>One two. Three four.</p>', null, function (rec, engine) {
            eq(rec.spoken, ['One two.', 'Three four.']);
            eq(rec.units, [0, 1]);
            eq(engine.state, 'idle');
          });
        });

        test('a scoped sub is spoken expanded, in place', function () {
          drive('<p>A student dissolves ' +
            '<span data-ssml=\'{"sub":{"alias":"sodium chloride"}}\'>NaCl</span> in water.</p>',
            null, function (rec) {
              eq(rec.spoken, ['A student dissolves sodium chloride in water.']);
            });
        });

        test('a break becomes a real silence between utterances', function () {
          drive('<p>Take a <span data-ssml=\'{"break":{"time":"1s"}}\'>breath</span> and go.</p>',
            null, function (rec) {
              eq(rec.spoken, ['Take a breath', ' and go.']);
              eq(rec.silences, [1000]);
            });
        });

        test('prosody sets the utterance rate', function () {
          drive('<p data-ssml=\'{"prosody":{"rate":"slow"}}\'>Slow sentence.</p>',
            { mode: 'emulate', rate: 2 }, function (rec) {
              eq(rec.rates, [1.5]);  // base 2 × 0.75
            });
        });

        test('boundary events map back to the visible words', function () {
          drive('<p>Alpha bravo charlie.</p>', null, function (rec) {
            eq(rec.words, ['Alpha', 'bravo', 'charlie.']);
          });
        });

        test('boundaries after a substitution point at the source span', function () {
          drive('<p>The <span data-ssml=\'{"sub":{"alias":"World Wide Web Consortium"}}\'>W3C</span> ships specs.</p>',
            null, function (rec) {
              // Every rewritten word highlights the source token it came from.
              eq(rec.words.indexOf('W3C') !== -1, true, 'source token highlighted');
              eq(rec.words[0], 'The');
              eq(rec.words[rec.words.length - 1], 'specs.');
            });
        });

        test('plain mode applies sub and drops the rest', function () {
          drive('<p><span data-ssml=\'{"sub":{"alias":"salt"},"break":{"time":"1s"}}\'>NaCl</span> dissolves.</p>',
            { mode: 'plain', rate: 1 }, function (rec) {
              eq(rec.spoken, ['salt dissolves.']);
              eq(rec.silences, []);
            });
        });

        test('ssml mode sends one markup document per sentence', function () {
          drive('<p>Unit is <span data-ssml=\'{"say-as":{"interpret-as":"characters"}}\'>NaCl</span>.</p>',
            { mode: 'ssml', rate: 1 }, function (rec) {
              eq(rec.spoken.length, 1);
              contains(rec.spoken[0], '<say-as interpret-as="characters">NaCl</say-as>');
              eq(rec.words, [], 'no word highlighting in ssml mode');
            });
        });

        test('play(n) starts from the requested sentence', function () {
          drive('<p>One. Two. Three.</p>', null, function (rec, engine) {
            rec.spoken.length = 0;
            rec.units.length = 0;
            engine.play(2);
            eq(rec.spoken, ['Three.']);
            eq(rec.units, [2]);
          });
        });

        test('stop clears state and reports the reason', function () {
          drive('<p>One. Two.</p>', null, function (rec, engine) {
            var reason = null;
            engine.on('end', function (p) { reason = p.reason; });
            engine.stop();
            eq(engine.state, 'idle');
            eq(engine.currentUnitIndex, -1);
            eq(reason, 'stopped');
          });
        });
      });
    }

    // ---------------- AWS SigV4 ---------------------------------------
    // Checked against the published AWS "get-vanilla" signing test vector, so a
    // signing regression shows up here rather than as a 403 from Polly.
    if (typeof window !== 'undefined' && root.AwsSigV4 && window.crypto && window.crypto.subtle) {
      group('AWS SigV4', function () {
        var VECTOR = {
          accessKeyId: 'AKIDEXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
          region: 'us-east-1',
          service: 'service',
          date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
          expected: 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/' +
            'aws4_request, SignedHeaders=host;x-amz-date, Signature=' +
            '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
        };

        atest('matches the published get-vanilla vector', function () {
          return root.AwsSigV4.sign({
            method: 'GET',
            url: 'https://example.amazonaws.com/',
            body: '',
            headers: {},
            service: VECTOR.service,
            region: VECTOR.region,
            accessKeyId: VECTOR.accessKeyId,
            secretAccessKey: VECTOR.secretAccessKey,
            date: VECTOR.date
          }).then(function (headers) {
            eq(headers.Authorization, VECTOR.expected);
            eq(headers['X-Amz-Date'], '20150830T123600Z');
          });
        });

        atest('signs the content-type header a JSON POST will send', function () {
          return root.AwsSigV4.sign({
            method: 'POST',
            url: 'https://polly.us-east-1.amazonaws.com/v1/speech',
            body: '{"Text":"hi"}',
            headers: { 'Content-Type': 'application/json' },
            service: 'polly',
            region: 'us-east-1',
            accessKeyId: VECTOR.accessKeyId,
            secretAccessKey: VECTOR.secretAccessKey,
            date: VECTOR.date
          }).then(function (headers) {
            contains(headers.Authorization, 'SignedHeaders=content-type;host;x-amz-date');
            eq(headers['Content-Type'], 'application/json');
          });
        });

        atest('a session token is signed and forwarded', function () {
          return root.AwsSigV4.sign({
            method: 'GET',
            url: 'https://polly.us-east-1.amazonaws.com/v1/voices',
            body: '',
            headers: {},
            service: 'polly',
            region: 'us-east-1',
            accessKeyId: VECTOR.accessKeyId,
            secretAccessKey: VECTOR.secretAccessKey,
            sessionToken: 'FwoGZXIvYXdzEXAMPLE',
            date: VECTOR.date
          }).then(function (headers) {
            contains(headers.Authorization, 'SignedHeaders=host;x-amz-date;x-amz-security-token');
            eq(headers['X-Amz-Security-Token'], 'FwoGZXIvYXdzEXAMPLE');
          });
        });

        atest('the Host header is signed but never set on the request', function () {
          return root.AwsSigV4.sign({
            method: 'GET',
            url: 'https://polly.eu-west-1.amazonaws.com/v1/voices',
            body: '',
            headers: {},
            service: 'polly',
            region: 'eu-west-1',
            accessKeyId: VECTOR.accessKeyId,
            secretAccessKey: VECTOR.secretAccessKey,
            date: VECTOR.date
          }).then(function (headers) {
            contains(headers.Authorization, 'host');
            eq(headers.host === undefined && headers.Host === undefined, true,
              'no host header returned');
          });
        });

        atest('the query string is canonicalized in sorted order', function () {
          eq(root.AwsSigV4._canonicalQuery({ b: '2', a: '1', 'A z': 'x/y' }),
            'A%20z=x%2Fy&a=1&b=2');
          return Promise.resolve();
        });
      });
    }

    // ---------------- cloud playback path -----------------------------
    // Drives the audio backend with a stub provider and stub player, so the
    // synthesize → marks → highlight → advance chain is covered without audio
    // or network.
    if (typeof document !== 'undefined' && root.TtsEngine && root.Segmenter) {
      group('playback engine · cloud backend', function () {
        function StubPlayer() { this.stopped = false; }
        StubPlayer.prototype.play = function (blob, options) {
          (options.marks || []).forEach(function (mark) { options.onMark(mark); });
          options.onEnd();
        };
        StubPlayer.prototype.pause = function () {};
        StubPlayer.prototype.resume = function () {};
        StubPlayer.prototype.stop = function () { this.stopped = true; };
        StubPlayer.prototype.setVolume = function () {};
        StubPlayer.prototype.setPlaybackRate = function () {};

        function stubProvider(record, options) {
          options = options || {};
          return {
            id: 'stub',
            name: 'Stub Cloud',
            kind: 'audio',
            supports: {
              ssml: true,
              wordMarks: options.wordMarks !== false,
              pitch: true,
              ssmlSubset: options.ssmlSubset || null,
              markAlignment: !!options.markAlignment
            },
            credentialFields: [],
            configure: function () {},
            isConfigured: function () { return true; },
            describeConfig: function () { return 'stub'; },
            listVoices: function () { return Promise.resolve([]); },
            synthesize: function (req) {
              record.requests.push(req);
              // Report a timing mark for every <mark> in the submitted SSML.
              var names = [];
              var re = /<mark name="([^"]+)"\/>/g;
              var m;
              while ((m = re.exec(req.ssml || '')) !== null) names.push(m[1]);
              return Promise.resolve({
                blob: new Blob(['audio'], { type: 'audio/mpeg' }),
                marks: names.map(function (name, i) {
                  return { name: name, timeMs: i * 100 };
                }),
                warnings: options.warnings || []
              });
            }
          };
        }

        function driveCloud(html, config, providerOptions) {
          var host = document.createElement('div');
          host.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:600px');
          host.innerHTML = html;
          document.body.appendChild(host);

          var record = { requests: [], units: [], words: [], logs: [], ended: null };
          var realPlayer = root.TtsEngine.PlayerClass;
          root.TtsEngine.PlayerClass = StubPlayer;

          try {
            var model = root.Segmenter.build(host, { locale: 'en' });
            var provider = stubProvider(record, providerOptions);
            var engine = new root.TtsEngine({ provider: provider });

            engine.on('unitStart', function (p) { record.units.push(p.unit.index); });
            engine.on('word', function (p) {
              record.words.push(model.units[p.unitIndex].text.slice(p.start, p.end));
            });
            engine.on('log', function (p) { record.logs.push(p.level + ': ' + p.message); });
            engine.on('end', function (p) { record.ended = p.reason; });

            engine.prepare(model.units, Object.assign(
              { mode: 'ssml', rate: 1, wordMarks: true }, config || {}));
            engine.play();

            // The stub resolves on a microtask, so let the queue drain.
            return new Promise(function (resolve) {
              setTimeout(function () {
                resolve({ record: record, engine: engine, model: model });
                document.body.removeChild(host);
                root.TtsEngine.PlayerClass = realPlayer;
              }, 0);
            });
          } catch (err) {
            document.body.removeChild(host);
            root.TtsEngine.PlayerClass = realPlayer;
            throw err;
          }
        }

        atest('SSML is sent to the service, one request per sentence', function () {
          return driveCloud('<p>One two. Three four.</p>').then(function (r) {
            eq(r.record.requests.length, 2);
            eq(r.record.requests.every(function (q) { return !!q.ssml && !q.text; }), true,
              'all requests carry SSML');
            eq(r.record.ended, 'complete');
          });
        });

        atest('directives reach the service as markup, not as emulation', function () {
          return driveCloud('<p>Unit is ' +
            '<span data-ssml=\'{"say-as":{"interpret-as":"characters"}}\'>NaCl</span>.</p>')
            .then(function (r) {
              contains(r.record.requests[0].ssml,
                '<say-as interpret-as="characters">NaCl</say-as>');
            });
        });

        atest('timing marks drive word highlighting back onto the source', function () {
          return driveCloud('<p>Alpha bravo charlie.</p>').then(function (r) {
            eq(r.record.words, ['Alpha', 'bravo', 'charlie.']);
          });
        });

        atest('a reinterpreted element highlights as one span', function () {
          return driveCloud('<p>The ' +
            '<span data-ssml=\'{"sub":{"alias":"World Wide Web Consortium"}}\'>W3C</span> ships.</p>')
            .then(function (r) {
              eq(r.record.words, ['The', 'W3C', 'ships.']);
            });
        });

        atest('marks are not requested when the service reports none', function () {
          return driveCloud('<p>Alpha bravo.</p>', null, { wordMarks: false })
            .then(function (r) {
              notContains(r.record.requests[0].ssml, '<mark');
              eq(r.record.words, []);
            });
        });

        atest('provider warnings surface in the log', function () {
          return driveCloud('<p>Alpha.</p>', null, { warnings: ['neural caveat'] })
            .then(function (r) {
              contains(r.record.logs.join('\n'), 'warn: neural caveat');
            });
        });

        atest('emulate mode on a cloud voice sends plain text instead', function () {
          return driveCloud('<p>The ' +
            '<span data-ssml=\'{"sub":{"alias":"sodium chloride"}}\'>NaCl</span> sample.</p>',
            { mode: 'emulate' }).then(function (r) {
              eq(r.record.requests[0].ssml, null);
              eq(r.record.requests[0].text, 'The sodium chloride sample.');
            });
        });

        atest('a partial-SSML service gets inline tags plus emulated directives', function () {
          return driveCloud(
            '<p>The <span data-ssml=\'{"sub":{"alias":"World Wide Web Consortium"}}\'>W3C</span> ' +
            'said <span data-ssml=\'{"break":{"time":"1s"}}\'>wait</span> here.</p>',
            null,
            { ssmlSubset: { 'break': true, phoneme: false, breakMaxMs: 3000 } }
          ).then(function (r) {
            var sent = r.record.requests[0].text;
            // break survives as markup the engine understands...
            contains(sent, '<break time="1s" />');
            // ...while sub, which it has no support for, is already applied.
            contains(sent, 'World Wide Web Consortium');
            notContains(sent, '<sub');
            eq(r.record.requests[0].ssml, null, 'sent as text, not a <speak> document');
          });
        });

        atest('the partial-SSML plan records what had to be emulated', function () {
          return driveCloud(
            '<p>Unit is <span data-ssml=\'{"say-as":{"interpret-as":"characters"}}\'>NaCl</span>.</p>',
            null,
            { ssmlSubset: { 'break': true, phoneme: false } }
          ).then(function (r) {
            eq(r.record.requests[0].text, 'Unit is N A C L.');
          });
        });

        atest('identical sentences are synthesized once and cached', function () {
          return driveCloud('<p>Repeat me. Repeat me.</p>').then(function (r) {
            eq(r.model.units.length, 2);
            eq(r.record.requests.length, 1, 'second sentence served from cache');
          });
        });
      });
    }

    // ---------------- responsive view switcher ------------------------
    // The switcher is what makes a narrow or short viewport usable, so its
    // selection and keyboard behaviour are worth pinning down. The layout
    // itself is CSS and is verified visually.
    if (typeof document !== 'undefined' && document.getElementById('view-switch')) {
      group('view switcher', function () {
        var sw = document.getElementById('view-switch');
        var tabs = Array.prototype.slice.call(sw.querySelectorAll('.view-tab'));
        var startingView = document.body.dataset.view;

        var press = function (key) {
          sw.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
        };
        var selected = function () {
          return tabs.filter(function (t) {
            return t.getAttribute('aria-selected') === 'true';
          });
        };

        test('there is one tab per panel and each names a real one', function () {
          eq(tabs.map(function (t) { return t.dataset.view; }),
            ['editor', 'reader', 'voice', 'inspector']);
          tabs.forEach(function (t) {
            truthy(document.getElementById(t.getAttribute('aria-controls')),
              t.dataset.view + ' panel exists');
          });
        });

        test('selecting a tab deselects the others', function () {
          tabs[2].click();
          eq(document.body.dataset.view, 'voice');
          eq(selected().length, 1);
          eq(selected()[0].dataset.view, 'voice');
        });

        test('only the selected tab is a tab stop', function () {
          tabs[0].click();
          eq(tabs.map(function (t) { return t.tabIndex; }), [0, -1, -1, -1]);
        });

        test('arrow keys move the selection and wrap around', function () {
          tabs[0].click();
          press('ArrowRight');
          eq(document.body.dataset.view, 'reader');
          press('ArrowLeft');
          eq(document.body.dataset.view, 'editor');
          press('ArrowLeft');
          eq(document.body.dataset.view, 'inspector', 'wraps to the end');
          press('ArrowRight');
          eq(document.body.dataset.view, 'editor', 'wraps to the start');
        });

        test('Home and End jump to the ends', function () {
          press('End');
          eq(document.body.dataset.view, 'inspector');
          press('Home');
          eq(document.body.dataset.view, 'editor');
        });

        test('an unrelated key is ignored', function () {
          tabs[1].click();
          press('a');
          eq(document.body.dataset.view, 'reader');
        });

        test('the switcher restores to where it started', function () {
          var restore = tabs.filter(function (t) { return t.dataset.view === startingView; })[0];
          if (restore) restore.click();
          eq(document.body.dataset.view, startingView);
        });
      });
    }

    // ---------------- tally -------------------------------------------
    return Promise.all(pending).then(function () {
      var passed = 0;
      var failed = 0;
      groups.forEach(function (g) {
        g.cases.forEach(function (c) { c.ok ? passed++ : failed++; });
      });
      return { groups: groups, passed: passed, failed: failed, total: passed + failed };
    });
  }

  root.SelfTest = { run: run };

  if (typeof module !== 'undefined' && module.exports) module.exports = { run: run };
})(typeof window !== 'undefined' ? window : globalThis);
