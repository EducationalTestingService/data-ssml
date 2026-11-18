# data-ssml Read Aloud Tool

**Version 1.0** · mhakkinen@ets.org

A working TTS read-aloud tool that understands and consumes SSML encoded with the
1EdTech [`data-ssml`](https://www.1edtech.org/standards/data-ssml) property
(v1.0, July 2024).

Edit HTML in a text box, see it rendered next to it, and have it read aloud with
sentence and word highlighting. Where a voice accepts SSML — Amazon Polly, Azure
AI Speech, and Google Cloud TTS all do, with an API key — the SSML document is
sent and the engine applies the directives. Where it accepts only part of SSML
(ElevenLabs) the supported tags are passed through and the rest emulated. Where
it accepts none, which is every browser TTS engine today, every directive is
realized client-side so the content is still spoken correctly.

## Running it

Open `index.html` in a browser. No build step, no server, no dependencies.

```
open index.html
```

Everything is plain scripts on a global namespace rather than ES modules, so it
works from `file://` as well as over HTTP.

Optional query parameters:

| Parameter | Effect |
|-----------|--------|
| `?sample=<name>` | Load a named sample instead of the stored draft (`assessment`, `spec`, `extended`, `math`, `nesting`, `errors`, `blank`) |
| `?provider=<id>` | Select a speech service on load, opening its credentials dialog (`webspeech`, `google`, `polly`, `azure`, `elevenlabs`) |
| `?selftest` | Run the self-test suite on load |

## Layout

The tool adapts to both dimensions, because a short viewport squeezes a two-row
grid just as badly as a narrow one does:

| Viewport | Layout |
|----------|--------|
| Wide and tall (≥1180 × ≥720) | Three columns, two rows, filling the window |
| Wide but short (≥1280 × 560–719) | Four columns in a single row |
| Medium (768–1179 wide, ≥560 tall) | Two columns; reader on top, the page scrolls |
| Narrow (<768) or short (<560) | One panel at a time behind a Source / Read / Voice / Inspect switcher |

In the single-panel mode the hidden panels stay in the DOM, so playback, the
segmenter model, and highlighting keep running while you are looking at
something else — you can start the reader, switch to Source, and the sentence
highlight is still tracking when you come back. The switcher is a proper
tablist: arrow keys, Home, and End move between panels, and the tab semantics
are only applied while it is actually on screen.

On touch devices controls grow to comfortable tap targets, form fields render at
16px so iOS does not zoom on focus, keyboard-shortcut hints are suppressed, and
dialogs go full-screen. On very short viewports the hint bars are dropped so the
reading area keeps the space.

## Using it

1. **HTML source** — edit freely; the preview re-renders as you type.
   Write the attribute JSON in single quotes so its double quotes stay valid:
   `<span data-ssml='{"sub":{"alias":"sodium chloride"}}'>NaCl</span>`
2. **Rendered content** — Play / Pause / Stop, plus Prev / Next by
   sentence. Click any sentence to start reading from there. With the reader
   focused: <kbd>Space</kbd> play/pause, <kbd>Esc</kbd> stop,
   <kbd>←</kbd>/<kbd>→</kbd> previous/next sentence.
3. **Voice & delivery** — pick a voice, choose how SSML is delivered,
   set rate / pitch / volume, and toggle highlighting.
4. **Inspector** — three tabs:
   - *Attributes* — every `data-ssml` element, its normalized parse, its SSML,
     and any error or spec advisory. Click one to highlight it in the preview.
   - *Sentences* — the reading plan: what is shown, what will actually be
     spoken, and why. Click one to read from there.
   - *Log* — every string handed to the synthesizer, with timings.

## Supported directives

All five directives identified as essential for educational assessment, in both
JSON shapes the specification allows.

| Directive | Spec format | Extended format (array, substring-targeted) |
|-----------|-------------|---------------------------------------------|
| `sub` | `{"sub":{"alias":"…"}}` | `{"sub":[{"text":"W3C","alias":"…"}]}` |
| `break` | `{"break":{"time":"500ms"}}` | `{"break":[{"time":"300","after":"Hello"}]}` |
| `prosody` | `{"prosody":{"rate":"fast"}}` | — |
| `say-as` | `{"say-as":{"interpret-as":"characters"}}` | `{"say-as":[{"text":"42","interpret-as":"cardinal"}]}` |
| `phoneme` | `{"phoneme":{"ph":"pɪˈkɑːn","alphabet":"ipa"}}` | — |

`prosody.rate`: `x-slow` (0.5×), `slow` (0.75×), `medium`/`default` (1.0×),
`fast` (1.5×), `x-fast` (2.0×), or a percentage (`"90%"`).
`break.time`: `"500ms"`, `"3s"`, or a bare integer meaning milliseconds.
`break.strength`: `none` 0 · `x-weak` 100 · `weak` 200 · `medium` 400 ·
`strong` 600 · `x-strong` 1000 ms.

## Speech services

| Service | Credentials | SSML | Word timing |
|---------|-------------|------|-------------|
| Browser (Web Speech API) | none | no input path | `boundary` events |
| Google Cloud TTS | API key | native | `SSML_MARK` timepoints |
| Amazon Polly | access key + secret (SigV4) | native | speech marks |
| Azure AI Speech | resource key + region | native | none over REST |
| ElevenLabs | API key | partial — `break`, `phoneme` (model-dependent) | character alignment |

Pick a service in the Voice panel; cloud ones prompt for credentials. The point
of wiring them up is comparison: **Send SSML** on a cloud voice is the reference
rendering of your markup, and switching the same voice to **Emulate** tells you
how close the browser-side approximation gets.

Credentials live in `sessionStorage` and vanish when the tab closes, unless you
tick "Remember on this device". They are sent only to the provider's own
endpoint — nothing is proxied. A key in a web page is readable by anyone who can
open the page, so restrict it: limit a Google key to the Text-to-Speech API, and
use an IAM user scoped to `polly:SynthesizeSpeech` / `polly:DescribeVoices` (or
short-lived STS credentials with a session token) for AWS. ElevenLabs has no
short-lived token covering its REST endpoint, so a scoped key with a hard credit
quota is the only mitigation there.

Each sentence is synthesized once and cached for the session, and the next
sentence is prefetched while the current one plays. Changing voice, mode, or
text re-synthesizes — cloud TTS is billed per character.

Service-specific behaviour worth knowing:

- **Google** is the simplest: audio and timepoints come back in one response.
  Word marks require the `v1beta1` endpoint, which is what the tool uses for
  synthesis.
- **Polly** needs SigV4 request signing, implemented in `js/aws-sigv4.js` with
  WebCrypto and checked against AWS's published `get-vanilla` test vector. Word
  marks cost a second request per sentence. Its **neural** voices ignore
  `prosody pitch` and do not support `say-as interpret-as="characters"` — Polly
  silently falls back to a standard voice for that sentence while still billing
  at the neural rate, so the tool logs a warning when it sends markup that will
  hit this.
- **Azure** requires the SSML to name the voice in a `<voice>` element and to
  carry `xml:lang` on `<speak>`; the tool retags the composed document per
  request. Word boundaries are Speech SDK websocket events, so the REST endpoint
  used here gives sentence-level highlighting only.
- **ElevenLabs** is not an SSML engine and is handled differently — see below.

### Partial SSML: ElevenLabs

ElevenLabs takes plain text with two inline pronunciation tags rather than an
SSML document. It honours `<break>`, and `<phoneme>` on the models that apply it;
it has no `sub`, `say-as`, or `prosody` at all.

Rather than pretend it is a full SSML engine or give up and emulate everything,
the tool declares an **SSML subset** for it. In Send SSML mode the sentence goes
through the emulation layer with those tags passed straight through as markup,
while the directives ElevenLabs cannot express are realized client-side first.
So

```html
The <span data-ssml='{"sub":{"alias":"World Wide Web Consortium"}}'>W3C</span>
said <span data-ssml='{"break":{"time":"1s"}}'>wait</span> here.
```

is sent as

```
The World Wide Web Consortium said wait<break time="1s" /> here.
```

The Sentences tab lists which directives survived as markup and which had to be
emulated, per sentence. Which tags survive is model-dependent, so the subset is recomputed when you
change the model in the credentials dialog:

| Model | `break` | `phoneme` |
|-------|---------|-----------|
| `eleven_multilingual_v2` (default) | yes | no |
| `eleven_flash_v2` (English only) | yes | yes |
| `eleven_turbo_v2` (English only, deprecated) | yes | yes |
| `eleven_v3` | no | no |

Anything not passed through falls back to emulation, so no directive is lost —
it is just realized in a different place, and the Sentences tab says which.
Note the awkward corner: there is no model that takes both `<phoneme>` and
multilingual text, and `eleven_v3` takes neither tag.

ElevenLabs' own **pronunciation dictionaries** (PLS lexicons, or alias rules
that work on every model) are the durable mechanism for pronunciation that has
to hold across a whole item bank. This tool does not manage them — it is a
per-document authoring surface — but that is where `data-ssml` content would map
for production use on this service.

