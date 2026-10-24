// Apply the saved theme before first paint so dark mode doesn't flash.
// "light" | "dark" | unset (follow the device).
try {
  var t = localStorage.getItem("agr.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (_) { /* storage blocked: follow the device */ }
