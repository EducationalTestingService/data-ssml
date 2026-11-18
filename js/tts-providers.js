/*
 * tts-providers.js
 * ================
 * Registry and shared plumbing for speech backends, plus the built-in Web
 * Speech provider.
 *
 * Two kinds of provider exist:
 *
 *   kind 'webspeech' — the browser's SpeechSynthesis. Speaks a string and
 *                      fires boundary events as it goes. No SSML.
 *   kind 'audio'     — a cloud REST service. Returns a finished audio clip,
 *                      optionally with timing marks. Accepts SSML.
 *
 * A provider exposes:
 *   id, name, kind, docsUrl
 *   supports: {ssml, wordMarks, pitch, ssmlSubset, markAlignment}
 *     ssml           accepts SSML at all
 *     ssmlSubset     null for a full SSML engine; otherwise the tags it does
 *                    consume, e.g. {break: true, phoneme: true}. Directives
 *                    outside the subset are emulated before sending.
 *     wordMarks      reports timing data usable for word highlighting
 *     markAlignment  that timing is offsets into the sent string rather than
 *                    named <mark> elements
 *   credentialFields: [{key, label, type, placeholder, required, hint}]
 *   configure(creds) / isConfigured() / describeConfig()
 *   listVoices()  -> Promise<[{id, name, lang, detail, raw}]>
 *   synthesize(request) -> Promise<{blob, marks}>   (audio providers only)
 *
 * synthesize() request:
 *   {ssml, text, voice, lang, wantMarks, pitch}
 * Exactly one of `ssml` / `text` is set. `marks` come back as
 * [{timeMs, name}] where `name` matches a mark emitted by composeSsmlWithMarks.
 */