Word timing is character-level alignment rather than named marks, which is finer
than any of the other services offer. The docs do not say whether the reported
characters include the inline tags, so the tool does not assume: it matches the
reported characters against the sent string while skipping tag regions, then
groups them into words. That is correct either way, and it also absorbs the
service's own text normalization. The mapping works in every delivery mode, so
ElevenLabs is the one service that highlights words in Emulate mode too.

All three send permissive CORS headers, including for the `null` origin a
`file://` page presents, so the tool works opened directly from disk. Two
caveats: Google API-key *referrer* restrictions cannot match a `file://` page
(no `Referer` is sent), and Polly's signing needs WebCrypto, which requires a
secure context. If either bites, serve the folder over HTTP:

```
python3 -m http.server 8000
```

## Delivery modes

The Web Speech API has **no SSML input path in any shipping browser**.
`SpeechSynthesisUtterance` takes a plain string; markup handed to it is either
stripped or read aloud as literal tag text. There is also no capability flag to
query. The tool therefore offers three modes, which apply to every service:

- **Emulate** (default for the browser voice) — each directive is realized using
  primitives the Web Speech API does expose, and plain text is sent. This is what
  makes `data-ssml` audible in a browser today, and on a cloud voice it is the
  A/B comparison against native SSML.
- **Send SSML** (default for cloud services) — the SSML 1.1 document is handed
  over verbatim. Correct on engines that accept SSML, and a useful conformance
  probe on those that do not.
