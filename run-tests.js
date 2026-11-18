/*
 * run-tests.js
 * ============
 * Headless runner for the self-test suite.
 *
 *   node run-tests.js
 *
 * The browser-only groups (the segmenter, which needs a DOM) are skipped here;
 * run them with the "Run self-test" button in the page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = [
  'js/data-ssml-parser.js',
  'js/data-ssml-to-ssml.js',
  'js/ssml-emulate.js',
  'js/tts-providers.js',
  'js/provider-google.js',
  'js/provider-azure.js',
  'js/provider-polly.js',
  'js/provider-elevenlabs.js',
  'js/tests.js'
];

const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.Intl = Intl;
sandbox.Promise = Promise;
sandbox.fetch = () => Promise.reject(new Error('network disabled in headless tests'));
sandbox.location = { protocol: 'file:', search: '' };
sandbox.Date = Date;
sandbox.Math = Math;
sandbox.JSON = JSON;

const context = vm.createContext(sandbox);

for (const file of FILES) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

sandbox.SelfTest.run().then((results) => {
  for (const group of results.groups) {
    console.log('\n\x1b[1m' + group.name + '\x1b[0m');
    for (const c of group.cases) {
      if (c.ok) {
        console.log('  \x1b[32m✓\x1b[0m ' + c.name);
      } else {
        console.log('  \x1b[31m✗ ' + c.name + '\x1b[0m');
        console.log('      ' + c.detail);
      }
    }
  }

  const colour = results.failed ? '\x1b[31m' : '\x1b[32m';
  console.log('\n' + colour + results.passed + ' passed, ' + results.failed +
    ' failed, ' + results.total + ' total\x1b[0m');

  process.exit(results.failed ? 1 : 0);
});
