/* Camera plumbing: stream setup, full-resolution capture, and the small
 * grayscale buffer the detector reads every frame. */
window.Cam = (function () {
  var video = null;
  var stream = null;
  var track = null;

  // Capture canvas. Capped at 1024px on the long edge: wide enough to read a
  // denomination and a serial number, small enough to keep upload latency down.
  var CAP_MAX = 1024;
  var cap = document.createElement('canvas');
  var capCtx = cap.getContext('2d', { willReadFrequently: false });

  // Analysis canvas. Small enough to run on every animation frame, but not so
  // small that downsampling blurs away the detail the sharpness test needs.
  var AW = 128, AH = 96;
  var an = document.createElement('canvas');
  an.width = AW; an.height = AH;
  var anCtx = an.getContext('2d', { willReadFrequently: true });

  function start(facing) {
    stop();
    var constraints = {
      audio: false,
      video: {
        facingMode: facing === 'environment' ? { ideal: 'environment' } : { ideal: 'user' },
        width: { ideal: 1280 },
        height: { ideal: 960 },
        frameRate: { ideal: 30 }
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
      stream = s;
      track = s.getVideoTracks()[0] || null;
      video.srcObject = s;
      video.classList.toggle('mirror', facing !== 'environment');
      return video.play().then(ready);
    });
  }

  function ready() {
    // Safari can resolve play() before dimensions are known.
    if (video.videoWidth) return Promise.resolve();
    return new Promise(function (resolve) {
      var t = setTimeout(resolve, 2500);
      video.addEventListener('loadedmetadata', function () {
        clearTimeout(t); resolve();
      }, { once: true });
    });
  }

  function stop() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; track = null;
    if (video) video.srcObject = null;
  }

  /* Torch is rear-camera-only and unsupported on iOS Safari; failure is fine. */
  function setTorch(on) {
    if (!track || !track.applyConstraints) return Promise.resolve(false);
    var caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps || !('torch' in caps)) return Promise.resolve(false);
    return track.applyConstraints({ advanced: [{ torch: !!on }] })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function live() {
    return !!(video && video.readyState >= 2 && video.videoWidth > 0);
  }

  /* Downsampled grayscale of the current frame, for the detector. */
  function grayFrame() {
    if (!live()) return null;
    anCtx.drawImage(video, 0, 0, AW, AH);
    var px = anCtx.getImageData(0, 0, AW, AH).data;
    var g = new Uint8ClampedArray(AW * AH);
    for (var i = 0, j = 0; i < px.length; i += 4, j++) {
      // Rec. 601 luma, integer-ish for speed.
      g[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    }
    return { data: g, w: AW, h: AH };
  }

  /* Full-quality JPEG for the recogniser. Front-camera frames arrive
     unmirrored from the sensor; only the CSS preview is flipped. */
  function snapshot(quality) {
    if (!live()) return null;
    var vw = video.videoWidth, vh = video.videoHeight;
    var scale = Math.min(1, CAP_MAX / Math.max(vw, vh));
    cap.width = Math.round(vw * scale);
    cap.height = Math.round(vh * scale);
    capCtx.drawImage(video, 0, 0, cap.width, cap.height);
    var url = cap.toDataURL('image/jpeg', quality || 0.72);
    return { dataUrl: url, base64: url.slice(url.indexOf(',') + 1) };
  }

  function attach(el) { video = el; }

  return {
    attach: attach, start: start, stop: stop, setTorch: setTorch,
    live: live, grayFrame: grayFrame, snapshot: snapshot,
    el: function () { return video; }
  };
})();
