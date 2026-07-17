// voiceTrigger.js
// Hands-free keyword trigger via the Web Speech API. When the configured word is
// heard, fire a callback (wired to the incident trigger in main.js).
//
// PoC-grade, honest limits (surfaced in the UI):
//   - Web Speech API only. On iOS Safari, recognition routes audio to Apple's
//     servers (not on-device) and needs a separate Speech Recognition permission.
//   - Recognition stops on silence; we auto-restart while active.
//   - It shares the mic with the recording — on some browsers that can conflict.
// Native would use on-device wake-word spotting (iOS Speech / Android, Porcupine…).

import { CONFIG } from './config.js';

export class VoiceTrigger {
  constructor() {
    this.rec = null;
    this.active = false;
    this.word = CONFIG.voice.defaultWord;
    this.onTrigger = () => {};
    this.onStatus = () => {};
    this._lastFireMs = -Infinity;
    this._restartTimer = null;
  }

  static isSupported() {
    return typeof window !== 'undefined' &&
      !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /**
   * @param {string} word keyword to listen for
   * @param {Object} handlers { onTrigger, onStatus }
   */
  start(word, { onTrigger, onStatus } = {}) {
    if (!VoiceTrigger.isSupported()) {
      (onStatus || this.onStatus)('unsupported');
      return false;
    }
    this.word = (word || CONFIG.voice.defaultWord).trim().toLowerCase();
    this.onTrigger = onTrigger || this.onTrigger;
    this.onStatus = onStatus || this.onStatus;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = CONFIG.voice.lang;

    rec.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript + ' ';
      }
      if (text.toLowerCase().includes(this.word)) this._fire();
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; report the meaningful ones.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.onStatus('denied');
        this.active = false;
      } else if (e.error === 'audio-capture') {
        this.onStatus('no-mic');
      }
    };
    rec.onend = () => {
      // Recognition ends on silence; restart while still active.
      if (this.active) {
        clearTimeout(this._restartTimer);
        this._restartTimer = setTimeout(() => { try { rec.start(); } catch (_e) {} }, 250);
      }
    };

    this.rec = rec;
    this.active = true;
    try {
      rec.start();
      this.onStatus(`listening "${this.word}"`);
      return true;
    } catch (_e) {
      this.onStatus('error');
      return false;
    }
  }

  _fire() {
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (now - this._lastFireMs < CONFIG.voice.retriggerMs) return;
    this._lastFireMs = now;
    this.onStatus(`heard "${this.word}" ✓`);
    this.onTrigger();
  }

  stop() {
    this.active = false;
    clearTimeout(this._restartTimer);
    if (this.rec) {
      try { this.rec.onend = null; this.rec.stop(); } catch (_e) {}
      this.rec = null;
    }
  }
}
