/* On-device frame analysis.
 *
 * Nothing here identifies a bill — that is the model's job. This decides *when*
 * to spend a network round trip: a bill has entered the frame, it is sharp
 * enough to read, and it is a different bill from the one just counted. Doing
 * that locally is what makes counting feel sequential instead of laggy, and it
 * is why the app is not firing off a request thirty times a second.
 */
window.Detector = (function () {
  var bg = null;          // slow background model, learned only when no bill is present
  var prev = null;        // previous frame, for the motion signal
  var warm = 0;           // frames of background learning so far
  var W = 0, H = 0;

  function reset() { bg = null; prev = null; warm = 0; }

  /* Fold a frame into the background model. Called only when the caller has
     established the view is clear — otherwise a bill held still for a second
     would be absorbed into the background and stop registering as present. */
  function learn(frame) {
    var g = frame.data, n = frame.w * frame.h;
    if (!bg || bg.length !== n) {
      bg = new Float32Array(n);
      for (var i = 0; i < n; i++) bg[i] = g[i];
      warm = 1;
      return;
    }
    var alpha = warm < 20 ? 0.25 : 0.05;
    for (var j = 0; j < n; j++) bg[j] += (g[j] - bg[j]) * alpha;
    warm++;
  }

  function observe(frame, learnBackground) {
    var g = frame.data;
    W = frame.w; H = frame.h;
    var n = W * H;

    if (!bg || bg.length !== n) {
      bg = new Float32Array(n);
      for (var a = 0; a < n; a++) bg[a] = g[a];
      warm = 1;
    }

    // Motion: mean absolute difference against the previous frame.
    var motion = 0;
    if (prev && prev.length === n) {
      var m = 0;
      for (var b = 0; b < n; b++) m += Math.abs(g[b] - prev[b]);
      motion = m / n;
    }

    // Occupancy: how much of the middle of the frame differs from the learned
    // background. The border is ignored so a thumb at the edge, or a person
    // walking past behind, does not arm the trigger.
    var x0 = (W * 0.15) | 0, x1 = (W * 0.85) | 0;
    var y0 = (H * 0.15) | 0, y1 = (H * 0.85) | 0;
    var covered = 0, cells = 0, sum = 0;
    for (var y = y0; y < y1; y++) {
      var row = y * W;
      for (var x = x0; x < x1; x++) {
        var i = row + x;
        sum += g[i];
        cells++;
        if (Math.abs(g[i] - bg[i]) > 26) covered++;
      }
    }
    var occupancy = cells ? covered / cells : 0;
    var bright = cells ? sum / cells : 0;

    // Sharpness and edge density from a Laplacian over the same centre region.
    // Variance of the Laplacian is the classic focus measure: a motion-blurred
    // bill scores far lower than the same bill held still, so of several frames
    // we can send the one that is actually readable.
    var lsum = 0, lsq = 0, lcount = 0, strong = 0;
    for (var yy = y0 + 1; yy < y1 - 1; yy++) {
      var r = yy * W;
      for (var xx = x0 + 1; xx < x1 - 1; xx++) {
        var k = r + xx;
        var lap = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - W] - g[k + W];
        lsum += lap; lsq += lap * lap; lcount++;
        if (lap > 22 || lap < -22) strong++;
      }
    }
    var mean = lcount ? lsum / lcount : 0;
    var sharp = lcount ? (lsq / lcount) - (mean * mean) : 0;
    var edges = lcount ? strong / lcount : 0;

    if (learnBackground) learn(frame);

    prev = g;

    return {
      occupancy: occupancy,
      motion: motion,
      sharp: sharp,
      edges: edges,
      bright: bright,
      ready: warm > 8
    };
  }

  /* Sensitivity slider (10 = only obvious bills, 90 = hair trigger) mapped to
     the enter/exit pair. Exit sits well below enter so a bill flickering around
     the threshold cannot be counted twice. */
  function thresholds(sensitivity) {
    var s = Math.max(10, Math.min(90, sensitivity || 50)) / 100;
    var enter = 0.62 - s * 0.42;
    return { enter: enter, exit: enter * 0.5 };
  }

  return { reset: reset, observe: observe, learn: learn, thresholds: thresholds };
})();
