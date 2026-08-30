/* Settings: persisted in localStorage, bound to the form in the settings sheet. */
window.Settings = (function () {
  var KEY = 'billreader.settings.v1';

  var DEFAULTS = {
    mode: 'direct',
    apiKey: '',
    proxyUrl: '',
    proxyToken: '',
    model: 'claude-opus-5',
    fastMode: false,
    confidence: 0.85,
    twoLook: false,
    output: 'tts',
    voiceURI: '',
    rate: 1.4,
    announceTotal: false,
    earcons: true,
    haptics: true,
    guidance: true,
    facing: 'user',
    torch: false,
    sensitivity: 50
  };

  var state = load();

  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var j in DEFAULTS) {
          if (Object.prototype.hasOwnProperty.call(saved, j)) out[j] = saved[j];
        }
      }
    } catch (e) { /* corrupt or unavailable storage: fall back to defaults */ }
    return out;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    apply();
  }

  function apply() {
    Voice.configure({
      rate: state.rate, voiceURI: state.voiceURI, output: state.output,
      earcons: state.earcons, haptics: state.haptics
    });
  }

  function $(id) { return document.getElementById(id); }

  function fillVoices() {
    var sel = $('voice');
    if (!sel) return;
    var list = Voice.voices();
    sel.innerHTML = '';
    var auto = document.createElement('option');
    auto.value = ''; auto.textContent = 'Automatic';
    sel.appendChild(auto);
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].voiceURI;
      o.textContent = list[i].name + ' (' + list[i].lang + ')';
      sel.appendChild(o);
    }
    sel.value = state.voiceURI;
  }

  function syncModeFields() {
    $('direct-fields').hidden = state.mode !== 'direct';
    $('proxy-fields').hidden = state.mode !== 'proxy';
  }

  function bind() {
    $('mode').value = state.mode;
    $('apikey').value = state.apiKey;
    $('proxyurl').value = state.proxyUrl;
    $('proxytoken').value = state.proxyToken;
    $('model').value = state.model;
    $('fastmode').checked = state.fastMode;
    $('confidence').value = Math.round(state.confidence * 100);
    $('confidence-val').textContent = Math.round(state.confidence * 100);
    $('twolook').checked = state.twoLook;
    $('output').value = state.output;
    $('rate').value = state.rate;
    $('rate-val').textContent = Number(state.rate).toFixed(1);
    $('announce-total').checked = state.announceTotal;
    $('earcons').checked = state.earcons;
    $('haptics').checked = state.haptics;
    $('guidance').checked = state.guidance;
    $('facing').value = state.facing;
    $('torch').checked = state.torch;
    $('sensitivity').value = state.sensitivity;
    $('sensitivity-val').textContent = state.sensitivity;
    syncModeFields();
    fillVoices();

    on('mode', function (v) { state.mode = v; syncModeFields(); });
    on('apikey', function (v) { state.apiKey = v.trim(); });
    on('proxyurl', function (v) { state.proxyUrl = v.trim(); });
    on('proxytoken', function (v) { state.proxyToken = v.trim(); });
    on('model', function (v) { state.model = v; });
    onCheck('fastmode', function (v) { state.fastMode = v; });
    on('confidence', function (v) {
      state.confidence = Number(v) / 100;
      $('confidence-val').textContent = v;
    });
    onCheck('twolook', function (v) { state.twoLook = v; });
    on('output', function (v) { state.output = v; });
    on('voice', function (v) { state.voiceURI = v; });
    on('rate', function (v) {
      state.rate = Number(v);
      $('rate-val').textContent = Number(v).toFixed(1);
    });
    onCheck('announce-total', function (v) { state.announceTotal = v; });
    onCheck('earcons', function (v) { state.earcons = v; });
    onCheck('haptics', function (v) { state.haptics = v; });
    onCheck('guidance', function (v) { state.guidance = v; });
    on('facing', function (v) {
      state.facing = v;
      document.dispatchEvent(new CustomEvent('camera-changed'));
    });
    onCheck('torch', function (v) {
      state.torch = v;
      document.dispatchEvent(new CustomEvent('torch-changed'));
    });
    on('sensitivity', function (v) {
      state.sensitivity = Number(v);
      $('sensitivity-val').textContent = v;
    });

    document.addEventListener('voiceschanged', fillVoices);
    apply();
  }

  function on(id, fn) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('input', function () { fn(el.value); save(); });
    el.addEventListener('change', function () { fn(el.value); save(); });
  }
  function onCheck(id, fn) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('change', function () { fn(el.checked); save(); });
  }

  return { state: state, bind: bind, save: save };
})();
