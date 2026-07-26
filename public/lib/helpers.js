// Pure helpers shared between the browser client (app.js imports this as an
// ES module) and the Node test suite (which imports it directly) — Plan 8.

export function describeWeatherCode(code) {
  const map = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain",
    65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow",
    73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Light showers",
    81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
  };
  return map[code] || "Unknown conditions";
}

// Speakable label for a set of weekday numbers (0=Sun … 6=Sat).
export function formatDays(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "daily";
  if (sorted.join() === "1,2,3,4,5") return "M–F";
  if (sorted.join() === "0,6") return "weekends";
  return sorted.map(d => "SMTWTFS"[d]).join(" ");
}

// Routine steps are a tool-name string or { tool, args }.
export function routineStepNames(steps) {
  return steps.map(s => (typeof s === "string" ? s : s?.tool));
}

// Compact stopwatch display: M:SS until the first hour, then H:MM:SS.
export function formatElapsedTime(elapsedMs) {
  const ms = Number(elapsedMs);
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}
