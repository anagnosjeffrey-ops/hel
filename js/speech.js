/* Speech, sound cues and haptics.
 *
 * The counting loop is time-critical: if the app is still saying "eighty-five
 * dollars" when the next bill goes past, the user hears the wrong thing at the
 * wrong moment. So every utterance carries a priority, and a denomination
 * always cuts off chatter that is already in progress.
 */
window.Voice = (function () {
  var PRI = { chatter: 0, status: 1, bill: 2, alert: 3 };
  var synth = window.speechSynthesis || null;
  var voices = [];
  var current = null;        // priority of the utterance being spoken
  var ctx = null;            // lazily created AudioContext (needs a user gesture)
  var cfg = { rate: 1.4, voiceURI: '', output: 'tts', earcons: true, haptics: true };

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices() || [];
  }
  if (synth) {
    loadVoices();
    synth.addEventListener('voiceschanged', function () {
      loadVoices();
      document.dispatchEvent(new CustomEvent('voiceschanged'));
    });
  }

  function pickVoice() {
    if (!voices.length) return null;
    if (cfg.voiceURI) {
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].voiceURI === cfg.voiceURI) return voices[i];
      }
    }
    for (var j = 0; j < voices.length; j++) {
      if (voices[j].default && /^en/i.test(voices[j].lang)) return voices[j];
    }
    for (var k = 0; k < voices.length; k++) {
      if (/^en/i.test(voices[k].lang)) return voices[k];
    }
    return voices[0];
  }

  /* iOS and Chrome will not start audio or speech until the page has seen a
     real gesture. Called from the first tap on Start. */
  function unlock() {
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) { /* audio cues are optional */ }
    if (synth) {
      // A zero-volume utterance flips Safari's "user has allowed speech" bit.
      try {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
      } catch (e2) { /* ignore */ }
    }
  }

  function announcer() { return document.getElementById('announcer'); }

  /* Route text to the live region so VoiceOver/TalkBack reads it. Toggling the
     text content is what triggers the announcement, so identical consecutive
     messages get a zero-width suffix to force a re-read. */
  var srToggle = false;
  function toSR(text, urgent) {
    var el = announcer();
    if (!el) return;
    el.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
    srToggle = !srToggle;
    el.textContent = text + (srToggle ? '​' : '');
  }

  function say(text, priority) {
    var pri = typeof priority === 'number' ? priority : PRI.status;
    if (cfg.output === 'sr' || cfg.output === 'both') toSR(text, pri >= PRI.bill);
    if (cfg.output === 'sr' || !synth) return;

    if (synth.speaking || synth.pending) {
      if (pri >= current) synth.cancel();   // outrank what is playing
      else return;                          // never interrupt something louder
    }
    var u = new SpeechSynthesisUtterance(text);
    var v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = Math.max(0.5, Math.min(3, cfg.rate));
    u.pitch = 1;
    current = pri;
    u.onend = u.onerror = function () { current = null; };
    try { synth.speak(u); } catch (e) { current = null; }
  }

  function shutUp() {
    if (synth) { try { synth.cancel(); } catch (e) {} }
    current = null;
  }

  /* Short synthesised tones. Distinguishable by shape as well as pitch, so
     they still work through a phone speaker in a noisy shop. */
  function tone(steps, gain) {
    if (!cfg.earcons || !ctx) return;
    var t = ctx.currentTime;
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = s.type || 'sine';
      osc.frequency.setValueAtTime(s.f, t + s.at);
      g.gain.setValueAtTime(0.0001, t + s.at);
      g.gain.exponentialRampToValueAtTime(gain || 0.18, t + s.at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + s.at + s.dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t + s.at); osc.stop(t + s.at + s.dur + 0.02);
    }
  }

  var CUES = {
    armed:   [{ f: 1320, at: 0,    dur: 0.05 }],
    capture: [{ f: 660,  at: 0,    dur: 0.06 }],
    ok:      [{ f: 880,  at: 0,    dur: 0.05 }, { f: 1320, at: 0.06, dur: 0.07 }],
    unsure:  [{ f: 520,  at: 0,    dur: 0.09 }, { f: 380,  at: 0.10, dur: 0.12 }],
    error:   [{ f: 220,  at: 0,    dur: 0.16, type: 'square' }],
    stop:    [{ f: 520,  at: 0,    dur: 0.08 }, { f: 330,  at: 0.09, dur: 0.12 }]
  };
  var BUZZ = {
    armed: 0, capture: 12, ok: [18, 40, 18], unsure: [60, 60, 60],
    error: [140, 70, 140], stop: 30
  };

  function cue(name) {
    if (CUES[name]) tone(CUES[name], name === 'error' ? 0.25 : 0.18);
    if (cfg.haptics && navigator.vibrate && BUZZ[name]) {
      try { navigator.vibrate(BUZZ[name]); } catch (e) {}
    }
  }

  /* "$1,285" reads as "one thousand two hundred eighty five dollars", not as
     digits. Voices differ on how they handle "$", so spell it out. */
  function money(cents) {
    var neg = cents < 0;
    var abs = Math.abs(cents);
    var d = Math.floor(abs / 100);
    var c = abs % 100;
    var out = d === 1 ? 'one dollar' : d.toLocaleString('en-US') + ' dollars';
    if (c) out += ' and ' + c + (c === 1 ? ' cent' : ' cents');
    return (neg ? 'minus ' : '') + out;
  }

  function configure(next) {
    for (var k in next) if (Object.prototype.hasOwnProperty.call(next, k)) cfg[k] = next[k];
    var el = announcer();
    if (el && cfg.output === 'tts') el.setAttribute('aria-live', 'off');
  }

  return {
    PRI: PRI, say: say, cue: cue, unlock: unlock, shutUp: shutUp,
    money: money, configure: configure,
    voices: function () { return voices; },
    supported: !!synth
  };
})();
