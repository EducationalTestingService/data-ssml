/*
 * run-tests-jsc.js
 * ================
 * Headless runner for macOS JavaScriptCore, for machines without Node.
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     run-tests-jsc.js
 *
 * Prefer `node run-tests.js` when Node is installed. Browser-only groups (the
 * segmenter, which needs a DOM) are skipped in both headless runners.
 */
'use strict';

var window = this;
globalThis.window = globalThis;

globalThis.location = { protocol: 'file:', search: '' };
globalThis.fetch = function () {
  return Promise.reject(new Error('network disabled in headless tests'));
};

load('js/data-ssml-parser.js');
load('js/data-ssml-to-ssml.js');
load('js/ssml-emulate.js');
load('js/tts-providers.js');
load('js/provider-google.js');
load('js/provider-azure.js');
load('js/provider-polly.js');
load('js/provider-elevenlabs.js');
load('js/tests.js');

var failures = 0;

SelfTest.run().then(function (results) {
  results.groups.forEach(function (group) {
    print('\n' + group.name);
    group.cases.forEach(function (c) {
      if (c.ok) print('  PASS  ' + c.name);
      else print('  FAIL  ' + c.name + '\n          ' + c.detail);
    });
  });

  print('\n' + results.passed + ' passed, ' + results.failed + ' failed, ' +
    results.total + ' total');
  failures = results.failed;
});

// jsc drains the microtask queue before exiting, so the report above has run
// by the time this is evaluated.
drainMicrotasks();
if (failures) throw new Error(failures + ' test(s) failed');
