/*
 * provider-polly.js
 * =================
 * Amazon Polly.
 *
 * Polly has no API-key authentication: requests are signed with SigV4 (see
 * aws-sigv4.js). Word highlighting uses Polly's speech marks — a second call
 * with OutputFormat "json" and SpeechMarkTypes ["ssml"], which reports the time
 * at which the engine reaches each `<mark name="…"/>`.
 *
 * Polly wants a bare `<speak>` root, so the composed document's attributes are
 * stripped before sending.
 *
 * Docs: https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html
 */
(function (root) {
  'use strict';

  var P = root.TtsProviders;

  var config = {
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    region: 'us-east-1'
  };

  function host() {
    return 'https://polly.' + encodeURIComponent(config.region) + '.amazonaws.com';
  }

  function ensureConfigured() {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new P.ProviderError('No AWS credentials configured for Polly.');
    }
  }

  /** Sign and send a Polly request. Resolves with the raw Response. */
  function signedFetch(method, path, bodyObject) {
    ensureConfigured();

    var url = host() + path;
    var body = bodyObject ? JSON.stringify(bodyObject) : '';
    var headers = bodyObject ? { 'Content-Type': 'application/json' } : {};

    return root.AwsSigV4.sign({
      method: method,
      url: url,
      body: body,
      headers: headers,
      service: 'polly',
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken || null
    }).then(function (signedHeaders) {
      return fetch(url, {
        method: method,
        headers: signedHeaders,
        body: bodyObject ? body : undefined
      });
    }).catch(function (err) {
      throw P.describeFailure(err, 'Amazon Polly');
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw P.httpError('Amazon Polly', response, text);
        });
      }
      return response;
    });
  }

  /**
   * Polly speech marks arrive as newline-delimited JSON, one object per line:
   *   {"time":253,"type":"ssml","start":12,"end":31,"value":"m4"}
   */
  function parseSpeechMarks(text) {
    return text.split('\n').map(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return null;
      try {
        var mark = JSON.parse(trimmed);
        if (mark.type !== 'ssml') return null;
        return { name: mark.value, timeMs: mark.time };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * SSML that the neural engine handles differently from standard.
   *
   * `say-as interpret-as="characters"` is the sharp one: neural does not
   * support it, and rather than failing, Polly silently falls back to the
   * standard voice for that sentence while still billing at the neural rate.
   * Spelling out abbreviations is core to assessment content, so this is worth
   * surfacing rather than letting it pass unnoticed.
   */
  function neuralCaveats(ssml) {
    var warnings = [];
    if (/interpret-as="(characters|spell-out)"/.test(ssml)) {
      warnings.push('Polly\u2019s neural engine does not support ' +
        'say-as interpret-as="characters". Polly silently falls back to the ' +
        'standard voice for this sentence, still billed as neural. Pick a ' +
        'standard-only voice to hear it consistently.');
    }
    return warnings;
  }

  /** Neural voices reject some SSML; pick the best engine a voice supports. */
  function engineFor(voice) {
    var supported = (voice && voice.raw && voice.raw.SupportedEngines) || [];
    if (supported.indexOf('neural') !== -1) return 'neural';
    if (supported.indexOf('standard') !== -1) return 'standard';
    return 'standard';
  }

  P.register({
    id: 'polly',
    name: 'Amazon Polly',
    kind: 'audio',
    docsUrl: 'https://docs.aws.amazon.com/polly/latest/dg/API_SynthesizeSpeech.html',
    supports: { ssml: true, wordMarks: true, pitch: false },
    note: 'Native SSML. Word timings come from speech marks on the <mark> ' +
      'elements, which costs a second request per sentence. Polly has no API ' +
      'key — requests are signed with SigV4, so an access key and secret are ' +
      'needed. Neural voices ignore prosody pitch and do not support ' +
      'say-as interpret-as="characters".',
    fileUrlCaveat: 'One exception: SigV4 signing needs WebCrypto, which is only ' +
      'available in a secure context.',
    securityNote:
      'A long-lived AWS secret access key in a web page is readable by anyone ' +
      'who can open the page. Use an IAM user restricted to polly:SynthesizeSpeech ' +
      'and polly:DescribeVoices, or paste short-lived STS credentials with a ' +
      'session token.',

    credentialFields: [
      {
        key: 'accessKeyId',
        label: 'Access key ID',
        type: 'text',
        placeholder: 'AKIA…',
        required: true
      },
      {
        key: 'secretAccessKey',
        label: 'Secret access key',
        type: 'password',
        placeholder: '40-character secret',
        required: true
      },
      {
        key: 'sessionToken',
        label: 'Session token',
        type: 'password',
        placeholder: 'optional — for temporary STS credentials',
        required: false,
        hint: 'Only needed when using temporary credentials.'
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        placeholder: 'us-east-1',
        required: true
      }
    ],

    configure: function (creds) {
      config.accessKeyId = ((creds && creds.accessKeyId) || '').trim();
      config.secretAccessKey = ((creds && creds.secretAccessKey) || '').trim();
      config.sessionToken = ((creds && creds.sessionToken) || '').trim();
      config.region = ((creds && creds.region) || 'us-east-1').trim().toLowerCase();
    },
    isConfigured: function () {
      return !!(config.accessKeyId && config.secretAccessKey && config.region);
    },
    describeConfig: function () {
      return config.accessKeyId
        ? 'key ' + config.accessKeyId.slice(0, 4) + '…, region ' + config.region
        : 'no credentials';
    },

    listVoices: function () {
      return signedFetch('GET', '/v1/voices', null)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          return (data.Voices || []).map(function (voice) {
            var engines = voice.SupportedEngines || [];
            return {
              id: voice.Id,
              name: voice.Name,
              lang: voice.LanguageCode,
              detail: [
                engines.indexOf('neural') !== -1 ? 'neural' : 'standard',
                (voice.Gender || '').toLowerCase()
              ].filter(Boolean).join(', '),
              raw: voice
            };
          });
        });
    },

    synthesize: function (req) {
      var voice = req.voice;
      var voiceId = (voice && voice.id) || 'Joanna';
      var engine = engineFor(voice);

      // Polly's <speak> root takes no attributes.
      var ssml = req.ssml ? P.retagSpeak(req.ssml, '') : null;
      var warnings = (ssml && engine === 'neural') ? neuralCaveats(ssml) : [];

      var base = {
        VoiceId: voiceId,
        Engine: engine,
        Text: ssml || req.text,
        TextType: ssml ? 'ssml' : 'text'
      };

      var audioRequest = Object.assign({}, base, {
        OutputFormat: 'mp3',
        SampleRate: '24000'
      });

      var audioPromise = signedFetch('POST', '/v1/speech', audioRequest)
        .then(function (response) { return response.blob(); });

      if (!req.wantMarks || !ssml) {
        return audioPromise.then(function (blob) {
          return { blob: blob, marks: [], warnings: warnings };
        });
      }

      var marksRequest = Object.assign({}, base, {
        OutputFormat: 'json',
        SpeechMarkTypes: ['ssml']
      });

      var marksPromise = signedFetch('POST', '/v1/speech', marksRequest)
        .then(function (response) { return response.text(); })
        .then(parseSpeechMarks)
        // Losing the marks should not lose the audio; degrade to sentence-level.
        .catch(function () { return []; });

      return Promise.all([audioPromise, marksPromise]).then(function (results) {
        return { blob: results[0], marks: results[1], warnings: warnings };
      });
    },

    _parseSpeechMarks: parseSpeechMarks,
    _engineFor: engineFor,
    _neuralCaveats: neuralCaveats
  });
})(window);