- **Plain text** — applies only `sub`, matching the reference library's
  `apply_text_only()` fallback for AT without SSML support.

How each directive is emulated:

| Directive | Emulation |
|-----------|-----------|
| `sub` | textual substitution before synthesis |
| `say-as` | textual expansion — cardinals, ordinals, dates, times, telephone numbers, character spelling |
| `break` | the utterance is split and a timed silence inserted between the parts |
| `prosody` | `SpeechSynthesisUtterance.rate` multiplier on the affected part |
| `phoneme` | no Web Speech equivalent; optional lossy IPA→English respelling |

For the browser voice there is no way to detect SSML support, so the **SSML
probe** speaks one sentence containing
`<sub alias="supported">not supported</sub>` and asks what you heard. The verdict
is stored per voice and shown in the voice list. Cloud services need no probe —
their SSML support is documented.

## Directive scoping

A directive applies to the text of **its own element**, never to the sentence
that contains it. In

```html
<p>A student dissolves <span data-ssml='{"sub":{"alias":"sodium chloride"}}'>NaCl</span> in water.</p>
```

the sentence is spoken as *"A student dissolves sodium chloride in water."* —
not as *"sodium chloride"*. Sibling directives in one sentence each apply to
their own span, and nesting composes: an outer `prosody` wraps an inner
`say-as`, with inner values winning for keys both define.

One exception governs sentence splitting: when a directive reinterprets an
element's whole content (spec-format `sub`, spec-format `say-as`, or `phoneme`)
and that element spans more than one sentence, the sentences are held together
in a single reading unit, because splitting them would change what is spoken.

## Highlighting

Highlighting never mutates the rendered DOM — the preview stays exactly the tree
you authored. Two strategies, chosen automatically:

1. **CSS Custom Highlight API** (`CSS.highlights`) where supported.
2. **Positioned overlay rectangles** from `Range.getClientRects()` elsewhere.

The active strategy is shown in the badge above the preview.

Word highlighting has two sources:

- **Browser voice** — `boundary` events, which Chrome and Edge fire for local
  voices; Safari and network voices frequently do not.
- **Cloud voice** — timing marks. The composer inserts a `<mark>` before each
  word and once before each element whose directives reinterpret its content
  (SSML 1.1 allows only text inside `sub`, `say-as`, and `phoneme`, so nothing is
  placed there). Google returns a timepoint per mark, Polly a speech mark; the
  tool maps each back to the source range it came from. This needs **Send SSML**
  mode and a service that reports timings.

Either way, where a directive rewrote what is spoken the word highlight covers
the whole rewritten span — the character correspondence needed to track inside it
does not exist. Text outside any directive keeps exact per-character mapping.

## Tests