(function (root) {
  'use strict';

  // =====================================================================
  // Errors
  // =====================================================================

  function ProviderError(message, options) {
    options = options || {};
    var err = Error.call(this, message);
    this.name = 'ProviderError';
    this.message = message;
    this.status = options.status || 0;
    this.hint = options.hint || '';
    this.stack = err.stack;
  }
  ProviderError.prototype = Object.create(Error.prototype);
  ProviderError.prototype.constructor = ProviderError;

  /** Turn a failed response or a thrown fetch error into something actionable. */
  function describeFailure(err, providerName) {
    if (err instanceof ProviderError) return err;

    // A rejected fetch is opaque by design: CORS, DNS, offline and blocked
    // requests all surface as the same TypeError.
    //
    // All three services do send permissive CORS headers, including for the
    // "null" origin a file:// page presents, so this is more often a typo in
    // the region, a network block, or an ad blocker than a CORS policy.
    var hint = 'The browser could not complete the request. Check the region ' +
      'spelling, connectivity, and any extension that blocks requests.';
    return new ProviderError(providerName + ' request failed: ' + (err.message || err), {
      hint: hint
    });
  }

  function httpError(providerName, response, body) {
    var detail = '';
    try {
      var parsed = typeof body === 'string' ? JSON.parse(body) : body;
      detail = (parsed && (parsed.error && (parsed.error.message || parsed.error.Message))) ||
        (parsed && (parsed.message || parsed.Message)) || '';
    } catch (e) {
      detail = typeof body === 'string' ? body.slice(0, 300) : '';
    }

    var hint = '';
    if (response.status === 401 || response.status === 403) {
      hint = 'The service rejected the credentials. Check the key, the region, ' +
        'and that the service is enabled for this account.';
    } else if (response.status === 400) {
      hint = 'The service rejected the request body — often unsupported SSML for ' +
        'the selected voice or engine.';
    } else if (response.status === 429) {
      hint = 'Rate limited or over quota.';
    }

    return new ProviderError(
      providerName + ' returned ' + response.status + ' ' + response.statusText +
      (detail ? ': ' + detail : ''),
      { status: response.status, hint: hint }
    );
  }

  // =====================================================================
  // Small helpers shared by the cloud providers
  // =====================================================================

  function base64ToBlob(base64, mimeType) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  /**
   * Replace the `<speak …>` opening tag's attributes.
   * Polly wants a bare `<speak>`; Azure wants the locale of the chosen voice.
   */
  function retagSpeak(ssml, attributes) {
    var attrs = attributes ? ' ' + attributes : '';
    return ssml.replace(/^<speak[^>]*>/, '<speak' + attrs + '>');
  }

  /** Insert a wrapper element between `<speak>` and `</speak>`. */
  function wrapSpeakBody(ssml, openTag, closeTag) {
    var open = /^<speak[^>]*>/.exec(ssml);
    if (!open) return ssml;
    var head = open[0];
    var body = ssml.slice(head.length, ssml.lastIndexOf('</speak>'));
    return head + openTag + body + closeTag + '</speak>';
  }

  /** Wrap plain text as a minimal SSML document. */
  function textToSsml(text, lang) {
    return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' +
      String(lang || 'en').replace(/"/g, '&quot;') + '">' +
      String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</speak>';
  }

  function langBase(lang) {
    return String(lang || '').split(/[-_]/)[0].toLowerCase();
  }

  // =====================================================================
  // Registry
  // =====================================================================

  var registry = [];

  function register(provider) {
    provider.supports = Object.assign({
      ssml: false,
      wordMarks: false,
      pitch: true,
      ssmlSubset: null,
      markAlignment: false
    }, provider.supports || {});
    provider.credentialFields = provider.credentialFields || [];
    registry.push(provider);
    return provider;
  }

  function get(id) {
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].id === id) return registry[i];
    }
    return null;
  }

  function list() {
    return registry.slice();
  }

  // =====================================================================
  // Credential storage
  // =====================================================================
  //
  // Session storage by default so keys disappear when the tab closes; local
  // storage only when the user opts in. Either way the credentials stay on this
  // device and are sent only to the provider's own endpoint.

  var CRED_PREFIX = 'data-ssml-ra-creds:';

  function saveCredentials(providerId, creds, remember) {
    var payload = JSON.stringify(creds);
    try {
      sessionStorage.setItem(CRED_PREFIX + providerId, payload);
      if (remember) localStorage.setItem(CRED_PREFIX + providerId, payload);
      else localStorage.removeItem(CRED_PREFIX + providerId);
    } catch (e) { /* storage may be unavailable */ }
  }

  function loadCredentials(providerId) {
    try {
      var raw = sessionStorage.getItem(CRED_PREFIX + providerId) ||
        localStorage.getItem(CRED_PREFIX + providerId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function isRemembered(providerId) {
    try {
      return !!localStorage.getItem(CRED_PREFIX + providerId);
    } catch (e) {
      return false;
    }
  }

  function clearCredentials(providerId) {
    try {
      sessionStorage.removeItem(CRED_PREFIX + providerId);
      localStorage.removeItem(CRED_PREFIX + providerId);
    } catch (e) { /* ignore */ }
  }

  // =====================================================================
  // Web Speech provider
  // =====================================================================

  var webSpeech = {
    id: 'webspeech',
    name: 'Browser (Web Speech API)',
    kind: 'webspeech',
    docsUrl: 'https://developer.mozilla.org/docs/Web/API/Web_Speech_API',
    supports: { ssml: false, wordMarks: true, pitch: true },
    credentialFields: [],
    note: 'On-device and OS voices. No SSML input path exists in any shipping ' +
      'browser, so directives are realized client-side in Emulate mode.',

    configure: function () {},
    isConfigured: function () {
      return typeof window.speechSynthesis !== 'undefined';
    },
    describeConfig: function () {
      return this.isConfigured() ? 'available' : 'not available in this browser';
    },

    listVoices: function () {
      return new Promise(function (resolve) {
        var collect = function () {
          return (window.speechSynthesis.getVoices() || []).map(function (voice) {
            var tags = [voice.localService ? 'local' : 'network'];
            if (voice.default) tags.push('default');
            return {
              id: voice.voiceURI + '|' + voice.lang,
              name: voice.name,
              lang: voice.lang,
              detail: tags.join(', '),
              raw: voice
            };
          });
        };

        var voices = collect();
        if (voices.length) { resolve(voices); return; }

        // Most browsers populate the list asynchronously; Safari sometimes
        // never fires voiceschanged, so poll briefly as a backstop.
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          var next = collect();
          if (next.length || tries > 20) {
            clearInterval(timer);
            resolve(next);
          }
        }, 250);
      });
    }
  };

  root.TtsProviders = {
    register: register,
    get: get,
    list: list,
    ProviderError: ProviderError,
    describeFailure: describeFailure,
    httpError: httpError,
    base64ToBlob: base64ToBlob,
    retagSpeak: retagSpeak,
    wrapSpeakBody: wrapSpeakBody,
    textToSsml: textToSsml,
    langBase: langBase,
    saveCredentials: saveCredentials,
    loadCredentials: loadCredentials,
    isRemembered: isRemembered,
    clearCredentials: clearCredentials
  };

  register(webSpeech);
})(window);
