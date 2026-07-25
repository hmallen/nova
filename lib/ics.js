// Minimal ICS (RFC 5545) reader for the get_calendar skill (Plan 7).
//
// Supported: folded lines, SUMMARY/DTSTART/DTEND, three date shapes
// (all-day YYYYMMDD, UTC ...Z, and TZID=<IANA zone>), and RRULE with
// FREQ=DAILY|WEEKLY (INTERVAL, BYDAY, UNTIL, COUNT) expanded only within a
// query window. That covers the weekly-meeting 90% case; events with other
// FREQs, ordinal BYDAY (e.g. 2MO), or EXDATE are returned with
// `recurringUnsupported` so the caller can drop them and say so.

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 24 * 60 * 60 * 1000;

// What UTC offset (ms) does IANA zone `tz` have at instant `ts`?
function tzOffset(ts, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === "24" ? 0 : +p.hour, +p.minute, +p.second);
  return asUtc - ts;
}

// Epoch ms for wall-clock y-m-d h:mi:s in IANA zone `tz`. Two-pass offset
// correction handles DST transitions (the first guess can land on the wrong
// side of a spring-forward/fall-back boundary).
export function zonedTimeToEpoch(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - tzOffset(ts, tz);
  return ts;
}

function fieldsToTs(f, tz, allDay) {
  if (allDay) return new Date(f.y, f.mo - 1, f.d).getTime(); // server-local midnight
  if (tz === "UTC") return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
  if (tz) return zonedTimeToEpoch(f.y, f.mo, f.d, f.h, f.mi, f.s, tz);
  return new Date(f.y, f.mo - 1, f.d, f.h, f.mi, f.s).getTime(); // floating → local
}

// Shift a wall-clock date by n days (keeps time-of-day fields, so recurring
// TZID events stay at the same local time across DST).
function shiftDays(f, n) {
  const dt = new Date(Date.UTC(f.y, f.mo - 1, f.d + n));
  return { ...f, y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayOfWeek(f) {
  return new Date(Date.UTC(f.y, f.mo - 1, f.d)).getUTCDay();
}

// "20260725" | "20260725T143000[Z]" (+ optional TZID from the property params)
function parseIcsDate(params, value) {
  if (/^\d{8}$/.test(value)) {
    return {
      fields: { y: +value.slice(0, 4), mo: +value.slice(4, 6), d: +value.slice(6, 8), h: 0, mi: 0, s: 0 },
      tz: null,
      allDay: true,
    };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const fields = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
  const tzid = /(?:^|;)TZID=([^;:]+)/.exec(params)?.[1];
  return { fields, tz: m[7] ? "UTC" : tzid || null, allDay: false };
}

function parseRrule(value) {
  const parts = {};
  for (const kv of value.split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) parts[k.toUpperCase()] = v;
  }
  return {
    freq: parts.FREQ || "",
    interval: Math.max(1, parseInt(parts.INTERVAL || "1", 10) || 1),
    byday: parts.BYDAY ? parts.BYDAY.split(",") : null,
    until: parts.UNTIL || null,
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
  };
}

// parseIcs(text) → [{ summary, start, end, allDay, startFields, tz,
//                     rrule?, recurringUnsupported? }] (start/end epoch ms)
export function parseIcs(text) {
  if (typeof text !== "string") return [];
  // Unfold continuation lines (RFC 5545: CRLF followed by space or tab).
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur) {
        const ev = finishEvent(cur);
        if (ev) events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const semi = head.indexOf(";");
    const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? "" : head.slice(semi + 1);
    if (name === "SUMMARY") cur.summary = value.replace(/\\([,;nN\\])/g, (_, c) => (c === "n" || c === "N" ? " " : c)).trim();
    else if (name === "DTSTART") cur.dtstart = parseIcsDate(params, value);
    else if (name === "DTEND") cur.dtend = parseIcsDate(params, value);
    else if (name === "RRULE") cur.rrule = parseRrule(value);
    else if (name === "EXDATE") cur.exdate = true;
  }
  return events;
}

function finishEvent(cur) {
  if (!cur.dtstart) return null;
  const start = fieldsToTs(cur.dtstart.fields, cur.dtstart.tz, cur.dtstart.allDay);
  if (!Number.isFinite(start)) return null;
  const end = cur.dtend
    ? fieldsToTs(cur.dtend.fields, cur.dtend.tz, cur.dtend.allDay)
    : start + (cur.dtstart.allDay ? DAY_MS : 0);
  const ev = {
    summary: cur.summary || "(untitled)",
    start,
    end,
    allDay: cur.dtstart.allDay,
    startFields: cur.dtstart.fields,
    tz: cur.dtstart.tz,
  };
  if (cur.rrule) {
    const r = cur.rrule;
    const badByday = r.byday && r.byday.some(c => !(c in DAY_CODES));
    if (cur.exdate || badByday || (r.freq !== "DAILY" && r.freq !== "WEEKLY")) {
      ev.recurringUnsupported = true;
    } else {
      let untilTs = null;
      if (r.until) {
        const u = parseIcsDate("", r.until);
        untilTs = u ? fieldsToTs(u.fields, u.tz, u.allDay) + (u.allDay ? DAY_MS - 1 : 0) : null;
      }
      ev.rrule = { freq: r.freq, interval: r.interval, byday: r.byday, untilTs, count: r.count };
    }
  }
  return ev;
}

// Expand into concrete instances overlapping [windowStart, windowEnd].
// Returns { events: [{ summary, start, end, allDay }], unsupported: bool }.
export function expandEvents(events, windowStart, windowEnd) {
  const out = [];
  let unsupported = false;
  for (const ev of events) {
    if (ev.recurringUnsupported) { unsupported = true; continue; }
    if (!ev.rrule) {
      if (ev.end >= windowStart && ev.start <= windowEnd) {
        out.push({ summary: ev.summary, start: ev.start, end: ev.end, allDay: ev.allDay });
      }
      continue;
    }
    const dur = Math.max(0, ev.end - ev.start);
    const { freq, interval, byday, untilTs, count } = ev.rrule;
    const days = freq === "WEEKLY"
      ? (byday ? byday.map(c => DAY_CODES[c]) : [dayOfWeek(ev.startFields)])
      : null;
    // Week index is counted from the Monday of DTSTART's week so INTERVAL>1
    // stays aligned to calendar weeks.
    const mondayOffset = (dayOfWeek(ev.startFields) + 6) % 7;
    // Without COUNT we can fast-forward near the window; COUNT rules must be
    // walked from DTSTART because every occurrence consumes the budget.
    let n = 0;
    if (!count) {
      const behind = Math.floor((windowStart - dur - ev.start) / DAY_MS) - 8;
      if (behind > 0) n = behind;
    }
    let made = 0;
    for (const limit = n + 40000; n <= limit; n++) {
      const f = shiftDays(ev.startFields, n);
      const ts = fieldsToTs(f, ev.tz, ev.allDay);
      if (ts > windowEnd) break;
      if (untilTs != null && ts > untilTs) break;
      let hit;
      if (freq === "DAILY") {
        hit = n % interval === 0;
      } else {
        const weekIndex = Math.floor((n + mondayOffset) / 7);
        hit = weekIndex % interval === 0 && days.includes(dayOfWeek(f));
      }
      if (!hit) continue;
      made++;
      if (count != null && made > count) break;
      if (ts + dur >= windowStart) {
        out.push({ summary: ev.summary, start: ts, end: ts + dur, allDay: ev.allDay });
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return { events: out, unsupported };
}
