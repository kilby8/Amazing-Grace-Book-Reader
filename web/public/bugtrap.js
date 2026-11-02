// Keeps the last few errors and warnings so a bug report can say what
// actually went wrong. Loaded before app.js (a classic script, so it runs
// even if app.js or its CDN imports fail). Nothing leaves the page unless
// the reader sends a report.
(function () {
  "use strict";
  var MAX = 30;
  var log = [];
  function clip(v) {
    var s;
    try {
      if (v instanceof Error) s = v.name + ": " + v.message + (v.stack ? "\n" + v.stack.split("\n").slice(1, 4).join("\n") : "");
      else if (typeof v === "string") s = v;
      else s = JSON.stringify(v);
    } catch (_) { s = String(v); }
    s = String(s);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  }
  function push(kind, parts) {
    log.push({ t: Date.now(), kind: kind, msg: Array.prototype.map.call(parts, clip).join(" ") });
    if (log.length > MAX) log.shift();
  }
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) {
      push("load", ["failed to load " + (e.target.src || e.target.href)]);
    } else {
      push("error", [e.error || e.message, e.filename ? "@" + e.filename.split("/").pop() + ":" + e.lineno : ""]);
    }
  }, true);
  window.addEventListener("unhandledrejection", function (e) { push("rejection", [e.reason]); });
  ["error", "warn"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      push(level, arguments);
      return orig.apply(console, arguments);
    };
  });
  window.agrBugLog = {
    note: function (kind, msg) { push(kind, [msg]); },
    entries: function () { return log.slice(); },
  };
})();