189 assertions. The parser and SSML-serializer groups are ports of the pytest
suites in [`data-ssmlToJson`](https://github.com/mhakkinen/data-ssmlToJson), so
the JavaScript is checked against the same expectations as the reference Python
library. The rest cover the emulation layer, directive scoping, the segmenter,
mark placement, the provider adapters, SigV4 signing (against AWS's published
`get-vanilla` vector), and both playback backends driven by stubs — no audio,
network, or credentials required.

- **In the page** — "Run self-test", or load `index.html?selftest`.
  This is the complete suite, including the DOM-dependent groups.
- **Headless with Node** — `node run-tests.js`
- **Headless with macOS JavaScriptCore** — for machines without Node:
  ```
  /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc run-tests-jsc.js
  ```

The two headless runners skip the groups that need a DOM, WebCrypto, or `Blob`
— the segmenter, both playback backends, SigV4, and the view switcher (147 of
the 189 assertions run there).

## Files

```
index.html               UI
css/app.css              styles, including the highlight palettes
js/data-ssml-parser.js   port of data_ssml_parser.py — parse and normalize
js/data-ssml-to-ssml.js  port of data_ssml_to_ssml.py, plus sentence-level composition
js/ssml-emulate.js       client-side realization of SSML semantics
js/segmenter.js          DOM → flat text → sentence units, offsets → DOM Ranges
js/highlighter.js        non-destructive sentence and word highlighting
js/tts-engine.js         playback queue, transport, both speech backends
js/audio-player.js       clip playback with mark-driven highlighting
js/tts-providers.js      provider registry, shared helpers, Web Speech backend
js/provider-google.js    Google Cloud TTS
js/provider-polly.js     Amazon Polly
js/provider-azure.js     Azure AI Speech
js/provider-elevenlabs.js  ElevenLabs (partial SSML + character alignment)
js/aws-sigv4.js          AWS SigV4 request signing (WebCrypto)
js/samples.js            authoring samples
js/app.js                UI wiring
js/tests.js              self-test suite
run-tests.js             headless runner (Node)
run-tests-jsc.js         headless runner (JavaScriptCore)
```

`data-ssml-parser.js` and `data-ssml-to-ssml.js` reproduce the reference Python
library's behaviour, including its error messages, so results can be compared
directly against the NVDA add-on and any other consumer built on it.

## Known limits

- `phoneme` cannot be delivered faithfully without an SSML-capable engine. The
  optional IPA respelling is an approximation, off by default.
- `to_ssml()` snaps every `prosody.rate` to one of five keywords, matching the
  reference library — `"90%"` serializes as `rate="medium"`. The sentence
  composer used for playback preserves the exact percentage instead, and the
  emulation path uses the exact multiplier.
- Pause/resume behaviour varies by platform. The engine re-issues the current
  utterance if a browser voice drops it on resume.
- Azure gives no word timings over REST, so it highlights by sentence only.
- ElevenLabs receives plain text with inline tags, so a literal `<` in your
  content is passed through untouched; it is not escaped, because the input is
  not XML.
- The global pitch slider applies to the browser voice and Google. Polly's
  neural engine ignores `prosody pitch`, Azure's REST path would need SSML
  surgery, and ElevenLabs has no pitch control, so the slider is disabled for
  those three.
- Substring-targeted `sub` and `say-as` are applied to text runs. On an element
  that also contains nested `data-ssml` children, only whole-element directives
  are composed into the SSML output.
- Rendering strips `<script>`, `<iframe>`, inline event handlers, and
  `javascript:` URLs. This is an authoring surface for pronunciation markup, not
  a page sandbox.

## Credits

data-ssml Read Aloud Tool, version 1.0 — mhakkinen@ets.org

The parser and SSML serializer are ports of
[data-ssmlToJson](https://github.com/mhakkinen/data-ssmlToJson) and are checked
against that library's test suite, so results can be compared directly against
the NVDA add-on and any other consumer built on it.

## References

- [1EdTech — Support for SSML Using the data-ssml Property](https://www.1edtech.org/standards/data-ssml)
- [SSML for Educational Assessments — overview](https://github.com/mhakkinen/SSML-issues/blob/master/overview.md)
- [data-ssmlToJson — reference Python library](https://github.com/mhakkinen/data-ssmlToJson)
- [W3C SSML 1.1](https://www.w3.org/TR/speech-synthesis11/)
- [W3C Spoken Presentation Task Force](https://www.w3.org/WAI/about/groups/task-forces/spoken-presentation/)
- [WCAG 2.2 SC 3.1.6 Pronunciation](https://www.w3.org/WAI/WCAG22/Understanding/pronunciation)
