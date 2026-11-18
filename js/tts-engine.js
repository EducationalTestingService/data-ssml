/*
 * tts-engine.js
 * =============
 * Read-aloud playback over the Web Speech API, driven by the unit list from
 * segmenter.js and the directive handling in data-ssml-to-ssml.js /
 * ssml-emulate.js.
 *
 * Delivery modes
 * --------------
 *   'emulate' — directives are realized client-side (see ssml-emulate.js) and
 *               plain text is sent to the synthesizer. Works everywhere; keeps
 *               word-boundary highlighting.
 *   'ssml'    — the SSML 1.1 document is handed to the synthesizer verbatim.
 *               Correct for engines that accept SSML; on engines that do not,
 *               markup is stripped or read aloud, which is exactly what a
 *               conformance test wants to reveal. Word highlighting is
 *               suppressed because boundary offsets refer to the markup.
 *   'plain'   — only `sub` is applied (the AT fallback path of the reference
 *               Python library's apply_text_only).
 *
 * The queue is a flat list of steps so a break can be a first-class item:
 *   {kind: 'speak', unitIndex, text, rate, pieces, pieceOffsets, isSsml, markTable}
 *   {kind: 'silence', unitIndex, ms}
 *
 * Two backends execute a 'speak' step:
 *
 *   provider.kind === 'webspeech'  the string is handed to SpeechSynthesis and
 *                                  word highlighting comes from boundary events.
 *   provider.kind === 'audio'      the step is synthesized over the network and
 *                                  the returned clip is played, with word
 *                                  highlighting driven by the timing marks the
 *                                  service reports for the <mark> elements in
 *                                  the SSML (see composeSsmlWithMarks).
 *
 * Both paths emit the same normalized `word` event, carrying a unit-relative
 * source range rather than an offset into whatever string was actually sent.
 */
