/*
 * app.js
 * ======
 * UI wiring for the data-ssml Read Aloud prototype: editor, live render,
 * voice selection, transport, highlighting, and the inspector.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    input: $('html-input'),
    sample: $('sel-sample'),
    format: $('btn-format'),

    preview: $('preview'),
    content: $('preview-content'),
    overlay: $('hl-overlay'),

    play: $('btn-play'),
    playLabel: $('play-label'),
    stop: $('btn-stop'),
    prev: $('btn-prev'),
    next: $('btn-next'),
    status: $('status'),

    badgeUnits: $('badge-units'),
    badgeSsml: $('badge-ssml'),
    badgeHl: $('badge-hlmode'),

    provider: $('sel-provider'),
    providerNote: $('provider-note'),
    badgeProvider: $('badge-provider'),
    btnCreds: $('btn-creds'),

    dlgCreds: $('dlg-creds'),
    credsTitle: $('creds-title'),
    credsIntro: $('creds-intro'),
    credsForm: $('creds-form'),
    credsSecurity: $('creds-security'),
    credsFileWarning: $('creds-file-warning'),
    credsStatus: $('creds-status'),
    chkRemember: $('chk-remember'),
    btnCredsSave: $('btn-creds-save'),
    btnCredsTest: $('btn-creds-test'),
    btnCredsForget: $('btn-creds-forget'),

    voice: $('sel-voice'),
    voiceNote: $('voice-note'),
    modeNote: $('mode-note'),
    rate: $('rng-rate'),
    pitch: $('rng-pitch'),
    volume: $('rng-volume'),
    outRate: $('out-rate'),
    outPitch: $('out-pitch'),
    outVolume: $('out-volume'),

    chkSentence: $('chk-sentence'),
    chkWord: $('chk-word'),
    chkFollow: $('chk-follow'),
    chkRespell: $('chk-respell'),
    chkDebug: $('chk-debug'),

    probe: $('btn-probe'),
    probeVerdict: $('probe-verdict'),
    probeAnswers: $('probe-answers'),
    probeYes: $('btn-probe-yes'),
    probeNo: $('btn-probe-no'),
    probeTags: $('btn-probe-tags'),

    paneAttrs: $('pane-attrs'),
    paneUnits: $('pane-units'),
    paneLog: $('pane-log'),
    log: $('log'),
    clearLog: $('btn-clear-log'),

    viewSwitch: $('view-switch'),

    help: $('dlg-help'),
    btnHelp: $('btn-help'),
    dlgTest: $('dlg-test'),
    btnSelftest: $('btn-selftest'),
    testSummary: $('test-summary'),
    testResults: $('test-results')
  };

  var STORE_KEY = 'data-ssml-ra-prototype';

  var model = { units: [], nodes: [], ssmlSpans: [], text: '' };
  var highlighter = null;
  var engine = null;
  var voices = [];
  var ssmlCapability = {};   // voice key -> 'yes' | 'no' | 'tags'
  var renderTimer = null;
  var provider = null;
  var voiceChoice = {};      // provider id -> selected voice id
  var credsProvider = null;  // provider the dialog is currently editing
  var currentView = 'reader';

  // =====================================================================
  // Persistence
  // =====================================================================

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        html: el.input.value,
        sample: el.sample.value,
        providerId: provider ? provider.id : 'webspeech',
        voiceChoice: voiceChoice,
        voiceURI: el.voice.value,
        mode: currentMode(),
        rate: el.rate.value,
        pitch: el.pitch.value,
        volume: el.volume.value,
        sentence: el.chkSentence.checked,
        word: el.chkWord.checked,
        follow: el.chkFollow.checked,
        respell: el.chkRespell.checked,
        view: currentView,
        capability: ssmlCapability
      }));
    } catch (e) { /* storage may be unavailable; preferences are not critical */ }
  }

  // =====================================================================
  // Logging
  // =====================================================================

  var LOG_LIMIT = 400;

  function log(level, message) {
    if (level === 'debug' && !el.chkDebug.checked) return;

    var line = document.createElement('div');
    line.className = 'log-line ' + level;

    var t = document.createElement('span');
    t.className = 't';
    var now = new Date();
    t.textContent =
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') + '.' +
      String(now.getMilliseconds()).padStart(3, '0');

    line.appendChild(t);
    line.appendChild(document.createTextNode(message));
    el.log.appendChild(line);

    while (el.log.childElementCount > LOG_LIMIT) el.log.removeChild(el.log.firstChild);
    el.log.scrollTop = el.log.scrollHeight;
  }

  // =====================================================================
  // Rendering the author's HTML
  // =====================================================================

  var STRIP_TAGS = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'];

  /**
   * Render the source into the preview. Active content is removed: this is an
   * authoring surface for pronunciation markup, not a page sandbox.
   */
  function render() {
    var source = el.input.value;
    var host = document.createElement('div');

    // Parsing in a detached document keeps anything active from executing.
    var doc = new DOMParser().parseFromString(
      '<!DOCTYPE html><body>' + source + '</body>', 'text/html');

    STRIP_TAGS.forEach(function (tag) {
      Array.prototype.slice.call(doc.body.querySelectorAll(tag)).forEach(function (n) {
        n.parentNode.removeChild(n);
      });
    });

    // Drop inline event handlers and javascript: URLs.
    Array.prototype.slice.call(doc.body.querySelectorAll('*')).forEach(function (node) {
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        if (name.indexOf('on') === 0) node.removeAttribute(attr.name);
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
          node.removeAttribute(attr.name);
        }
      });
    });

    while (doc.body.firstChild) host.appendChild(doc.body.firstChild);

    el.content.textContent = '';
    while (host.firstChild) el.content.appendChild(host.firstChild);

    rebuildModel();
  }

  function rebuildModel() {
    var wasPlaying = engine && engine.state !== 'idle';
    if (wasPlaying) engine.stop();

    model = window.Segmenter.build(el.content, { locale: document.documentElement.lang || 'en' });

    // Flag parse failures in the rendered content so they are visible.
    model.ssmlSpans.forEach(function (span) {
      if (span.error) span.el.setAttribute('data-ssml-error', '');
      else span.el.removeAttribute('data-ssml-error');
    });

    var errors = model.ssmlSpans.filter(function (s) { return s.error; }).length;

    el.badgeUnits.textContent = model.units.length +
      (model.units.length === 1 ? ' sentence' : ' sentences');
    el.badgeSsml.textContent = model.ssmlSpans.length + ' data-ssml' +
      (errors ? ' · ' + errors + ' invalid' : '');
    el.badgeSsml.className = 'badge' + (errors ? ' badge-err' : '');

    renderAttributesPane();
    renderUnitsPane();
    updateViewBadges();
    preparePlayback();
    updateTransport();
  }

  // =====================================================================
  // Playback
  // =====================================================================

  function currentMode() {
    var checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'emulate';
  }

  function preparePlayback() {
    if (!engine) return;
    engine.options.voice = selectedVoice();
    engine.options.pitch = parseFloat(el.pitch.value);
    engine.options.volume = parseFloat(el.volume.value);

    var voice = selectedVoice();
    engine.prepare(model.units, {
      mode: currentMode(),
      rate: parseFloat(el.rate.value),
      phonemeRespelling: el.chkRespell.checked,
      wordMarks: el.chkWord.checked && provider.supports.wordMarks,
      lang: (voice && voice.lang) || 'en'
    });

    renderUnitsPane();
  }

  function updateTransport() {
    var has = model.units.length > 0;
    var state = engine ? engine.state : 'idle';

    el.play.disabled = !has;
    el.stop.disabled = !has || state === 'idle';
    el.prev.disabled = !has || state === 'idle';
    el.next.disabled = !has || state === 'idle';

    el.playLabel.textContent = state === 'speaking' ? 'Pause' : (state === 'paused' ? 'Resume' : 'Play');
    el.play.querySelector('.icon').textContent = state === 'speaking' ? '⏸' : '▶';

    if (!has) {
      el.status.textContent = 'Nothing to read';
    } else if (state === 'idle') {
      el.status.textContent = 'Ready · ' + model.units.length + ' sentences';
    } else {
      var n = engine.currentUnitIndex + 1;
      var verb = state === 'paused' ? 'Paused' : (engine.synthesizing ? 'Synthesizing' : 'Reading');
      el.status.textContent = verb + ' · sentence ' + n + ' of ' + model.units.length;
    }
  }

  function highlightUnit(unit) {
    if (!highlighter) return;
    if (!el.chkSentence.checked) { highlighter.setSentence(null); return; }

    var range = window.Segmenter.rangeFor(model.nodes, unit.start, unit.end);
    highlighter.setSentence(range);
    highlighter.clearWord();
    if (range && el.chkFollow.checked) highlighter.scrollIntoView(range);
  }

  function highlightWord(payload) {
    if (!highlighter || !el.chkWord.checked) return;

    var unit = model.units[payload.unitIndex];
    if (!unit) return;

    var absStart = unit.start + payload.start;
    var absEnd = unit.start + Math.max(payload.end, payload.start);

    if (payload.exact) {
      // Grow to whole-word bounds; engines report inconsistent charLength.
      var bounds = window.Segmenter.expandToWord(model.text, absStart, absEnd - absStart);
      absStart = bounds[0];
      absEnd = bounds[1];
    }

    absStart = Math.max(absStart, unit.start);
    absEnd = Math.min(absEnd, unit.end);

    var range = window.Segmenter.rangeFor(model.nodes, absStart, absEnd);
    highlighter.setWord(range);
  }

  // =====================================================================
  // Inspector — attributes
  // =====================================================================

  function renderAttributesPane() {
    el.paneAttrs.textContent = '';

    if (!model.ssmlSpans.length) {
      el.paneAttrs.innerHTML =
        '<p class="empty">No <code>data-ssml</code> attributes in the rendered content.</p>';
      return;
    }

    model.ssmlSpans.forEach(function (span, i) {
      var item = document.createElement('div');
      item.className = 'insp-item' + (span.error ? ' is-error' : '');
      item.dataset.spanIndex = String(i);

      var head = document.createElement('div');
      head.className = 'insp-head';
      head.innerHTML =
        '<span class="tagname">&lt;' + span.el.tagName.toLowerCase() + '&gt;</span>' +
        '<span>' + (span.error ? 'invalid' : Object.keys(span.parsed).join(', ') || 'no directives') + '</span>' +
        (span.atomic ? '<span class="badge badge-quiet">atomic</span>' : '') +
        (span.error ? '<span class="badge badge-err">error</span>' :
          (span.warnings.length ? '<span class="badge badge-warn">warning</span>' : ''));
      item.appendChild(head);

      var body = document.createElement('div');
      body.className = 'insp-body';

      var visible = model.text.slice(span.start, span.end).trim();

      var dl = document.createElement('dl');
      appendRow(dl, 'text', visible || '(empty)');
      appendRow(dl, 'attribute', span.raw);
      body.appendChild(dl);

      if (span.error) {
        var errBox = document.createElement('div');
        errBox.className = 'insp-msg err';
        errBox.textContent = 'DataSsmlError: ' + span.error;
        body.appendChild(errBox);
      } else {
        span.warnings.forEach(function (w) {
          var warnBox = document.createElement('div');
          warnBox.className = 'insp-msg warn';
          warnBox.textContent = w;
          body.appendChild(warnBox);
        });

        var normalized = document.createElement('pre');
        normalized.textContent = 'normalized:\n' + JSON.stringify(span.parsed, null, 2);
        body.appendChild(normalized);

        if (visible && Object.keys(span.parsed).length) {
          var ssml = document.createElement('pre');
          ssml.textContent = 'SSML 1.1:\n' + window.DataSsmlToSsml.formatForDisplay(
            window.DataSsmlToSsml.toSsml(visible, span.parsed, span.el.lang || 'en'));
          body.appendChild(ssml);
        }
      }

      item.appendChild(body);

      item.addEventListener('click', function () {
        var range = window.Segmenter.rangeFor(model.nodes, span.start, span.end);
        if (range && highlighter) {
          highlighter.setSentence(range);
          highlighter.scrollIntoView(range);
        }
      });

      el.paneAttrs.appendChild(item);
    });
  }

  function appendRow(dl, label, value) {
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  // =====================================================================
  // Inspector — sentences
  // =====================================================================

  function renderUnitsPane() {
    el.paneUnits.textContent = '';

    if (!model.units.length) {
      el.paneUnits.innerHTML = '<p class="empty">Nothing to read.</p>';
      return;
    }

    var plan = (engine && engine.plan) || [];

    model.units.forEach(function (unit, i) {
      var entry = plan[i];
      var item = document.createElement('div');
      item.className = 'insp-item';
      item.dataset.unitIndex = String(i);

      var directiveKeys = Object.keys(unit.directives);

      var head = document.createElement('div');
      head.className = 'insp-head';
      head.innerHTML =
        '<span class="tagname">#' + (i + 1) + '</span>' +
        (directiveKeys.length
          ? '<span class="badge">' + directiveKeys.join(' · ') + '</span>'
          : '<span>plain</span>') +
        (unit.atomic ? '<span class="badge badge-quiet">atomic</span>' : '');
      item.appendChild(head);

      var body = document.createElement('div');
      body.className = 'insp-body';

      var dl = document.createElement('dl');
      appendRow(dl, 'shown', unit.text);
      if (entry && entry.spoken && entry.spoken !== unit.text) {
        appendRow(dl, 'spoken', entry.mode === 'ssml' ? '(SSML — see below)' : entry.spoken);
      }
      body.appendChild(dl);

      if (entry) {
        entry.notes.forEach(function (note) {
          var p = document.createElement('p');
          p.className = 'insp-note';
          p.textContent = note;
          body.appendChild(p);
        });

        if (entry.ssml) {
          var pre = document.createElement('pre');
          pre.textContent = window.DataSsmlToSsml.formatForDisplay(entry.ssml);
          body.appendChild(pre);
        }

        var silences = entry.steps.filter(function (s) { return s.kind === 'silence'; });
        if (silences.length) {
          var p2 = document.createElement('p');
          p2.className = 'insp-note';
          p2.textContent = entry.steps.filter(function (s) { return s.kind === 'speak'; }).length +
            ' utterance(s) + ' + silences.length + ' silence(s)';
          body.appendChild(p2);
        }
      }

      item.appendChild(body);

      item.addEventListener('click', function () {
        engine.play(i);
      });

      el.paneUnits.appendChild(item);
    });
  }

  function markActiveUnit(index) {
    Array.prototype.slice.call(el.paneUnits.children).forEach(function (child) {
      child.classList.toggle('is-active', child.dataset.unitIndex === String(index));
    });
    var active = el.paneUnits.querySelector('.is-active');
    if (active && el.paneUnits.hidden === false) {
      var box = active.getBoundingClientRect();
      var parent = el.paneUnits.parentElement.getBoundingClientRect();
      if (box.top < parent.top || box.bottom > parent.bottom) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // =====================================================================
  // Single-panel view switching
  // =====================================================================
  //
  // On a narrow or short viewport only one panel is laid out at a time (see
  // the Regime C media query in app.css). The others stay in the DOM, so
  // playback, the segmenter model, and highlighting all keep running behind
  // whatever is on screen.
  //
  // This query must match Regime C in app.css.
  var SINGLE_VIEW_QUERY = '(max-width: 767px), (max-height: 559px)';
  var singleViewMedia = window.matchMedia(SINGLE_VIEW_QUERY);

  var VIEWS = ['editor', 'reader', 'voice', 'inspector'];

  function viewTabs() {
    return Array.prototype.slice.call(el.viewSwitch.querySelectorAll('.view-tab'));
  }

  function setView(name, options) {
    options = options || {};
    if (VIEWS.indexOf(name) === -1) name = 'reader';
    currentView = name;
    document.body.dataset.view = name;

    viewTabs().forEach(function (tab) {
      var active = tab.dataset.view === name;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      // Roving tabindex: only the selected tab is a tab stop.
      tab.tabIndex = active ? 0 : -1;
      if (active && options.focusTab) tab.focus();
    });

    // A panel that was display:none has no box to measure, so the overlay
    // highlighter needs to redraw once it is visible again.
    if (highlighter) highlighter.refresh();
    savePrefs();
  }

  /**
   * Tab semantics only make sense while the switcher is on screen. When the
   * layout shows every panel at once, the roles are removed so a screen reader
   * does not announce four tabpanels that are all visible.
   */
  function syncViewSemantics() {
    var single = singleViewMedia.matches;

    VIEWS.forEach(function (name) {
      var panel = $('panel-' + name);
      if (!panel) return;
      if (single) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', 'tab-view-' + name);
        panel.tabIndex = 0;
      } else {
        panel.removeAttribute('role');
        panel.setAttribute('aria-labelledby', 'h-' + name);
        panel.removeAttribute('tabindex');
      }
    });

    if (single) setView(currentView);
  }

  function initViewSwitch() {
    el.viewSwitch.addEventListener('click', function (event) {
      var tab = event.target.closest('.view-tab');
      if (tab) setView(tab.dataset.view);
    });

    // Standard tablist keyboard behaviour.
    el.viewSwitch.addEventListener('keydown', function (event) {
      var index = VIEWS.indexOf(currentView);
      var next = null;

      if (event.key === 'ArrowRight') next = VIEWS[(index + 1) % VIEWS.length];
      else if (event.key === 'ArrowLeft') next = VIEWS[(index - 1 + VIEWS.length) % VIEWS.length];
      else if (event.key === 'Home') next = VIEWS[0];
      else if (event.key === 'End') next = VIEWS[VIEWS.length - 1];
      else return;

      event.preventDefault();
      setView(next, { focusTab: true });
    });

    var onChange = function () { syncViewSemantics(); };
    if (singleViewMedia.addEventListener) singleViewMedia.addEventListener('change', onChange);
    else singleViewMedia.addListener(onChange);

    syncViewSemantics();
  }

  /** Surface counts on the tabs so hidden panels still report state. */
  function updateViewBadges() {
    var counts = {
      reader: model.units.length,
      inspector: model.ssmlSpans.length
    };
    viewTabs().forEach(function (tab) {
      var count = counts[tab.dataset.view];
      var badge = tab.querySelector('.tab-count');
      if (count === undefined || !count) {
        if (badge) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tab-count';
        tab.appendChild(badge);
      }
      badge.textContent = count;
    });
  }

  // =====================================================================
  // Providers
  // =====================================================================

  function providerVoiceKey(voice) {
    return provider.id + '|' + voice.id;
  }

  function populateProviders() {
    el.provider.textContent = '';
    window.TtsProviders.list().forEach(function (p) {
      var option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      el.provider.appendChild(option);
    });
  }

  /** Restore any stored credentials so a configured provider works on reload. */
  function restoreCredentials() {
    window.TtsProviders.list().forEach(function (p) {
      if (!p.credentialFields.length) return;
      var creds = window.TtsProviders.loadCredentials(p.id);
      if (creds) p.configure(creds);
    });
  }

  function setProvider(id, options) {
    options = options || {};
    var next = window.TtsProviders.get(id) || window.TtsProviders.get('webspeech');
    provider = next;
    el.provider.value = provider.id;
    if (engine) engine.setProvider(provider);

    updateProviderUi();
    updateModeNote();

    if (!provider.isConfigured()) {
      voices = [];
      el.voice.textContent = '';
      var opt = document.createElement('option');
      opt.textContent = 'Add credentials to load voices';
      el.voice.appendChild(opt);
      el.voiceNote.textContent = '';
      updateTransport();
      if (options.promptForCredentials) openCredentials(provider);
      return;
    }

    // A cloud service handles SSML natively, which is the reason to use one.
    if (provider.supports.ssml && options.preferSsmlMode !== false &&
        currentMode() === 'emulate') {
      var radio = document.querySelector('input[name="mode"][value="ssml"]');
      if (radio) { radio.checked = true; updateModeNote(); }
    }

    loadVoices();
  }

  function updateProviderUi() {
    var configured = provider.isConfigured();
    var bits = [];

    var subset = provider.supports.ssmlSubset;
    if (!provider.supports.ssml) {
      el.badgeProvider.textContent = 'no SSML input';
      el.badgeProvider.className = 'badge badge-quiet';
    } else if (subset) {
      el.badgeProvider.textContent = 'partial SSML';
      el.badgeProvider.className = 'badge badge-warn';
    } else {
      el.badgeProvider.textContent = 'native SSML';
      el.badgeProvider.className = 'badge badge-ok';
    }

    if (provider.credentialFields.length) {
      el.btnCreds.hidden = false;
      el.btnCreds.textContent = configured ? 'Credentials ✓' : 'API key…';
      if (configured) bits.push(provider.describeConfig() + '.');
      else bits.push('No credentials yet — add a key to load voices.');
    } else {
      el.btnCreds.hidden = true;
    }

    bits.push(provider.note || '');
    if (provider.supports.ssml && !provider.supports.wordMarks) {
      bits.push('Word highlighting is unavailable here; sentences still highlight.');
    }
    if (subset) {
      var native = Object.keys(subset).filter(function (key) { return subset[key] === true; });
      bits.push('Consumes ' + native.join(' and ') + ' natively; every other ' +
        'directive is emulated before sending.');
    }

    el.providerNote.textContent = bits.filter(Boolean).join(' ');

    // Pitch is only adjustable where the service exposes it.
    var pitchSupported = provider.supports.pitch;
    el.pitch.disabled = !pitchSupported;
    var pitchLabel = document.querySelector('label[for="rng-pitch"]');
    if (pitchLabel) pitchLabel.style.opacity = pitchSupported ? '' : '0.5';

    el.probe.disabled = provider.kind !== 'webspeech';
    document.querySelector('.ssml-probe').hidden = provider.kind !== 'webspeech';
  }

  // =====================================================================
  // Voices
  // =====================================================================

  function loadVoices() {
    if (!provider || !provider.isConfigured()) return;

    var requested = provider.id;
    el.voice.textContent = '';
    var loading = document.createElement('option');
    loading.textContent = 'Loading voices…';
    el.voice.appendChild(loading);

    provider.listVoices().then(function (list) {
      if (provider.id !== requested) return;   // switched away while loading
      voices = list;
      renderVoiceOptions();
      preparePlayback();
      log('info', provider.name + ': ' + list.length + ' voices');
    }).catch(function (err) {
      if (provider.id !== requested) return;
      voices = [];
      el.voice.textContent = '';
      var opt = document.createElement('option');
      opt.textContent = 'Could not load voices';
      el.voice.appendChild(opt);
      reportProviderError(err);
    });
  }

  function renderVoiceOptions() {
    el.voice.textContent = '';

    if (!voices.length) {
      var empty = document.createElement('option');
      empty.textContent = 'No voices reported';
      el.voice.appendChild(empty);
      return;
    }

    // Preferred locale first, then everything else, grouped by language.
    var preferred = (navigator.language || 'en-US').toLowerCase();
    var rank = function (lang) {
      var l = String(lang || '').toLowerCase();
      if (l === preferred) return 0;
      if (window.TtsProviders.langBase(l) === window.TtsProviders.langBase(preferred)) return 1;
      return 2;
    };

    var sorted = voices.slice().sort(function (a, b) {
      var ra = rank(a.lang);
      var rb = rank(b.lang);
      if (ra !== rb) return ra - rb;
      if (a.lang !== b.lang) return String(a.lang).localeCompare(String(b.lang));
      return String(a.name).localeCompare(String(b.name));
    });

    var groups = {};
    sorted.forEach(function (voice) {
      var lang = voice.lang || 'unknown';
      if (!groups[lang]) {
        groups[lang] = document.createElement('optgroup');
        groups[lang].label = lang;
        el.voice.appendChild(groups[lang]);
      }
      var option = document.createElement('option');
      option.value = voice.id;

      var tags = voice.detail ? [voice.detail] : [];
      var cap = ssmlCapability[providerVoiceKey(voice)];
      if (cap === 'yes') tags.push('SSML ✓');
      else if (cap === 'no' || cap === 'tags') tags.push('SSML ✗');

      option.textContent = voice.name + (tags.length ? ' (' + tags.join(', ') + ')' : '');
      groups[lang].appendChild(option);
    });

    var want = voiceChoice[provider.id];
    var hasWanted = want && sorted.some(function (v) { return v.id === want; });
    if (hasWanted) {
      el.voice.value = want;
    } else {
      var fallback = sorted.find(function (v) {
        return v.raw && v.raw.default;
      }) || sorted[0];
      el.voice.value = fallback.id;
      voiceChoice[provider.id] = fallback.id;
    }

    updateVoiceNote();
  }

  function selectedVoice() {
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].id === el.voice.value) return voices[i];
    }
    return null;
  }

  function updateVoiceNote() {
    var voice = selectedVoice();
    if (!voice) { el.voiceNote.textContent = ''; return; }

    var bits = [];
    if (provider.kind === 'webspeech') {
      var native = voice.raw;
      bits.push(native && native.localService ? 'Local (on-device) voice' : 'Network voice');
      if (native && !native.localService) bits.push('boundary events are often unavailable');
      var cap = ssmlCapability[providerVoiceKey(voice)];
      if (cap === 'yes') bits.push('reported to accept SSML');
      else if (cap === 'no') bits.push('reported to ignore SSML markup');
      else if (cap === 'tags') bits.push('reported to read markup aloud');
    } else {
      bits.push(voice.lang + ' · ' + (voice.detail || 'cloud voice'));
      bits.push('audio is synthesized over the network and cached per sentence');
    }

    el.voiceNote.textContent = bits.join(' · ');

    if (provider.kind === 'webspeech') {
      var capability = ssmlCapability[providerVoiceKey(voice)];
      el.probeVerdict.textContent = capability
        ? ({ yes: 'SSML supported', no: 'markup ignored', tags: 'markup read aloud' })[capability]
        : 'untested';
      el.probeVerdict.className = 'badge ' +
        (capability === 'yes' ? 'badge-ok' : (capability ? 'badge-err' : 'badge-quiet'));
    }
  }

  function reportProviderError(err) {
    log('error', err.message + (err.hint ? ' — ' + err.hint : ''));
    el.status.textContent = 'Provider error';
  }

  // =====================================================================
  // Credentials dialog
  // =====================================================================

  function openCredentials(target) {
    credsProvider = target || provider;
    if (!credsProvider.credentialFields.length) return;

    el.credsTitle.textContent = credsProvider.name + ' credentials';
    el.credsIntro.textContent = credsProvider.note || '';
    el.credsFileWarning.hidden = location.protocol !== 'file:';
    $('creds-file-caveat').textContent = credsProvider.fileUrlCaveat || '';

    if (credsProvider.securityNote) {
      el.credsSecurity.textContent = credsProvider.securityNote;
      el.credsSecurity.hidden = false;
    } else {
      el.credsSecurity.hidden = true;
    }

    var existing = window.TtsProviders.loadCredentials(credsProvider.id) || {};
    el.chkRemember.checked = window.TtsProviders.isRemembered(credsProvider.id);

    el.credsForm.textContent = '';
    credsProvider.credentialFields.forEach(function (field) {
      var wrap = document.createElement('div');
      wrap.className = 'creds-field';

      var label = document.createElement('label');
      var inputId = 'cred-' + credsProvider.id + '-' + field.key;
      label.setAttribute('for', inputId);
      label.textContent = field.label + (field.required ? '' : ' (optional)');

      var input = document.createElement('input');
      input.id = inputId;
      input.type = field.type === 'password' ? 'password' : 'text';
      input.placeholder = field.placeholder || '';
      input.value = existing[field.key] || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.credKey = field.key;

      wrap.appendChild(label);
      wrap.appendChild(input);

      if (field.hint) {
        var hint = document.createElement('p');
        hint.className = 'field-note';
        hint.textContent = field.hint;
        wrap.appendChild(hint);
      }

      el.credsForm.appendChild(wrap);
    });

    setCredsStatus(credsProvider.isConfigured() ? 'saved' : 'not connected',
      credsProvider.isConfigured() ? 'ok' : 'quiet');
    el.dlgCreds.showModal();
  }

  function setCredsStatus(text, tone) {
    el.credsStatus.textContent = text;
    el.credsStatus.className = 'badge badge-' + (tone || 'quiet');
  }

  function readCredsForm() {
    var creds = {};
    Array.prototype.slice.call(el.credsForm.querySelectorAll('input')).forEach(function (input) {
      creds[input.dataset.credKey] = input.value.trim();
    });
    return creds;
  }

  function saveCredentials() {
    var creds = readCredsForm();
    var missing = credsProvider.credentialFields.filter(function (field) {
      return field.required && !creds[field.key];
    });
    if (missing.length) {
      setCredsStatus('missing ' + missing[0].label.toLowerCase(), 'err');
      return;
    }

    window.TtsProviders.saveCredentials(credsProvider.id, creds, el.chkRemember.checked);
    credsProvider.configure(creds);
    setCredsStatus('saved', 'ok');
    log('info', credsProvider.name + ': credentials saved (' +
      (el.chkRemember.checked ? 'this device' : 'this tab only') + ')');

    if (provider === credsProvider) {
      updateProviderUi();
      loadVoices();
    } else {
      setProvider(credsProvider.id);
    }
    el.dlgCreds.close();
  }

  function testCredentials() {
    var creds = readCredsForm();
    credsProvider.configure(creds);
    setCredsStatus('testing…', 'quiet');

    credsProvider.listVoices().then(function (list) {
      setCredsStatus(list.length + ' voices reachable', 'ok');
      log('info', credsProvider.name + ': connection ok, ' + list.length + ' voices');
    }).catch(function (err) {
      setCredsStatus('failed', 'err');
      reportProviderError(err);
    });
  }

  function forgetCredentials() {
    window.TtsProviders.clearCredentials(credsProvider.id);
    credsProvider.configure({});
    el.credsForm.querySelectorAll('input').forEach(function (input) { input.value = ''; });
    setCredsStatus('forgotten', 'quiet');
    log('info', credsProvider.name + ': credentials cleared');
    if (provider === credsProvider) {
      updateProviderUi();
      setProvider('webspeech');
    }
  }

  // =====================================================================
  // Delivery mode
  // =====================================================================

  function updateModeNote() {
    var mode = currentMode();
    var cloud = provider && provider.kind === 'audio';
    var notes;

    var subset = cloud ? provider.supports.ssmlSubset : null;

    if (cloud) {
      notes = {
        emulate: 'Directives are realized in the browser and plain text is sent to ' +
          provider.name + '. Useful for hearing the emulation and native SSML back to ' +
          'back on the same voice.',
        ssml: (subset
          ? provider.name + ' consumes ' +
            Object.keys(subset).filter(function (k) { return subset[k] === true; }).join(' and ') +
            ' itself; the directives it has no support for are emulated before ' +
            'sending, so this is a mixed rendering.'
          : provider.name + ' receives the SSML document and applies the directives ' +
            'itself. This is the reference rendering.') +
          (provider.supports.wordMarks
            ? ' Word timings come back from the service.'
            : ' This service reports no word timings, so highlighting is by sentence.'),
        plain: 'Only sub is applied, matching the reference library\'s apply_text_only() ' +
          'fallback. break, prosody, say-as, and phoneme are dropped before sending.'
      };
    } else {
      notes = {
        emulate: 'Directives are realized in the browser and plain text is sent to the ' +
          'voice. Works on every engine; word highlighting stays available.',
        ssml: 'The SSML document is sent verbatim. No browser engine accepts SSML, so ' +
          'expect the markup to be stripped or read aloud — which is what makes this a ' +
          'useful conformance check. Word highlighting is off in this mode.',
        plain: 'Only sub is applied, matching the reference library\'s apply_text_only() ' +
          'fallback. break, prosody, say-as, and phoneme are dropped.'
      };
    }

    el.modeNote.textContent = notes[mode];

    // Word highlighting needs boundary events (browser) or timing data (cloud).
    // Alignment-based timing is offsets into the sent string, so it works in
    // every mode; <mark>-based timing needs the instrumented SSML.
    var wordPossible;
    if (!cloud) wordPossible = mode !== 'ssml';
    else if (!provider.supports.wordMarks) wordPossible = false;
    else if (provider.supports.markAlignment) wordPossible = true;
    else wordPossible = mode === 'ssml';
    el.chkWord.disabled = !wordPossible;
  }

  // =====================================================================
  // SSML capability probe
  // =====================================================================

  var PROBE_SSML =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en">' +
    'S S M L is <sub alias="supported">not supported</sub>.</speak>';

  function runProbe() {
    var voice = selectedVoice();
    if (!voice) return;

    window.speechSynthesis.cancel();
    var utt = new SpeechSynthesisUtterance(PROBE_SSML);
    if (voice.raw) utt.voice = voice.raw;
    utt.lang = voice.lang;
    utt.rate = parseFloat(el.rate.value);
    utt.volume = parseFloat(el.volume.value);

    log('info', 'SSML probe → ' + PROBE_SSML);
    window.speechSynthesis.speak(utt);

    el.probeAnswers.hidden = false;
  }

  function recordCapability(value) {
    var voice = selectedVoice();
    if (!voice) return;
    ssmlCapability[providerVoiceKey(voice)] = value;
    savePrefs();
    renderVoiceOptions();
    log('info', 'Voice "' + voice.name + '" recorded as ' +
      (value === 'yes' ? 'SSML-capable' : 'not SSML-capable (' + value + ')'));
    el.probeAnswers.hidden = true;
  }

  // =====================================================================
  // Wiring
  // =====================================================================

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(function () {
      render();
      savePrefs();
    }, 350);
  }

  function tidySource() {
    // Light reformat: one block-level element per line.
    var text = el.input.value
      .replace(/>\s*\n\s*</g, '>\n<')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    el.input.value = text + '\n';
    render();
  }

  function togglePlayPause() {
    if (!engine || !model.units.length) return;
    if (engine.state === 'speaking') engine.pause();
    else if (engine.state === 'paused') engine.resume();
    else engine.play();
  }

  function startFromPoint(event) {
    if (engine && engine.state !== 'idle') return;  // do not hijack an active read

    var offset = null;
    if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (pos) offset = window.Segmenter.offsetForPoint(model.nodes, pos.offsetNode, pos.offset);
    } else if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) offset = window.Segmenter.offsetForPoint(model.nodes, range.startContainer, range.startOffset);
    }
    if (offset === null) return;

    for (var i = 0; i < model.units.length; i++) {
      if (offset >= model.units[i].start && offset <= model.units[i].end) {
        engine.play(i);
        return;
      }
    }
  }

  function switchTab(name) {
    ['attrs', 'units', 'log'].forEach(function (key) {
      var tab = document.querySelector('.tab[data-tab="' + key + '"]');
      var pane = $('pane-' + key);
      var active = key === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      pane.hidden = !active;
    });
  }

  function runSelfTest() {
    el.testSummary.textContent = 'Running…';
    el.testResults.textContent = '';
    if (!el.dlgTest.open) el.dlgTest.showModal();
    window.SelfTest.run().then(showTestResults);
  }

  function showTestResults(results) {
    el.testSummary.textContent = results.passed + ' passed, ' + results.failed + ' failed ' +
      '(' + results.total + ' assertions)';
    el.testSummary.style.color = results.failed ? 'var(--err)' : 'var(--ok)';

    el.testResults.textContent = '';
    results.groups.forEach(function (group) {
      var wrap = document.createElement('div');
      wrap.className = 'test-group';
      var h = document.createElement('h4');
      h.textContent = group.name;
      wrap.appendChild(h);
      group.cases.forEach(function (c) {
        var div = document.createElement('div');
        div.className = 'test-case ' + (c.ok ? 'pass' : 'fail');
        div.textContent = (c.ok ? '✓ ' : '✗ ') + c.name + (c.ok ? '' : ' — ' + c.detail);
        wrap.appendChild(div);
      });
      el.testResults.appendChild(wrap);
    });

    log(results.failed ? 'error' : 'info',
      'Self-test: ' + results.passed + '/' + results.total + ' assertions passed');
  }

  function init() {
    if (!window.TtsEngine.isSupported()) {
      el.status.textContent = 'This browser has no Web Speech API';
      log('error', 'window.speechSynthesis is unavailable — playback is disabled.');
      el.play.disabled = true;
    }

    var prefs = loadPrefs();
    ssmlCapability = prefs.capability || {};

    // ?sample=<name> overrides the stored draft, so a particular case can be
    // linked to or loaded by a headless browser.
    var wanted = (/[?&]sample=([\w-]+)/.exec(location.search) || [])[1];
    if (wanted && window.Samples[wanted]) {
      el.sample.value = wanted;
      el.input.value = window.Samples[wanted];
    } else {
      el.input.value = prefs.html !== undefined ? prefs.html : window.Samples.assessment;
      if (prefs.sample) el.sample.value = prefs.sample;
    }
    if (prefs.rate) el.rate.value = prefs.rate;
    if (prefs.pitch) el.pitch.value = prefs.pitch;
    if (prefs.volume !== undefined) el.volume.value = prefs.volume;
    if (prefs.mode) {
      var radio = document.querySelector('input[name="mode"][value="' + prefs.mode + '"]');
      if (radio) radio.checked = true;
    }
    if (prefs.sentence !== undefined) el.chkSentence.checked = prefs.sentence;
    if (prefs.word !== undefined) el.chkWord.checked = prefs.word;
    if (prefs.follow !== undefined) el.chkFollow.checked = prefs.follow;
    if (prefs.respell !== undefined) el.chkRespell.checked = prefs.respell;
    voiceChoice = prefs.voiceChoice || {};

    highlighter = new window.Highlighter(el.preview, el.overlay);
    el.badgeHl.textContent = 'highlight: ' +
      (highlighter.mode === 'highlight-api' ? 'Highlight API' : 'overlay');

    engine = new window.TtsEngine({
      pitch: parseFloat(el.pitch.value),
      volume: parseFloat(el.volume.value),
      provider: window.TtsProviders.get('webspeech')
    });

    engine.on('unitStart', function (payload) {
      highlightUnit(payload.unit);
      markActiveUnit(payload.unit.index);
      updateTransport();
    });
    engine.on('word', highlightWord);
    engine.on('stateChange', updateTransport);
    engine.on('end', function (payload) {
      highlighter.clear();
      markActiveUnit(-1);
      updateTransport();
      log('info', 'Playback ' + payload.reason);
    });
    engine.on('log', function (payload) { log(payload.level, payload.message); });

    // --- editor ---
    el.input.addEventListener('input', scheduleRender);
    el.format.addEventListener('click', tidySource);
    el.sample.addEventListener('change', function () {
      el.input.value = window.Samples[el.sample.value] || '';
      render();
      savePrefs();
    });

    // --- transport ---
    el.play.addEventListener('click', togglePlayPause);
    el.stop.addEventListener('click', function () { engine.stop(); });
    el.prev.addEventListener('click', function () { engine.skip(-1); });
    el.next.addEventListener('click', function () { engine.skip(1); });
    el.preview.addEventListener('click', startFromPoint);

    el.preview.addEventListener('keydown', function (event) {
      if (event.key === ' ') { event.preventDefault(); togglePlayPause(); }
      else if (event.key === 'Escape') { engine.stop(); }
      else if (event.key === 'ArrowRight' && engine.state !== 'idle') { event.preventDefault(); engine.skip(1); }
      else if (event.key === 'ArrowLeft' && engine.state !== 'idle') { event.preventDefault(); engine.skip(-1); }
    });

    // --- voice & delivery ---
    el.voice.addEventListener('change', function () {
      voiceChoice[provider.id] = el.voice.value;
      updateVoiceNote();
      preparePlayback();
      savePrefs();
    });

    Array.prototype.slice.call(document.querySelectorAll('input[name="mode"]')).forEach(function (radio) {
      radio.addEventListener('change', function () {
        updateModeNote();
        preparePlayback();
        savePrefs();
        log('info', 'Delivery mode: ' + currentMode());
      });
    });

    [['rate', el.outRate], ['pitch', el.outPitch], ['volume', el.outVolume]].forEach(function (pair) {
      var input = el[pair[0]];
      var output = pair[1];
      var sync = function () {
        output.value = parseFloat(input.value).toFixed(2);
      };
      sync();
      input.addEventListener('input', function () {
        sync();
        if (input === el.volume) engine.setVolume(parseFloat(input.value));
        preparePlayback();
      });
      input.addEventListener('change', savePrefs);
    });

    [el.chkSentence, el.chkWord, el.chkFollow].forEach(function (box) {
      box.addEventListener('change', function () {
        if (!el.chkSentence.checked) highlighter.setSentence(null);
        if (!el.chkWord.checked) highlighter.clearWord();
        // Whether to ask the service for timing marks is a prepare()-time choice.
        if (box === el.chkWord) preparePlayback();
        savePrefs();
      });
    });

    el.chkRespell.addEventListener('change', function () {
      preparePlayback();
      savePrefs();
    });

    // --- probe ---
    el.probe.addEventListener('click', runProbe);
    el.probeYes.addEventListener('click', function () { recordCapability('yes'); });
    el.probeNo.addEventListener('click', function () { recordCapability('no'); });
    el.probeTags.addEventListener('click', function () { recordCapability('tags'); });

    // --- inspector ---
    Array.prototype.slice.call(document.querySelectorAll('.tab')).forEach(function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.dataset.tab); });
    });
    el.clearLog.addEventListener('click', function () { el.log.textContent = ''; });

    // --- dialogs ---
    el.btnHelp.addEventListener('click', function () { el.help.showModal(); });
    el.btnSelftest.addEventListener('click', runSelfTest);
    Array.prototype.slice.call(document.querySelectorAll('[data-close]')).forEach(function (btn) {
      btn.addEventListener('click', function () { btn.closest('dialog').close(); });
    });

    // --- providers -------------------------------------------------
    populateProviders();
    restoreCredentials();

    el.provider.addEventListener('change', function () {
      setProvider(el.provider.value, { promptForCredentials: true });
      savePrefs();
    });
    el.btnCreds.addEventListener('click', function () { openCredentials(provider); });
    el.btnCredsSave.addEventListener('click', saveCredentials);
    el.btnCredsTest.addEventListener('click', testCredentials);
    el.btnCredsForget.addEventListener('click', forgetCredentials);

    // The browser repopulates its voice list asynchronously.
    if (typeof window.speechSynthesis !== 'undefined') {
      window.speechSynthesis.addEventListener('voiceschanged', function () {
        if (provider && provider.kind === 'webspeech') loadVoices();
      });
    }

    // ?provider=<id> selects a service on load, opening the credentials
    // dialog when it has none yet.
    var requestedProvider = (/[?&]provider=(\w+)/.exec(location.search) || [])[1];
    var startProvider = requestedProvider || prefs.providerId || 'webspeech';
    var startCandidate = window.TtsProviders.get(startProvider);
    if (!startCandidate) startProvider = 'webspeech';
    else if (!startCandidate.isConfigured() && !requestedProvider) startProvider = 'webspeech';

    setProvider(startProvider, {
      preferSsmlMode: !!requestedProvider,
      promptForCredentials: !!requestedProvider
    });

    currentView = prefs.view || 'reader';
    initViewSwitch();

    updateModeNote();
    render();

    // Cancel any in-flight speech when the page goes away; some platforms keep
    // speaking after navigation otherwise.
    window.addEventListener('beforeunload', function () {
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    });

    // The header chip is the single source for the version, so the log line
    // cannot drift from what the page displays.
    var versionLabel = ($('app-version') || {}).textContent || '';
    log('info', 'data-ssml Read Aloud Tool ' + versionLabel.replace(/^Version\s*/i, '') +
      ' · ' + (($('app-contact') || {}).textContent || ''));
    log('info', 'Ready. Highlighting: ' + highlighter.mode +
      '. Intl.Segmenter: ' + (typeof Intl !== 'undefined' && Intl.Segmenter ? 'yes' : 'no (regex fallback)'));

    // ?selftest — run the suite on load, including the DOM-only segmenter
    // group, so a headless browser can report results without interaction.
    if (/[?&]selftest\b/.test(location.search)) runSelfTest();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
