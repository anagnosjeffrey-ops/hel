/* The running count. Survives a reload, because dropping a stack mid-count and
 * losing the total is worse than any other failure this app can have. */
window.Tally = (function () {
  var KEY = 'billreader.session.v1';
  var bills = restore();

  function restore() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(bills)); } catch (e) {}
  }

  function add(denomination, extra) {
    var entry = {
      value: denomination,
      at: Date.now(),
      serial: (extra && extra.serial) || null,
      confidence: (extra && extra.confidence) || null
    };
    bills.push(entry);
    persist();
    return entry;
  }

  function undo() {
    var gone = bills.pop() || null;
    persist();
    return gone;
  }

  function reset() { bills = []; persist(); }

  function totalCents() {
    var t = 0;
    for (var i = 0; i < bills.length; i++) t += bills[i].value * 100;
    return t;
  }

  /* Grouped breakdown, largest first: "two twenties, a five and three ones". */
  function breakdown() {
    var counts = {};
    for (var i = 0; i < bills.length; i++) {
      counts[bills[i].value] = (counts[bills[i].value] || 0) + 1;
    }
    return Object.keys(counts)
      .map(Number)
      .sort(function (a, b) { return b - a; })
      .map(function (v) { return { value: v, count: counts[v] }; });
  }

  var NAMES = { 1: 'one', 2: 'two', 5: 'five', 10: 'ten', 20: 'twenty', 50: 'fifty', 100: 'hundred' };
  var PLURALS = { 1: 'ones', 2: 'twos', 5: 'fives', 10: 'tens', 20: 'twenties', 50: 'fifties', 100: 'hundreds' };

  function spokenBreakdown() {
    var parts = breakdown().map(function (g) {
      return g.count + ' ' + (g.count === 1 ? NAMES[g.value] : PLURALS[g.value]);
    });
    if (!parts.length) return 'No bills counted.';
    if (parts.length === 1) return parts[0] + '.';
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] + '.';
  }

  function asText() {
    var lines = ['Bill Reader session — ' + new Date().toLocaleString()];
    for (var i = 0; i < bills.length; i++) {
      lines.push((i + 1) + '. $' + bills[i].value +
        (bills[i].serial ? '  serial ' + bills[i].serial : ''));
    }
    lines.push('');
    breakdown().forEach(function (g) { lines.push(g.count + ' x $' + g.value); });
    lines.push('TOTAL $' + (totalCents() / 100).toFixed(2));
    return lines.join('\n');
  }

  return {
    add: add, undo: undo, reset: reset,
    totalCents: totalCents, breakdown: breakdown,
    spokenBreakdown: spokenBreakdown, asText: asText,
    all: function () { return bills.slice(); },
    count: function () { return bills.length; },
    last: function () { return bills.length ? bills[bills.length - 1] : null; },
    name: function (v) { return NAMES[v] || String(v); }
  };
})();