(function (root) {
  'use strict';

  // Resolved per call so the self-test can substitute a synthesizer and drive
  // the transport without audio.
  function getSynth() {
    return TtsEngine.synth || window.speechSynthesis;
  }

  function TtsEngine(options) {
    this.options = options || {};
    this.state = 'idle';           // idle | speaking | paused
    this.queue = [];
    this.stepIndex = 0;
    this.units = [];
    this.currentUnitIndex = -1;
    this.utterance = null;
    this.silenceTimer = null;
    this.silenceRemaining = 0;
    this.silenceStartedAt = 0;
    this.generation = 0;           // guards callbacks from cancelled runs

    this.provider = (this.options.provider) || root.TtsProviders.get('webspeech');
    var PlayerClass = TtsEngine.PlayerClass || root.AudioPlayer;
    this.player = PlayerClass ? new PlayerClass() : null;
    this.audioCache = new Map();
    this.synthesizing = false;

    this.handlers = {
      unitStart: [],
      word: [],
      end: [],
      stateChange: [],
      log: []
    };
  }

  /** Swap the speech backend. Clears any cached audio from the previous one. */
  TtsEngine.prototype.setProvider = function (provider) {
    if (this.provider === provider) return;
    this.cancel(true);
    this.provider = provider;
    this.audioCache.clear();
    this._setState('idle');
  };

  TtsEngine.prototype.isAudioBackend = function () {
    return !!(this.provider && this.provider.kind === 'audio');
  };

  TtsEngine.prototype.on = function (event, fn) {
    if (this.handlers[event]) this.handlers[event].push(fn);
    return this;
  };

  TtsEngine.prototype._emit = function (event, payload) {
    (this.handlers[event] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* a listener must not break playback */ }
    });
  };

  TtsEngine.prototype._setState = function (state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('stateChange', state);
  };

  // =====================================================================
  // Queue construction
  // =====================================================================

  /**
   * Build the playback queue from units.
   *
   * @param {Array} units    From Segmenter.build().
   * @param {Object} config  {mode, rate, phonemeRespelling, lang}
   * @returns {Array} the queue, also stored on the engine
   */
  TtsEngine.prototype.prepare = function (units, config) {
    config = config || {};
    var mode = config.mode || 'emulate';
    var baseRate = config.rate === undefined ? 1 : config.rate;
    var queue = [];
    var self = this;

    this.units = units;
    this.plan = [];

    units.forEach(function (unit) {
      var scopes = unit.scopes || [];
      var hasDirectives = scopes.some(function (s) {
        return s.parsed && Object.keys(s.parsed).length;
      });
      var entry = { unit: unit, mode: mode, steps: [], notes: [], ssml: null, spoken: '' };

      // A partially-capable service (ElevenLabs takes <break> and <phoneme> but
      // has no sub, say-as, or prosody) is driven through the emulation layer
      // with those two tags passed through, so the engine handles what it can
      // and the rest is still realized here.
      var subset = self.isAudioBackend() ? self.provider.supports.ssmlSubset : null;

      // A service that speaks full SSML gets SSML for every sentence, even
      // undecorated ones — that keeps one delivery path and lets the timing
      // marks cover the whole passage. The browser backend only gets markup
      // where there is something to test, since it will just read the tags.
      if (mode === 'ssml' && !subset && (hasDirectives || self.isAudioBackend())) {
        // Instrument the markup with <mark> elements when the backend can
        // report the time it reaches each one; that is what makes word
        // highlighting possible with a real SSML engine.
        var wantMarks = !!(config.wordMarks && self.isAudioBackend() &&
          self.provider.supports.wordMarks);
        var lang = unit.lang || config.lang || 'en';
        var ssml;
        var markTable = null;

        if (wantMarks) {
          var composed = root.DataSsmlToSsml.composeSsmlWithMarks(unit.text, scopes, lang);
          ssml = composed.ssml;
          markTable = composed.marks;
        } else {
          ssml = root.DataSsmlToSsml.composeSsml(unit.text, scopes, lang);
        }

        entry.ssml = ssml;
        entry.spoken = ssml;
        entry.notes.push(self.isAudioBackend()
          ? 'SSML sent to ' + self.provider.name + ' for native handling'
          : 'SSML sent verbatim to the synthesizer');
        var step = {
          kind: 'speak',
          unitIndex: unit.index,
          text: ssml,
          rate: baseRate,
          pieces: null,
          pieceOffsets: null,
          isSsml: true,
          markTable: markTable,
          lang: lang
        };
        entry.steps.push(step);
        queue.push(step);

      } else {
        // 'plain' keeps only `sub`, matching the reference library's
        // apply_text_only() fallback for AT without SSML support.
        var activeScopes = mode === 'plain'
          ? scopes.filter(function (s) { return s.parsed && s.parsed.sub; })
              .map(function (s) {
                return Object.assign({}, s, { parsed: { sub: s.parsed.sub } });
              })
          : scopes;

        var hybrid = mode === 'ssml' && !!subset;

        var result = root.SsmlEmulate.emulate(unit.text, activeScopes, {
          phonemeRespelling: !!config.phonemeRespelling,
          nativeTags: hybrid ? subset : null
        });
        entry.notes = result.notes;
        entry.spoken = result.spoken;

        if (mode === 'plain' && hasDirectives) {
          entry.notes.push('plain-text mode: break, prosody, say-as, and phoneme are dropped');
        }
        if (hybrid) {
          var native = Object.keys(subset).filter(function (key) {
            return subset[key] === true;
          });
          entry.notes.push(self.provider.name + ' handles ' + native.join(' and ') +
            ' natively; the remaining directives are emulated before sending');
        }
        if (hasDirectives) {
          entry.ssml = root.DataSsmlToSsml.composeSsml(unit.text, scopes, unit.lang || config.lang || 'en');
        }

        // Group consecutive speech pieces sharing a rate into one utterance;
        // a silence or a rate change starts a new one.
        var group = null;
        var flush = function () {
          if (!group) return;
          var step = {
            kind: 'speak',
            unitIndex: unit.index,
            text: group.pieces.map(function (p) { return p.spoken; }).join(''),
            rate: baseRate * group.rate,
            pieces: group.pieces,
            pieceOffsets: group.offsets,
            isSsml: false,
            markTable: null,
            lang: unit.lang || config.lang || 'en'
          };
          entry.steps.push(step);
          queue.push(step);
          group = null;
        };

        result.pieces.forEach(function (piece) {
          if (piece.kind === 'silence') {
            flush();
            var sstep = { kind: 'silence', unitIndex: unit.index, ms: piece.ms };
            entry.steps.push(sstep);
            queue.push(sstep);
            return;
          }
          if (group && Math.abs(group.rate - piece.rate) > 1e-9) flush();
          if (!group) group = { rate: piece.rate, pieces: [], offsets: [] };
          group.offsets.push(group.pieces.reduce(function (acc, p) {
            return acc + p.spoken.length;
          }, 0));
          group.pieces.push(piece);
        });
        flush();
      }

      self.plan.push(entry);
    });

    this.queue = queue;
    this.stepIndex = 0;
    return queue;
  };

  // =====================================================================
  // Transport
  // =====================================================================

  /** Start (or restart) playback, optionally from a given unit index. */
  TtsEngine.prototype.play = function (fromUnitIndex) {
    if (!this.queue.length) return;

    if (this.state === 'paused' && fromUnitIndex === undefined) {
      this.resume();
      return;
    }

    this.cancel(true);
    this.generation += 1;

    if (fromUnitIndex !== undefined && fromUnitIndex !== null) {
      var idx = this.queue.findIndex(function (step) { return step.unitIndex === fromUnitIndex; });
      this.stepIndex = idx === -1 ? 0 : idx;
    } else {
      this.stepIndex = 0;
    }

    this.currentUnitIndex = -1;
    this._setState('speaking');
    this._runStep();
  };

  TtsEngine.prototype.pause = function () {
    if (this.state !== 'speaking') return;

    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      var elapsed = Date.now() - this.silenceStartedAt;
      this.silenceRemaining = Math.max(0, this.silenceRemaining - elapsed);
    } else if (this.isAudioBackend()) {
      // A request may still be in flight; _runAudioStep re-checks the state
      // when it resolves and pauses the clip before it is heard.
      if (this.player) this.player.pause();
    } else {
      try { getSynth().pause(); } catch (e) { /* ignore */ }
    }
    this._setState('paused');
  };

  TtsEngine.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this._setState('speaking');

    if (this.silenceRemaining > 0) {
      this._startSilence(this.silenceRemaining, this.generation);
    } else if (this.isAudioBackend()) {
      if (this.player) this.player.resume();
    } else {
      try { getSynth().resume(); } catch (e) { /* ignore */ }
      // Some engines drop a paused utterance instead of resuming it. If nothing
      // is speaking shortly after resume, re-issue the current step.
      var self = this;
      var gen = this.generation;
      setTimeout(function () {
        if (self.generation !== gen || self.state !== 'speaking') return;
        var sy = getSynth();
        if (!sy.speaking && !sy.pending) self._runStep();
      }, 250);
    }
  };

  TtsEngine.prototype.stop = function () {
    this.cancel(false);
    this.stepIndex = 0;
    this.currentUnitIndex = -1;
    this._setState('idle');
    this._emit('end', { reason: 'stopped' });
  };

  TtsEngine.prototype.cancel = function (silent) {
    this.generation += 1;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.silenceRemaining = 0;
    if (this.utterance) {
      this.utterance.onend = null;
      this.utterance.onerror = null;
      this.utterance.onboundary = null;
      this.utterance = null;
    }
    this.synthesizing = false;
    if (this.player) this.player.stop();
    try { getSynth().cancel(); } catch (e) { /* ignore */ }
    if (!silent) this._setState('idle');
  };

  /** Apply a live volume change to whatever is currently sounding. */
  TtsEngine.prototype.setVolume = function (volume) {
    this.options.volume = volume;
    if (this.player) this.player.setVolume(volume);
  };

  /** Skip to the next / previous unit while playing. */
  TtsEngine.prototype.skip = function (delta) {
    if (!this.units.length) return;
    var target = Math.max(0, Math.min(this.units.length - 1, this.currentUnitIndex + delta));
    this.play(target);
  };

  // =====================================================================
  // Step execution
  // =====================================================================

  TtsEngine.prototype._runStep = function () {
    var self = this;

    if (this.stepIndex >= this.queue.length) {
      this._setState('idle');
      this.currentUnitIndex = -1;
      this._emit('end', { reason: 'complete' });
      return;
    }

    var step = this.queue[this.stepIndex];
    var gen = this.generation;

    if (step.unitIndex !== this.currentUnitIndex) {
      this.currentUnitIndex = step.unitIndex;
      this._emit('unitStart', {
        unit: this.units[step.unitIndex],
        plan: this.plan[step.unitIndex]
      });
    }

    if (step.kind === 'silence') {
      this.silenceRemaining = step.ms;
      this._startSilence(step.ms, gen);
      return;
    }

    if (this.isAudioBackend()) this._runAudioStep(step, gen);
    else this._runUtteranceStep(step, gen);
  };

  /** Advance past the step that just finished. */
  TtsEngine.prototype._advance = function (gen) {
    if (this.generation !== gen) return;
    this.stepIndex += 1;
    this._runStep();
  };

  // ------------------------------ Web Speech --------------------------

  TtsEngine.prototype._runUtteranceStep = function (step, gen) {
    var self = this;

    var Utterance = TtsEngine.Utterance || window.SpeechSynthesisUtterance;
    var utt = new Utterance(step.text);

    // Voices arrive as provider descriptors; the Web Speech path needs the
    // underlying SpeechSynthesisVoice held on `raw`.
    var voice = this.options.voice;
    var native = voice && (voice.raw || voice);
    if (native && native.voiceURI) utt.voice = native;
    if (native && native.lang) utt.lang = native.lang;
    else if (this.options.lang) utt.lang = this.options.lang;

    // Web Speech clamps rate to [0.1, 10].
    utt.rate = Math.max(0.1, Math.min(10, step.rate));
    utt.pitch = this.options.pitch === undefined ? 1 : this.options.pitch;
    utt.volume = this.options.volume === undefined ? 1 : this.options.volume;

    utt.onboundary = function (event) {
      if (self.generation !== gen) return;
      if (step.isSsml) return;                 // offsets refer to markup
      if (event.name && event.name !== 'word') return;
      var mapped = self.mapBoundary(step, event.charIndex, event.charLength);
      if (!mapped) return;
      self._emit('word', {
        unitIndex: step.unitIndex,
        start: mapped.start,
        end: mapped.end,
        exact: mapped.exact
      });
    };

    utt.onend = function () { self._advance(gen); };

    utt.onerror = function (event) {
      if (self.generation !== gen) return;
      // 'interrupted' and 'canceled' are the normal result of stop()/skip().
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        self._emit('log', {
          level: 'error',
          message: 'Speech error (' + (event.error || 'unknown') + ') on: ' +
            step.text.slice(0, 60)
        });
      }
      self.utterance = null;
      self._advance(gen);
    };

    this.utterance = utt;
    this._emit('log', {
      level: 'debug',
      message: (step.isSsml ? 'SSML \u2192 ' : 'speak \u2192 ') + step.text
    });

    try {
      getSynth().speak(utt);
    } catch (e) {
      this._emit('log', { level: 'error', message: 'speak() threw: ' + e.message });
      this._advance(gen);
    }
  };

  // ------------------------------ Cloud audio -------------------------

  /** Whether this step should ask the provider for timing data. */
  TtsEngine.prototype._wantsMarksFor = function (step) {
    if (!this.isAudioBackend() || !this.provider.supports.wordMarks) return false;
    // Mark-name timing needs the instrumented SSML; alignment timing works off
    // whatever string was sent, so it also covers the emulated and hybrid paths.
    return !!step.markTable ||
      !!(this.provider.supports.markAlignment && step.pieces);
  };

  TtsEngine.prototype._cacheKey = function (step) {
    var voice = this.options.voice;
    return [
      this.provider.id,
      (voice && voice.id) || '',
      this.options.pitch === undefined ? 1 : this.options.pitch,
      this._wantsMarksFor(step) ? 'marks' : 'plain',
      step.isSsml ? 'ssml' : 'text',
      step.text
    ].join('\u0000');
  };

  /** Synthesize a step, reusing a cached clip when one exists. */
  TtsEngine.prototype._fetchAudio = function (step) {
    var key = this._cacheKey(step);
    var cached = this.audioCache.get(key);
    if (cached) return Promise.resolve(cached);

    var self = this;
    var voice = this.options.voice;

    return this.provider.synthesize({
      ssml: step.isSsml ? step.text : null,
      text: step.isSsml ? null : step.text,
      voice: voice,
      lang: (voice && voice.lang) || step.lang || 'en',
      wantMarks: this._wantsMarksFor(step),
      pitch: this.options.pitch === undefined ? 1 : this.options.pitch
    }).then(function (result) {
      // Keep the cache small; these are audio buffers.
      if (self.audioCache.size > 60) {
        self.audioCache.delete(self.audioCache.keys().next().value);
      }
      self.audioCache.set(key, result);
      return result;
    });
  };

  /** Warm the cache for the next speak step so playback does not stall. */
  TtsEngine.prototype._prefetchNext = function () {
    for (var i = this.stepIndex + 1; i < this.queue.length; i++) {
      if (this.queue[i].kind !== 'speak') continue;
      this._fetchAudio(this.queue[i]).catch(function () { /* reported when played */ });
      return;
    }
  };

  TtsEngine.prototype._runAudioStep = function (step, gen) {
    var self = this;

    this._emit('log', {
      level: 'debug',
      message: (step.isSsml ? 'SSML \u2192 ' : 'text \u2192 ') + this.provider.name +
        ': ' + step.text
    });

    this.synthesizing = true;
    this._emit('stateChange', this.state);

    this._fetchAudio(step).then(function (result) {
      self.synthesizing = false;
      if (self.generation !== gen) return;
      if (self.state === 'idle') return;

      (result.warnings || []).forEach(function (warning) {
        self._emit('log', { level: 'warn', message: warning });
      });

      var marks = self._resolveMarks(step, result.marks);

      self.player.play(result.blob, {
        marks: marks,
        playbackRate: step.rate,
        volume: self.options.volume === undefined ? 1 : self.options.volume,
        onMark: function (mark) {
          if (self.generation !== gen) return;
          self._emit('word', {
            unitIndex: step.unitIndex,
            start: mark.srcStart,
            end: mark.srcEnd,
            exact: false
          });
        },
        onEnd: function () { self._advance(gen); },
        onError: function (err) {
          if (self.generation !== gen) return;
          self._emit('log', { level: 'error', message: err.message });
          self._advance(gen);
        }
      });

      // If the transport was paused while the request was in flight, honour it.
      if (self.state === 'paused') self.player.pause();

      self._prefetchNext();
      self._emit('stateChange', self.state);

    }).catch(function (err) {
      self.synthesizing = false;
      if (self.generation !== gen) return;
      self._emit('log', {
        level: 'error',
        message: err.message + (err.hint ? ' \u2014 ' + err.hint : '')
      });
      // A failing provider would otherwise spew one error per sentence.
      self._setState('idle');
      self.currentUnitIndex = -1;
      self._emit('end', { reason: 'error', error: err });
    });
  };

  /**
   * Attach source ranges to the timing marks the provider reported.
   *
   * Two flavours arrive here. Services that time `<mark>` elements report a
   * mark name, resolved through the table composeSsmlWithMarks built. Services
   * that report character alignment (ElevenLabs) give offsets into the string
   * that was sent, resolved through the piece list — the same mapping a Web
   * Speech boundary event uses.
   */
  TtsEngine.prototype._resolveMarks = function (step, providerMarks) {
    if (!providerMarks || !providerMarks.length) return [];
    var self = this;

    if (step.markTable) {
      var byName = {};
      step.markTable.forEach(function (entry) { byName[entry.name] = entry; });

      return providerMarks.map(function (mark) {
        var entry = byName[mark.name];
        if (!entry) return null;
        return { timeMs: mark.timeMs, srcStart: entry.srcStart, srcEnd: entry.srcEnd };
      }).filter(Boolean);
    }

    if (!step.pieces) return [];

    return providerMarks.map(function (mark) {
      if (mark.outStart === undefined || mark.outStart === null) return null;
      var mapped = self.mapBoundary(step, mark.outStart, mark.outLen || 0);
      if (!mapped || mapped.end <= mapped.start) return null;
      return { timeMs: mark.timeMs, srcStart: mapped.start, srcEnd: mapped.end };
    }).filter(Boolean);
  };

  TtsEngine.prototype._startSilence = function (ms, gen) {
    var self = this;
    this.silenceStartedAt = Date.now();
    this._emit('log', { level: 'debug', message: 'silence ' + ms + 'ms' });
    this.silenceTimer = setTimeout(function () {
      if (self.generation !== gen) return;
      self.silenceTimer = null;
      self.silenceRemaining = 0;
      self.stepIndex += 1;
      self._runStep();
    }, ms);
  };

  // =====================================================================
  // Boundary offset -> source offset
  // =====================================================================

  /**
   * Map a boundary event inside a step back to the unit's source text range.
   * Returns {start, end, exact} in unit-relative offsets, or null.
   */
  TtsEngine.prototype.mapBoundary = function (step, charIndex, charLength) {
    if (!step.pieces || !step.pieceOffsets) return null;

    for (var i = step.pieces.length - 1; i >= 0; i--) {
      var piece = step.pieces[i];
      var offset = step.pieceOffsets[i];
      if (charIndex < offset) continue;

      if (piece.exact) {
        var delta = charIndex - offset;
        var start = piece.srcStart + delta;
        var len = charLength || 0;
        return { start: start, end: start + len, exact: true };
      }
      return { start: piece.srcStart, end: piece.srcEnd, exact: false };
    }
    return null;
  };

  root.TtsEngine = TtsEngine;
  root.TtsEngine.isSupported = function () {
    return typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined';
  };
})(window);
