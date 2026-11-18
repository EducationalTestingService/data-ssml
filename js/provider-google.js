/*
 * provider-google.js
 * ==================
 * Google Cloud Text-to-Speech.
 *
 * Uses the v1beta1 endpoint because that is where `enableTimePointing` lives:
 * with `SSML_MARK` enabled the response carries a timepoint for every
 * `<mark name="…"/>` in the submitted SSML, which is how this tool gets real
 * word timings out of a real SSML engine.
 *
 * Authentication is a plain API key on the query string. Restrict the key to
 * the Text-to-Speech API — anything with the page open can read it.
 *
 * Docs: https://cloud.google.com/text-to-speech/docs/reference/rest
 */
(function (root) {
  'use strict';

  var P = root.TtsProviders;
  // Timepoints (enableTimePointing) exist only in v1beta1; the stable v1 is
  // used for everything else.
  var BASE_BETA = 'https://texttospeech.googleapis.com/v1beta1';
  var BASE_V1 = 'https://texttospeech.googleapis.com/v1';

  var config = { apiKey: '' };

  /** UI pitch multiplier (0.5–2) to Google's semitone scale (-20–20). */
  function pitchToSemitones(multiplier) {
    if (!multiplier || multiplier === 1) return 0;
    var semitones = 12 * Math.log2(multiplier);
    return Math.max(-20, Math.min(20, Math.round(semitones * 10) / 10));
  }

  function request(base, path, body) {
    if (!config.apiKey) {
      return Promise.reject(new P.ProviderError('No Google Cloud API key configured.'));
    }

    var url = base + path + (path.indexOf('?') === -1 ? '?' : '&') +
      'key=' + encodeURIComponent(config.apiKey);

    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).catch(function (err) {
      throw P.describeFailure(err, 'Google Cloud TTS');
    }).then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) throw P.httpError('Google Cloud TTS', response, text);
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new P.ProviderError('Google Cloud TTS returned a malformed response.');
        }
      });
    });
  }

  P.register({
    id: 'google',
    name: 'Google Cloud Text-to-Speech',
    kind: 'audio',
    docsUrl: 'https://cloud.google.com/text-to-speech/docs/reference/rest',
    supports: { ssml: true, wordMarks: true, pitch: true },
    fileUrlCaveat: 'One exception: an API key restricted by HTTP referrer will ' +
      'reject a file:// page, because no Referer header is sent.',
    note: 'Native SSML. Audio and SSML_MARK timepoints come back in one ' +
      'response, so word highlighting follows the engine rather than an estimate.',

    credentialFields: [
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        placeholder: 'AIza…',
        required: true,
        hint: 'Cloud console → APIs & Services → Credentials. Restrict it to the ' +
          'Cloud Text-to-Speech API.'
      }
    ],

    configure: function (creds) {
      config.apiKey = (creds && creds.apiKey) || '';
    },
    isConfigured: function () {
      return !!config.apiKey;
    },
    describeConfig: function () {
      return config.apiKey ? 'API key set' : 'no API key';
    },

    listVoices: function () {
      return request(BASE_V1, '/voices', null).then(function (data) {
        return (data.voices || []).map(function (voice) {
          var lang = (voice.languageCodes && voice.languageCodes[0]) || 'en-US';
          var family = /Neural2|Studio|Journey|Wavenet|Polyglot|Chirp/i.exec(voice.name);
          return {
            id: voice.name,
            name: voice.name,
            lang: lang,
            detail: [
              family ? family[0] : 'Standard',
              (voice.ssmlGender || '').toLowerCase()
            ].filter(Boolean).join(', '),
            raw: voice
          };
        });
      });
    },

    synthesize: function (req) {
      var voiceName = (req.voice && req.voice.id) || null;
      var languageCode = (req.voice && req.voice.lang) || req.lang || 'en-US';

      // Google's <speak> root takes no attributes; send it bare.
      var ssml = req.ssml ? P.retagSpeak(req.ssml, '') : null;

      var body = {
        input: ssml ? { ssml: ssml } : { text: req.text },
        voice: { languageCode: languageCode },
        audioConfig: {
          audioEncoding: 'MP3',
          pitch: pitchToSemitones(req.pitch)
        }
      };
      if (voiceName) body.voice.name = voiceName;

      // enableTimePointing is a top-level field, and only meaningful for SSML
      // input carrying <mark> elements.
      if (req.wantMarks && ssml) body.enableTimePointing = ['SSML_MARK'];

      return request(BASE_BETA, '/text:synthesize', body).then(function (data) {
        if (!data.audioContent) {
          throw new P.ProviderError('Google Cloud TTS returned no audio.');
        }
        return {
          blob: P.base64ToBlob(data.audioContent, 'audio/mpeg'),
          marks: (data.timepoints || []).map(function (point) {
            return {
              name: point.markName,
              timeMs: Math.round((point.timeSeconds || 0) * 1000)
            };
          })
        };
      });
    }
  });
})(window);
