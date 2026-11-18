/*
 * provider-azure.js
 * =================
 * Microsoft Azure AI Speech — text to speech, REST endpoint.
 *
 * Azure requires the SSML body to name the voice with a `<voice>` element and
 * to carry an `xml:lang` matching that voice's locale, so the composed document
 * is retagged and wrapped before it is sent.
 *
 * Word boundary and bookmark events are delivered by the Speech SDK over its
 * websocket connection, not by this REST endpoint. Sentence-level highlighting
 * therefore works here; word-level does not.
 *
 * Docs: https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
 */
(function (root) {
  'use strict';

  var P = root.TtsProviders;

  var config = { key: '', region: 'eastus' };

  function endpoint(path) {
    return 'https://' + encodeURIComponent(config.region) +
      '.tts.speech.microsoft.com/cognitiveservices' + path;
  }

  function ensureConfigured() {
    if (!config.key) throw new P.ProviderError('No Azure Speech key configured.');
    if (!config.region) throw new P.ProviderError('No Azure region configured.');
  }

  /**
   * Rebuild the composed SSML into the shape Azure expects:
   *   <speak version="1.0" xmlns="…" xml:lang="<locale>">
   *     <voice name="<voice>"> … </voice>
   *   </speak>
   */
  function toAzureSsml(ssml, voiceName, locale) {
    var retagged = P.retagSpeak(ssml,
      'version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' +
      String(locale).replace(/"/g, '&quot;') + '"');
    return P.wrapSpeakBody(retagged,
      '<voice name="' + String(voiceName).replace(/"/g, '&quot;') + '">',
      '</voice>');
  }

  P.register({
    id: 'azure',
    name: 'Microsoft Azure AI Speech',
    kind: 'audio',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech',
    supports: { ssml: true, wordMarks: false, pitch: false },
    note: 'Native SSML. The REST endpoint returns audio only — word boundary ' +
      'events require the Speech SDK — so highlighting is by sentence.',

    credentialFields: [
      {
        key: 'key',
        label: 'Speech resource key',
        type: 'password',
        placeholder: '32-character key',
        required: true,
        hint: 'Azure portal → your Speech resource → Keys and Endpoint.'
      },
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        placeholder: 'eastus',
        required: true,
        hint: 'The short region name shown beside the key, e.g. eastus, westeurope.'
      }
    ],

    configure: function (creds) {
      config.key = (creds && creds.key) || '';
      config.region = ((creds && creds.region) || 'eastus').trim().toLowerCase();
    },
    isConfigured: function () {
      return !!(config.key && config.region);
    },
    describeConfig: function () {
      return config.key ? 'key set, region ' + config.region : 'no key';
    },

    listVoices: function () {
      try {
        ensureConfigured();
      } catch (err) {
        return Promise.reject(err);
      }

      return fetch(endpoint('/voices/list'), {
        headers: { 'Ocp-Apim-Subscription-Key': config.key }
      }).catch(function (err) {
        throw P.describeFailure(err, 'Azure Speech');
      }).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw P.httpError('Azure Speech', response, text);
          var list;
          try {
            list = JSON.parse(text);
          } catch (e) {
            throw new P.ProviderError('Azure Speech returned a malformed voice list.');
          }
          return list.map(function (voice) {
            return {
              id: voice.ShortName,
              name: voice.DisplayName || voice.ShortName,
              lang: voice.Locale,
              detail: [
                voice.VoiceType === 'Neural' ? 'Neural' : voice.VoiceType,
                (voice.Gender || '').toLowerCase()
              ].filter(Boolean).join(', '),
              raw: voice
            };
          });
        });
      });
    },

    synthesize: function (req) {
      try {
        ensureConfigured();
      } catch (err) {
        return Promise.reject(err);
      }

      var voiceName = (req.voice && req.voice.id) || 'en-US-JennyNeural';
      var locale = (req.voice && req.voice.lang) || req.lang || 'en-US';
      var ssml = req.ssml || P.textToSsml(req.text, locale);

      return fetch(endpoint('/v1'), {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': config.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
        },
        body: toAzureSsml(ssml, voiceName, locale)
      }).catch(function (err) {
        throw P.describeFailure(err, 'Azure Speech');
      }).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            throw P.httpError('Azure Speech', response, text);
          });
        }
        return response.blob().then(function (blob) {
          return { blob: blob, marks: [] };
        });
      });
    },

    _toAzureSsml: toAzureSsml
  });
})(window);
