/*
 * provider-elevenlabs.js
 * ======================
 * ElevenLabs text to speech.
 *
 * ElevenLabs is the interesting case for a data-ssml tool: it is *not* an SSML
 * engine. It consumes two pronunciation tags inline in otherwise plain text —
 * `<break time="1.5s" />` and, on some models, `<phoneme alphabet="…" ph="…">` —
 * and has no `sub`, `say-as`, or `prosody` at all.
 *
 * So it is registered with an `ssmlSubset` rather than full SSML support. In
 * Send SSML mode the engine routes it through the emulation layer with those
 * two tags passed through as markup, and realizes everything else client-side
 * before sending. The Sentences tab shows exactly which directives survived as
 * markup and which had to be emulated.
 *
 * Timing comes back as character-level alignment rather than named marks, which
 * is finer-grained than the other services offer — words are derived from it
 * and mapped back through the same piece list that drives Web Speech boundary
 * highlighting.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */
(function (root) {
  'use strict';

  var P = root.TtsProviders;
  var HOST = 'https://api.elevenlabs.io';

  var DEFAULT_MODEL = 'eleven_multilingual_v2';
  var OUTPUT_FORMAT = 'mp3_44100_128';
  var OUTPUT_MIME = 'audio/mpeg';

  var config = {
    apiKey: '',
    modelId: DEFAULT_MODEL
  };

  /**
   * Models that apply `<phoneme>`.
   *
   * ElevenLabs' own pages disagree here: the best-practices page names only
   * eleven_flash_v2, while the help centre also lists eleven_turbo_v2 (now
   * deprecated). Both are English-only, and the default multilingual model does
   * not apply the tag at all. The conservative list is used, and anything
   * outside it falls back to emulation rather than silently losing the
   * pronunciation.
   */
  var PHONEME_MODELS = ['eleven_flash_v2', 'eleven_turbo_v2'];

  // Eleven v3 dropped break tags in favour of inline audio tags, so a pause has
  // to be produced client-side there.
  var NO_BREAK_MODELS = ['eleven_v3'];

  /** The tags this model consumes itself. Everything else is emulated. */
  function subsetFor(modelId) {
    return {
      'break': NO_BREAK_MODELS.indexOf(modelId) === -1,
      phoneme: PHONEME_MODELS.indexOf(modelId) !== -1,
      phonemeAlphabets: ['ipa', 'cmu-arpabet'],
      breakMaxMs: 3000
    };
  }

  function headers(extra) {
    return Object.assign({ 'xi-api-key': config.apiKey }, extra || {});
  }

  function ensureConfigured() {
    if (!config.apiKey) throw new P.ProviderError('No ElevenLabs API key configured.');
  }

  function request(path, options) {
    try {
      ensureConfigured();
    } catch (err) {
      return Promise.reject(err);
    }

    return fetch(HOST + path, options).catch(function (err) {
      throw P.describeFailure(err, 'ElevenLabs');
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw P.httpError('ElevenLabs', response, text);
        });
      }
      return response;
    });
  }

  // =====================================================================
  // Character alignment -> word timing
  // =====================================================================

  /** Indices of `sentText` that lie outside any inline tag. */
  function speakableIndices(sentText) {
    var indices = [];
    var inTag = false;

    for (var i = 0; i < sentText.length; i++) {
      var ch = sentText[i];
      if (ch === '<') { inTag = true; continue; }
      if (ch === '>') { inTag = false; continue; }
      if (!inTag) indices.push(i);
    }
    return indices;
  }

  /**
   * Map each alignment character onto its index in the string that was sent.
   *
   * The alignment may or may not include the inline tags, so rather than
   * assuming, both are walked together and each alignment character is matched
   * against the next candidate position outside a tag. Restricting candidates
   * that way stops a letter inside `<break time="1s" />` from swallowing a
   * match. Returns an array of indices, -1 where no match was found.
   */
  function alignToOutputOffsets(characters, sentText) {
    var candidates = speakableIndices(sentText);
    var offsets = new Array(characters.length);
    var next = 0;

    for (var i = 0; i < characters.length; i++) {
      var ch = characters[i];
      var found = -1;

      for (var j = next; j < candidates.length; j++) {
        if (sentText[candidates[j]] === ch) {
          found = candidates[j];
          next = j + 1;
          break;
        }
      }
      offsets[i] = found;
    }
    return offsets;
  }

  /**
   * Group the character alignment into word-level marks carrying offsets into
   * the sent string, which the engine resolves through the step's piece list.
   */
  function alignmentToMarks(alignment, sentText) {
    if (!alignment || !alignment.characters || !alignment.characters.length) return [];

    var characters = alignment.characters;
    var starts = alignment.character_start_times_seconds || [];
    var offsets = alignToOutputOffsets(characters, sentText);

    var marks = [];
    var wordStart = -1;
    var wordStartTime = 0;
    var wordEnd = -1;

    var flush = function () {
      if (wordStart === -1) return;
      marks.push({
        timeMs: Math.round(wordStartTime * 1000),
        outStart: wordStart,
        outLen: (wordEnd - wordStart) + 1
      });
      wordStart = -1;
    };

    for (var i = 0; i < characters.length; i++) {
      var isSpace = /\s/.test(characters[i]);
      var offset = offsets[i];

      if (isSpace || offset === -1) {
        flush();
        continue;
      }
      if (wordStart === -1) {
        wordStart = offset;
        wordStartTime = starts[i] || 0;
      }
      wordEnd = offset;
    }
    flush();

    return marks;
  }

  // =====================================================================
  // Provider
  // =====================================================================

  P.register({
    id: 'elevenlabs',
    name: 'ElevenLabs',
    kind: 'audio',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/text-to-speech',
    supports: {
      ssml: true,
      ssmlSubset: subsetFor(DEFAULT_MODEL),
      wordMarks: true,
      markAlignment: true,
      pitch: false
    },
    note: 'Not a full SSML engine: it consumes <break> inline, and <phoneme> on ' +
      'a couple of English-only models. sub, say-as, and prosody have no ' +
      'equivalent and are emulated before sending. Word timing comes from ' +
      'character-level alignment, so it works in every delivery mode. For ' +
      'pronunciation that has to stick across a whole item bank, ElevenLabs\u2019 ' +
      'own pronunciation dictionaries are the durable mechanism.',
    securityNote:
      'An ElevenLabs key in a web page is readable by anyone who can open it, ' +
      'and the account is billed per character. There is no short-lived token ' +
      'covering the REST endpoint, so a scoped key with a hard credit quota, ' +
      'rotated regularly, is the only real mitigation.',

    credentialFields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        placeholder: 'sk_…',
        required: true,
        hint: 'elevenlabs.io → your profile → API Keys.'
      },
      {
        key: 'modelId',
        label: 'Model',
        type: 'text',
        placeholder: DEFAULT_MODEL,
        required: false,
        hint: 'eleven_multilingual_v2 is the default and the most lifelike, but ' +
          'applies no <phoneme> tags. Only ' + PHONEME_MODELS.join(' and ') +
          ' do, and both are English-only. eleven_v3 supports neither <break> ' +
          'nor <phoneme> tags, so both are emulated there.'
      }
    ],

    configure: function (creds) {
      config.apiKey = ((creds && creds.apiKey) || '').trim();
      config.modelId = ((creds && creds.modelId) || '').trim() || DEFAULT_MODEL;
      // Phoneme passthrough depends on the chosen model.
      this.supports.ssmlSubset = subsetFor(config.modelId);
    },
    isConfigured: function () {
      return !!config.apiKey;
    },
    describeConfig: function () {
      return config.apiKey ? 'API key set, model ' + config.modelId : 'no API key';
    },

    listVoices: function () {
      // /v2/voices is the current endpoint and is paginated; /v1/voices is
      // documented as legacy.
      var collected = [];

      var fetchPage = function (pageToken) {
        var path = '/v2/voices?page_size=100' +
          (pageToken ? '&next_page_token=' + encodeURIComponent(pageToken) : '');

        return request(path, { headers: headers() })
          .then(function (response) { return response.json(); })
          .then(function (data) {
            collected = collected.concat(data.voices || []);
            // Cap the walk so a large workspace cannot spin here.
            if (data.has_more && data.next_page_token && collected.length < 500) {
              return fetchPage(data.next_page_token);
            }
            return collected;
          });
      };

      return fetchPage(null).then(function (voices) {
        return voices.map(function (voice) {
          var labels = voice.labels || {};
          var verified = (voice.verified_languages || [])[0] || {};
          return {
            id: voice.voice_id,
            name: voice.name,
            // These voices are largely language-agnostic; verified_languages is
            // the closest thing to a locale, and labels only carry hints.
            lang: verified.locale || verified.language || 'en',
            detail: [voice.category, labels.accent, labels.gender]
              .filter(Boolean).join(', '),
            raw: voice
          };
        });
      });
    },

    synthesize: function (req) {
      var voiceId = (req.voice && req.voice.id) || null;
      if (!voiceId) {
        return Promise.reject(new P.ProviderError('No ElevenLabs voice selected.'));
      }

      // ElevenLabs takes plain text with inline tags, never a <speak> document.
      // The engine has already produced that string via the emulation layer.
      var sentText = req.text || req.ssml || '';

      var body = {
        text: sentText,
        model_id: config.modelId
      };

      var path = '/v1/text-to-speech/' + encodeURIComponent(voiceId) +
        (req.wantMarks ? '/with-timestamps' : '') +
        '?output_format=' + OUTPUT_FORMAT;

      return request(path, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      }).then(function (response) {
        if (!req.wantMarks) {
          // The convert endpoint answers with application/octet-stream, which
          // an <audio> element will not decode — re-type it to the format that
          // was actually requested.
          return response.arrayBuffer().then(function (buffer) {
            return {
              blob: new Blob([buffer], { type: OUTPUT_MIME }),
              marks: []
            };
          });
        }

        return response.json().then(function (data) {
          if (!data.audio_base64) {
            throw new P.ProviderError('ElevenLabs returned no audio.');
          }
          // `alignment` tracks the submitted characters; `normalized_alignment`
          // tracks the text after the engine's own normalization. The former is
          // what maps back to the source.
          var alignment = data.alignment || data.normalized_alignment;
          return {
            blob: P.base64ToBlob(data.audio_base64, OUTPUT_MIME),
            marks: alignmentToMarks(alignment, sentText)
          };
        });
      });
    },

    _alignmentToMarks: alignmentToMarks,
    _alignToOutputOffsets: alignToOutputOffsets,
    _subsetFor: subsetFor,
    _phonemeModels: PHONEME_MODELS
  });
})(window);
