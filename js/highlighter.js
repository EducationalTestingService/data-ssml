/*
 * highlighter.js
 * ==============
 * Sentence and word highlighting that never mutates the rendered DOM.
 *
 * The rendered preview is the user's own HTML — wrapping spans around the
 * spoken text would change the tree the reader is inspecting and would break
 * the flat-text offsets the segmenter produced. Two non-destructive strategies
 * are used instead:
 *
 *   1. CSS Custom Highlight API (CSS.highlights) where supported. Ranges are
 *      registered and styled via ::highlight() pseudo-elements.
 *   2. Positioned overlay rectangles derived from Range.getClientRects(),
 *      as a fallback for engines without the Highlight API.
 *
 * Both paths expose the same interface, so the caller does not branch.
 */
(function (root) {
  'use strict';

  var SUPPORTS_HIGHLIGHT_API =
    typeof CSS !== 'undefined' &&
    CSS.highlights &&
    typeof Highlight === 'function';

  function Highlighter(container, overlay) {
    this.container = container;
    this.overlay = overlay;
    this.mode = SUPPORTS_HIGHLIGHT_API ? 'highlight-api' : 'overlay';
    this.current = { sentence: null, word: null };

    if (this.mode === 'highlight-api') {
      this.sentenceHighlight = new Highlight();
      this.wordHighlight = new Highlight();
      CSS.highlights.set('ra-sentence', this.sentenceHighlight);
      CSS.highlights.set('ra-word', this.wordHighlight);
    }

    this._onReflow = this._onReflow.bind(this);
    window.addEventListener('resize', this._onReflow);
    container.addEventListener('scroll', this._onReflow);
  }

  Highlighter.prototype.setSentence = function (range) {
    this.current.sentence = range;
    this._apply();
  };

  Highlighter.prototype.setWord = function (range) {
    this.current.word = range;
    this._apply();
  };

  Highlighter.prototype.clear = function () {
    this.current.sentence = null;
    this.current.word = null;
    this._apply();
  };

  Highlighter.prototype.clearWord = function () {
    this.current.word = null;
    this._apply();
  };

  /**
   * Redraw at the current geometry. Needed after the panel changes size or
   * becomes visible again — a hidden element has no boxes to measure, so the
   * overlay strategy has nothing to position against until it is back.
   */
  Highlighter.prototype.refresh = function () {
    this._apply();
  };

  Highlighter.prototype.destroy = function () {
    window.removeEventListener('resize', this._onReflow);
    this.container.removeEventListener('scroll', this._onReflow);
    if (this.mode === 'highlight-api') {
      CSS.highlights.delete('ra-sentence');
      CSS.highlights.delete('ra-word');
    }
    if (this.overlay) this.overlay.textContent = '';
  };

  Highlighter.prototype._onReflow = function () {
    if (this.mode === 'overlay') this._paintOverlay();
  };

  Highlighter.prototype._apply = function () {
    if (this.mode === 'highlight-api') {
      this.sentenceHighlight.clear();
      this.wordHighlight.clear();
      if (this.current.sentence) this.sentenceHighlight.add(this.current.sentence);
      if (this.current.word) this.wordHighlight.add(this.current.word);
    } else {
      this._paintOverlay();
    }
  };

  Highlighter.prototype._paintOverlay = function () {
    if (!this.overlay) return;
    this.overlay.textContent = '';

    var base = this.container.getBoundingClientRect();
    var scrollTop = this.container.scrollTop;
    var scrollLeft = this.container.scrollLeft;
    var overlay = this.overlay;

    var paint = function (range, className) {
      if (!range) return;
      var rects = range.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width === 0 && r.height === 0) continue;
        var div = document.createElement('div');
        div.className = 'hl ' + className;
        div.style.left = (r.left - base.left + scrollLeft) + 'px';
        div.style.top = (r.top - base.top + scrollTop) + 'px';
        div.style.width = r.width + 'px';
        div.style.height = r.height + 'px';
        overlay.appendChild(div);
      }
    };

    paint(this.current.sentence, 'hl-sentence');
    paint(this.current.word, 'hl-word');
  };

  /** Scroll a range into view inside the container without jumping the page. */
  Highlighter.prototype.scrollIntoView = function (range) {
    if (!range) return;
    var rects = range.getClientRects();
    if (!rects.length) return;

    var r = rects[0];
    var base = this.container.getBoundingClientRect();
    var margin = 40;

    if (r.top < base.top + margin) {
      this.container.scrollTop -= (base.top + margin - r.top);
    } else if (r.bottom > base.bottom - margin) {
      this.container.scrollTop += (r.bottom - (base.bottom - margin));
    }
  };

  root.Highlighter = Highlighter;
  root.Highlighter.SUPPORTS_HIGHLIGHT_API = SUPPORTS_HIGHLIGHT_API;
})(window);
