/*
 * audio-player.js
 * ===============
 * Playback of synthesized audio clips returned by a cloud TTS provider.
 *
 * Cloud engines return a finished audio buffer rather than firing events as
 * they speak, so word highlighting is driven from timing marks the service
 * reports alongside the audio (Polly speech marks, Google timepoints). Marks
 * are dispatched from a requestAnimationFrame loop reading `currentTime`,
 * which tracks far more closely than the `timeupdate` event's ~250 ms cadence.
 *
 * Mark times are media times, so they need no adjustment when playbackRate is
 * changed.
 */
(function (root) {
  'use strict';

  function AudioPlayer() {
    this.audio = null;
    this.url = null;
    this.marks = [];
    this.markIndex = 0;
    this.rafId = 0;
    this.onMark = null;
    this.onEnd = null;
    this.onError = null;
    this._tick = this._tick.bind(this);
  }

  /**
   * Play a clip.
   *
   * @param {Blob} blob
   * @param {Object} options
   *        {marks: [{timeMs, name}], playbackRate, volume, onMark, onEnd, onError}
   */
  AudioPlayer.prototype.play = function (blob, options) {
    options = options || {};
    this.stop();

    this.marks = (options.marks || []).slice().sort(function (a, b) {
      return a.timeMs - b.timeMs;
    });
    this.markIndex = 0;
    this.onMark = options.onMark || null;
    this.onEnd = options.onEnd || null;
    this.onError = options.onError || null;

    this.url = URL.createObjectURL(blob);
    var audio = new Audio();
    this.audio = audio;

    audio.src = this.url;
    audio.playbackRate = Math.max(0.25, Math.min(4, options.playbackRate || 1));
    if (audio.preservesPitch !== undefined) audio.preservesPitch = true;
    audio.volume = options.volume === undefined ? 1 : options.volume;

    var self = this;

    audio.onended = function () {
      // Any marks past the last dispatched position still belong to this clip.
      self._flushRemaining();
      self._cancelTick();
      var done = self.onEnd;
      self.onEnd = null;
      if (done) done();
    };

    audio.onerror = function () {
      self._cancelTick();
      var fail = self.onError;
      self.onError = null;
      if (fail) {
        fail(new Error('Audio playback failed (' +
          ((audio.error && audio.error.message) || 'decode error') + ')'));
      }
    };

    var started = audio.play();
    if (started && started.catch) {
      started.catch(function (err) {
        // Autoplay policy blocks playback until the page has been interacted
        // with; the transport button counts, so this is rare in practice.
        var fail = self.onError;
        self.onError = null;
        if (fail) fail(err);
      });
    }

    this._scheduleTick();
  };

  AudioPlayer.prototype.pause = function () {
    if (this.audio) this.audio.pause();
    this._cancelTick();
  };

  AudioPlayer.prototype.resume = function () {
    if (!this.audio) return;
    this.audio.play();
    this._scheduleTick();
  };

  AudioPlayer.prototype.stop = function () {
    this._cancelTick();
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      try { this.audio.pause(); } catch (e) { /* ignore */ }
      this.audio.src = '';
      this.audio = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.onMark = null;
    this.onEnd = null;
    this.onError = null;
    this.marks = [];
    this.markIndex = 0;
  };

  AudioPlayer.prototype.isPlaying = function () {
    return !!(this.audio && !this.audio.paused && !this.audio.ended);
  };

  AudioPlayer.prototype.setVolume = function (volume) {
    if (this.audio) this.audio.volume = volume;
  };

  AudioPlayer.prototype.setPlaybackRate = function (rate) {
    if (this.audio) this.audio.playbackRate = Math.max(0.25, Math.min(4, rate));
  };

  AudioPlayer.prototype._scheduleTick = function () {
    this._cancelTick();
    this.rafId = requestAnimationFrame(this._tick);
  };

  AudioPlayer.prototype._cancelTick = function () {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  };

  AudioPlayer.prototype._tick = function () {
    this.rafId = 0;
    if (!this.audio) return;

    var nowMs = this.audio.currentTime * 1000;
    while (this.markIndex < this.marks.length &&
           this.marks[this.markIndex].timeMs <= nowMs) {
      var mark = this.marks[this.markIndex++];
      if (this.onMark) this.onMark(mark);
    }

    if (!this.audio.paused && !this.audio.ended) this._scheduleTick();
  };

  AudioPlayer.prototype._flushRemaining = function () {
    while (this.markIndex < this.marks.length) {
      var mark = this.marks[this.markIndex++];
      if (this.onMark) this.onMark(mark);
    }
  };

  root.AudioPlayer = AudioPlayer;
})(window);
