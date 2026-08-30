/* The counting loop.
 *
 * A bill goes past the camera in well under a second, so the app watches the
 * frame locally at ~20 Hz and only spends a network round trip when a bill is
 * actually there and readable. One bill in, one spoken denomination out, then
 * the frame has to go empty again before the next bill can be counted — that
 * clear-the-frame step is what stops one bill being counted twice while it
 * lingers in view.
 */
(function () {
  var S = Settings.state;

  var el = {};
  ['video', 'total', 'status', 'log', 'reticle', 'scan-btn', 'total-btn', 'undo-btn',
   'list-btn', 'reset-btn', 'copy-btn', 'settings', 'settings-btn', 'close-settings',
   'test-btn'].forEach(function (id) { el[id] = document.getElementById(id); });

  var state = 'off';        // off | warmup | seeking | holding | thinking | clearing
  var scanning = false;
  var holdStart = 0;
  var clearStart = 0;
  var warmStart = 0;
  var shots = [];           // sharpest full-res frames of the current bill
  var bestSharp = 0;
  var lastShotAt = 0;
  var lastSpokenHint = 0;
  var lastActivity = 0;
  var wakeLock = null;
  var loopHandle = null;

  var HOLD_MS = 550;        // how long to watch a bill before committing to a frame
  var CLEAR_MS = 220;       // how long the frame must stay empty before re-arming
  var WARM_MS = 900;        // background learning before the first bill
  var IDLE_STOP_MS = 180000;
  var MAX_SHOTS = 3;

  /* ---------------------------------------------------------------- output */

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderTotal() {
    var cents = Tally.totalCents();
    el.total.textContent = '$' + (cents / 100).toLocaleString('en-US', {
      minimumFractionDigits: cents % 100 ? 2 : 0,
      maximumFractionDigits: 2
    });
    var bills = Tally.all();
    el.log.innerHTML = '';
    if (!bills.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No bills counted yet.';
      el.log.appendChild(empty);
      return;
    }
    for (var i = 0; i < bills.length; i++) {
      var li = document.createElement('li');
      li.textContent = '$' + bills[i].value;
      el.log.appendChild(li);
    }
  }

  function speakTotal(priority) {
    var n = Tally.count();
    Voice.say(
      n === 0 ? 'Nothing counted yet.'
              : 'Total ' + Voice.money(Tally.totalCents()) + ', ' + n + (n === 1 ? ' bill.' : ' bills.'),
      priority || Voice.PRI.status
    );
  }

  /* ------------------------------------------------------------ the verdict */

  var ISSUE_HINT = {
    no_bill: 'No bill seen.',
    partial: 'Only part of the bill. Show the whole bill.',
    blurry: 'Too blurry. Move it slower.',
    too_dark: 'Too dark. More light, please.',
    glare: 'Glare. Tilt the bill.',
    too_close: 'Too close. Move it back.',
    too_far: 'Too far. Move it closer.',
    multiple_bills: 'More than one bill. One at a time.',
    not_us_currency: 'That is not a U.S. bill.'
  };

  function handleVerdict(v) {
    lastActivity = Date.now();

    if (!v || typeof v.denomination !== 'string') {
      reject('Could not read that. Try again.');
      return;
    }
    if (v.bills_in_frame > 1) { reject(ISSUE_HINT.multiple_bills); return; }
    if (!v.bill_present || v.denomination === 'unknown') {
      reject(ISSUE_HINT[v.issue] || 'Not sure. Show it again.');
      return;
    }
    if (v.issue && v.issue !== 'none') { reject(ISSUE_HINT[v.issue] || 'Not sure. Show it again.'); return; }
    if (typeof v.confidence !== 'number' || v.confidence < S.confidence) {
      reject('Not sure. Show it again.');
      return;
    }

    var value = parseInt(v.denomination, 10);
    if ([1, 2, 5, 10, 20, 50, 100].indexOf(value) === -1) {
      reject('Could not read that. Try again.');
      return;
    }

    // A serial number is unique to a bill, so a repeat means the same note
    // drifted back into view — the strongest double-count guard we have.
    var serial = (v.serial || '').replace(/\s+/g, '').toUpperCase();
    var prev = Tally.last();
    if (serial.length >= 8 && prev && prev.serial === serial) {
      setStatus('Same bill as the last one — not counted again.', 'warn');
      Voice.cue('armed');
      return;
    }

    Tally.add(value, { serial: serial.length >= 8 ? serial : null, confidence: v.confidence });
    renderTotal();
    Voice.cue('ok');

    var word = Tally.name(value);
    var line = value === 100 ? 'one hundred' : word;
    if (S.announceTotal) line += '. Total ' + Voice.money(Tally.totalCents());
    Voice.say(line, Voice.PRI.bill);
    setStatus('$' + value + ' counted. Total $' + (Tally.totalCents() / 100).toFixed(2));
  }

  function reject(message) {
    Voice.cue('unsure');
    Voice.say(message, Voice.PRI.bill);
    setStatus(message, 'warn');
  }

  function failure(err) {
    var msg;
    switch (err && err.message) {
      case 'NO_KEY': msg = 'No API key yet. Open Settings and paste your key.'; break;
      case 'NO_PROXY': msg = 'No proxy address yet. Open Settings and add one.'; break;
      case 'AUTH': msg = 'The API key was rejected. Check it in Settings.'; break;
      case 'RATE_LIMIT': msg = 'Rate limited. Wait a few seconds.'; break;
      case 'TIMEOUT': msg = 'That took too long. Try the bill again.'; break;
      case 'NETWORK': msg = 'No connection. Nothing was counted.'; break;
      case 'SERVER': msg = 'The service is having trouble. Try again.'; break;
      default: msg = 'Something went wrong. Nothing was counted.';
    }
    Voice.cue('error');
    Voice.say(msg, Voice.PRI.alert);
    setStatus(msg, 'err');
  }

  /* ------------------------------------------------------------- the loop */

  function send() {
    state = 'thinking';
    el.reticle.classList.remove('hot');
    Voice.cue('capture');
    setStatus('Reading…');

    var images = shots.slice(0, S.twoLook ? 2 : 1).map(function (s) { return s.base64; });
    shots = [];
    bestSharp = 0;

    Recognizer.identify(images, S)
      .then(handleVerdict)
      .catch(failure)
      .then(function () {
        state = 'clearing';
        clearStart = 0;
      });
  }

  function maybeHint(m) {
    if (!S.guidance) return;
    var now = Date.now();
    if (now - lastSpokenHint < 7000) return;
    var hint = null;
    if (m.bright < 42) hint = 'Too dark for the camera.';
    else if (m.bright > 232) hint = 'Too bright. Move out of the glare.';
    if (!hint) return;
    lastSpokenHint = now;
    Voice.say(hint, Voice.PRI.chatter);
    setStatus(hint, 'warn');
  }

  function tick() {
    if (!scanning) return;
    loopHandle = setTimeout(function () { requestAnimationFrame(tick); }, 50);

    if (!Cam.live()) return;
    var frame = Cam.grayFrame();
    if (!frame) return;

    var now = Date.now();
    var m = Detector.observe(frame, false);
    var th = Detector.thresholds(S.sensitivity);

    // Update the background only when the view is genuinely clear, and never
    // while a bill is being held or read.
    var mayLearn = state === 'warmup' || state === 'seeking' || state === 'clearing';
    if (mayLearn && m.occupancy < th.exit) Detector.learn(frame);

    switch (state) {
      case 'warmup':
        if (now - warmStart > WARM_MS && m.ready) {
          state = 'seeking';
          Voice.cue('armed');
          Voice.say('Ready. Pass a bill across.', Voice.PRI.status);
          setStatus('Ready. Pass one bill at a time across the camera.');
          lastActivity = now;
        }
        break;

      case 'seeking':
        el.reticle.classList.toggle('hot', m.occupancy > th.enter * 0.7);
        if (m.occupancy > th.enter) {
          state = 'holding';
          holdStart = now;
          shots = [];
          bestSharp = 0;
          lastShotAt = 0;
        } else {
          maybeHint(m);
          if (lastActivity && now - lastActivity > IDLE_STOP_MS) {
            stopScanning('Stopped scanning to save battery.');
          }
        }
        break;

      case 'holding':
        el.reticle.classList.add('hot');
        // Keep the sharpest frames of this pass. Variance of the Laplacian
        // falls off fast with motion blur, so this reliably prefers the moment
        // the hand slowed down.
        if (m.sharp > bestSharp * 1.12 && now - lastShotAt > 80 && shots.length < MAX_SHOTS) {
          var shot = Cam.snapshot(0.72);
          if (shot) {
            shot.sharp = m.sharp;
            shots.unshift(shot);
            bestSharp = m.sharp;
            lastShotAt = now;
          }
        }
        if (now - holdStart > HOLD_MS || m.occupancy < th.exit) {
          if (shots.length) {
            shots.sort(function (a, b) { return b.sharp - a.sharp; });
            send();
          } else {
            state = 'clearing';
            clearStart = 0;
          }
        }
        break;

      case 'thinking':
        break;

      case 'clearing':
        el.reticle.classList.remove('hot');
        if (m.occupancy < th.exit) {
          if (!clearStart) clearStart = now;
          if (now - clearStart > CLEAR_MS) {
            state = 'seeking';
            clearStart = 0;
            Voice.cue('armed');
          }
        } else {
          clearStart = 0;
        }
        break;
    }
  }

  /* ------------------------------------------------------- start and stop */

  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
    }).catch(function () { /* not fatal */ });
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  function startScanning() {
    Voice.unlock();
    setStatus('Starting the camera…');
    Cam.start(S.facing).then(function () {
      if (S.facing === 'environment' && S.torch) Cam.setTorch(true);
      Detector.reset();
      scanning = true;
      state = 'warmup';
      warmStart = Date.now();
      lastActivity = Date.now();
      el['scan-btn'].textContent = 'Stop scanning';
      el['scan-btn'].classList.add('scanning');
      el['scan-btn'].classList.remove('primary');
      setStatus('Hold the camera clear of the bills for a moment…');
      Voice.say('Hold the camera clear for a moment.', Voice.PRI.status);
      requestWakeLock();
      tick();
    }).catch(function (err) {
      var msg = (err && err.name === 'NotAllowedError')
        ? 'Camera permission was refused. Allow the camera and try again.'
        : 'The camera would not start. ' + ((err && err.message) || '');
      Voice.cue('error');
      Voice.say(msg, Voice.PRI.alert);
      setStatus(msg, 'err');
    });
  }

  function stopScanning(reason) {
    scanning = false;
    state = 'off';
    if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
    Cam.stop();
    releaseWakeLock();
    el.reticle.classList.remove('hot');
    el['scan-btn'].textContent = 'Start scanning';
    el['scan-btn'].classList.remove('scanning');
    el['scan-btn'].classList.add('primary');
    Voice.cue('stop');
    setStatus(reason || 'Stopped.');
    speakTotal(Voice.PRI.status);
  }

  function toggleScanning() {
    if (scanning) stopScanning(); else startScanning();
  }

  /* --------------------------------------------------------------- wiring */

  el['scan-btn'].addEventListener('click', toggleScanning);

  el['total-btn'].addEventListener('click', function () {
    Voice.unlock();
    speakTotal(Voice.PRI.alert);
  });

  el['undo-btn'].addEventListener('click', function () {
    Voice.unlock();
    var gone = Tally.undo();
    renderTotal();
    if (!gone) {
      Voice.say('Nothing to undo.', Voice.PRI.alert);
      return;
    }
    Voice.cue('capture');
    Voice.say('Removed ' + Tally.name(gone.value) + '. Total ' + Voice.money(Tally.totalCents()), Voice.PRI.alert);
    setStatus('Removed $' + gone.value + '.');
  });

  el['list-btn'].addEventListener('click', function () {
    Voice.unlock();
    Voice.say(Tally.spokenBreakdown() + ' Total ' + Voice.money(Tally.totalCents()), Voice.PRI.alert);
  });

  el['reset-btn'].addEventListener('click', function () {
    Voice.unlock();
    if (!Tally.count()) { Voice.say('Already at zero.', Voice.PRI.alert); return; }
    if (!confirm('Clear the count of $' + (Tally.totalCents() / 100).toFixed(2) + '?')) return;
    Tally.reset();
    renderTotal();
    Voice.cue('stop');
    Voice.say('Cleared. Back to zero.', Voice.PRI.alert);
    setStatus('Cleared.');
  });

  el['copy-btn'].addEventListener('click', function () {
    var text = Tally.asText();
    var done = function () { Voice.say('Copied.', Voice.PRI.alert); setStatus('Session copied to the clipboard.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        Voice.say('Could not copy.', Voice.PRI.alert);
      });
    } else {
      Voice.say('Copying is not available in this browser.', Voice.PRI.alert);
    }
  });

  function openSettings(open) {
    el.settings.hidden = !open;
    el['settings-btn'].setAttribute('aria-expanded', String(open));
    if (open) {
      var first = el.settings.querySelector('select, input, button');
      if (first) first.focus();
    } else {
      el['settings-btn'].focus();
    }
  }
  el['settings-btn'].addEventListener('click', function () { openSettings(el.settings.hidden); });
  el['close-settings'].addEventListener('click', function () { openSettings(false); });
  el['test-btn'].addEventListener('click', function () {
    Voice.unlock();
    Voice.cue('ok');
    Voice.say('Twenty. Total one hundred and forty dollars.', Voice.PRI.alert);
  });

  document.addEventListener('camera-changed', function () {
    if (scanning) { stopScanning('Switching camera…'); startScanning(); }
  });
  document.addEventListener('torch-changed', function () {
    if (scanning && S.facing === 'environment') Cam.setTorch(S.torch);
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      if (t && t.tagName === 'BUTTON') return;   // let the button handle it
      e.preventDefault(); toggleScanning();
    } else if (k === 't') { e.preventDefault(); el['total-btn'].click(); }
    else if (k === 'u') { e.preventDefault(); el['undo-btn'].click(); }
    else if (k === 'l') { e.preventDefault(); el['list-btn'].click(); }
    else if (k === 'r') { e.preventDefault(); el['reset-btn'].click(); }
    else if (k === 'escape' && !el.settings.hidden) { e.preventDefault(); openSettings(false); }
  });

  // Backgrounding the page suspends the camera anyway; stop cleanly so the
  // count is never left in a half-read state.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && scanning) stopScanning('Paused — the app went to the background.');
  });

  /* ----------------------------------------------------------------- boot */

  Cam.attach(el.video);
  Settings.bind();
  renderTotal();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser cannot use the camera. Try Safari on iPhone or Chrome on Android.', 'err');
    el['scan-btn'].disabled = true;
  } else if (!window.isSecureContext) {
    setStatus('The camera needs a secure (https) address. Open this page over https.', 'err');
    el['scan-btn'].disabled = true;
  } else if (S.mode === 'direct' && !S.apiKey) {
    setStatus('Open Settings and paste your Anthropic API key to begin.', 'warn');
  }

  /* Testing surface. Lets you rehearse the whole announcement path — sounds,
     speech, totals, the duplicate-serial guard — from the browser console
     without a camera or a single API call:
       BillReader.simulate({ bill_present: true, bills_in_frame: 1,
         denomination: '20', confidence: 0.96, side: 'front',
         serial: 'MB12345678A', issue: 'none' }) */
  window.BillReader = {
    simulate: handleVerdict,
    state: function () { return state; },
    metrics: function () {
      var f = Cam.grayFrame();
      return f ? Detector.observe(f, false) : null;
    }
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
