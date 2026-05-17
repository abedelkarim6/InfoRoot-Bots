/**
 * Monitor page — pure helpers shared across tabs.
 *
 * Ports the helpers from static/js/pages/monitor-schedules.js and
 * static/js/shared/api.js. All functions here are pure (no DOM, no state)
 * and safe to import from any tab component.
 */

export const BEIRUT_TZ = 'Asia/Beirut';

// ────────────────────────────────────────────────────────────────────────────
// Schedule introspection
// ────────────────────────────────────────────────────────────────────────────

export function scheduleIcon(sch) {
  if (sch.type === 'hourly') return '🕐';
  if (sch.type === 'daily') return '📅';
  if (sch.type === 'minute') return '⚡';
  if (sch.type === 'interval_hourly') return '🔁';
  if (sch.type === 'interval_minutes') return '🔁';
  if (sch.type === 'speeches_interval') return '🎙️';
  return '🔔';
}

export function scheduleSpec(sch) {
  if (sch.type === 'hourly') return `every hour at :${pad(sch.minute ?? 0)}`;
  if (sch.type === 'daily') return `daily at ${pad(sch.hour ?? 0)}:${pad(sch.minute ?? 0)}`;
  if (sch.type === 'minute') return `every ${sch.minute ?? 1} min`;
  if (sch.type === 'interval_minutes') {
    const sh = pad(sch.start_hour ?? 0);
    const sm = pad(sch.start_minute ?? 0);
    const endPart =
      sch.end_hour != null && sch.end_minute != null
        ? ` → ${pad(sch.end_hour)}:${pad(sch.end_minute)}`
        : '';
    return `every ${sch.minutes || 30}m — starts ${sh}:${sm}${endPart}`;
  }
  if (sch.type === 'interval_hourly') {
    const sh = pad(sch.start_hour ?? 0);
    const sm = pad(sch.start_minute ?? 0);
    const endPart =
      sch.end_hour != null && sch.end_minute != null
        ? ` → ${pad(sch.end_hour)}:${pad(sch.end_minute)}`
        : '';
    return `every ${sch.hours || 1}h — starts ${sh}:${sm}${endPart}`;
  }
  if (sch.type === 'speeches_interval') {
    return `every 1m check — send after ${sch.wait_time || 5}m idle`;
  }
  return sch.type;
}

export function scheduleStartTime(sch) {
  const type = sch.type;
  if (type === 'daily') {
    return `${pad(sch.hour ?? 0)}:${pad(sch.minute ?? 0)}`;
  }
  if (type === 'hourly') return `:${pad(sch.minute ?? 0)} (each hour)`;
  if (type === 'interval_hourly' || type === 'interval_minutes') {
    return `${pad(sch.start_hour ?? 0)}:${pad(sch.start_minute ?? 0)}`;
  }
  if (type === 'minute') return '00:00';
  return '—';
}

export function scheduleEndTime(sch) {
  const type = sch.type;
  if (type === 'interval_hourly' || type === 'interval_minutes') {
    if (sch.end_hour != null && sch.end_minute != null) {
      return `${pad(sch.end_hour)}:${pad(sch.end_minute)}`;
    }
    return '—';
  }
  return '—';
}

export function scheduleRepeatsText(sch) {
  const type = sch.type;
  if (type === 'daily') return 'once daily';
  if (type === 'hourly') return `every hour at :${pad(sch.minute ?? 0)}`;
  if (type === 'minute') return `every ${sch.minute ?? '?'} min`;
  if (type === 'interval_hourly') {
    const h = sch.hours ?? 1;
    return `every ${h} hour${h !== 1 ? 's' : ''}`;
  }
  if (type === 'interval_minutes') {
    const m = sch.minutes ?? 1;
    return `every ${m} min${m !== 1 ? 's' : ''}`;
  }
  return '—';
}

export function scheduleFiresPerDay(sch) {
  const type = sch.type;
  if (type === 'daily') return 1;
  if (type === 'hourly') return 24;
  if (type === 'minute') return Math.floor(1440 / (sch.minute || 60));
  if (type === 'interval_hourly') {
    const hours = sch.hours ?? 1;
    if (sch.end_hour != null && sch.end_minute != null) {
      // Inclusive endpoint: the fire AT end time still passes the backend
      // time-window gate, so the count is intervals + 1 (matches
      // getUpcomingFires24h and the bot's actual fire series).
      const startMins = (sch.start_hour ?? 0) * 60 + (sch.start_minute ?? 0);
      const endMins = sch.end_hour * 60 + sch.end_minute;
      return Math.max(1, Math.floor((endMins - startMins) / (hours * 60)) + 1);
    }
    return Math.max(1, Math.floor(24 / hours));
  }
  if (type === 'interval_minutes') {
    const mins = sch.minutes ?? 1;
    if (sch.end_hour != null && sch.end_minute != null) {
      // Inclusive endpoint — see interval_hourly note above.
      const startMins = (sch.start_hour ?? 0) * 60 + (sch.start_minute ?? 0);
      const endMins = sch.end_hour * 60 + sch.end_minute;
      return Math.max(1, Math.floor((endMins - startMins) / mins) + 1);
    }
    return Math.max(1, Math.floor(1440 / mins));
  }
  return 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Time math (Beirut-aware)
// ────────────────────────────────────────────────────────────────────────────

// Returns UTC ms for the Beirut calendar day of `ms`, at Beirut hour h:minute m.
// Works correctly regardless of the browser's local timezone.
export function beirutDayAt(ms, h, m) {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: BEIRUT_TZ }).format(new Date(ms));
  const [year, month, day] = dateStr.split('-').map(Number);
  const roughMs = Date.UTC(year, month - 1, day, h, m, 0);
  const beirutStr = new Intl.DateTimeFormat('en-US', {
    timeZone: BEIRUT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(roughMs));
  const [bh, bm] = beirutStr.split(':').map(Number);
  let diffMs = ((h - bh) * 60 + (m - bm)) * 60000;
  if (diffMs > 43200000) diffMs -= 86400000;
  if (diffMs < -43200000) diffMs += 86400000;
  return roughMs + diffMs;
}

// Returns all fire timestamps for a schedule within the next 24h from nowMs.
export function getUpcomingFires24h(sch, nowMs) {
  const toMs = nowMs + 24 * 3600000;
  const type = sch.type;
  const fires = [];

  if (type === 'daily') {
    for (let d = 0; d <= 1; d++) {
      const t = new Date(nowMs);
      t.setDate(t.getDate() + d);
      t.setHours(sch.hour ?? 0, sch.minute ?? 0, 0, 0);
      if (t.getTime() > nowMs && t.getTime() < toMs) fires.push(t.getTime());
    }
  } else if (type === 'hourly') {
    const first = new Date(nowMs);
    first.setMinutes(sch.minute ?? 0, 0, 0);
    if (first.getTime() <= nowMs) first.setHours(first.getHours() + 1);
    let t = first.getTime();
    while (t < toMs) {
      fires.push(t);
      t += 3600000;
    }
  } else if (type === 'minute') {
    const intervalMs = (sch.minute ?? 1) * 60000;
    let t = Math.ceil((nowMs + 1000) / intervalMs) * intervalMs;
    while (t < toMs && fires.length < 120) {
      fires.push(t);
      t += intervalMs;
    }
  } else if (type === 'interval_hourly' || type === 'interval_minutes') {
    const intervalMs =
      type === 'interval_hourly' ? (sch.hours ?? 1) * 3600000 : (sch.minutes ?? 30) * 60000;
    const startH = sch.start_hour ?? 0;
    const startMn = sch.start_minute ?? 0;
    const endH = sch.end_hour;
    const endMn = sch.end_minute;
    const hasEnd = endH != null && endMn != null;
    const todayEndMs = hasEnd ? beirutDayAt(nowMs, endH, endMn) : null;
    if (hasEnd && nowMs >= todayEndMs) return fires;
    const maxOffset = hasEnd ? 0 : 1;
    for (let dayOffset = 0; dayOffset <= maxOffset; dayOffset++) {
      const anchorMs = beirutDayAt(nowMs + dayOffset * 86400000, startH, startMn);
      let t =
        anchorMs <= nowMs
          ? anchorMs + Math.ceil((nowMs - anchorMs + 1) / intervalMs) * intervalMs
          : anchorMs;
      while (t < toMs) {
        if (hasEnd && t > todayEndMs) break;
        fires.push(t);
        t += intervalMs;
      }
    }
  } else if (type === 'speeches_interval') {
    let t = Math.ceil((nowMs + 1000) / 60000) * 60000;
    for (let i = 0; i < 5 && t < toMs; i++, t += 60000) fires.push(t);
  }

  return [...new Set(fires)].sort((a, b) => a - b);
}

// ────────────────────────────────────────────────────────────────────────────
// Formatters
// ────────────────────────────────────────────────────────────────────────────

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

export function fmtBeirutTime(ms) {
  return new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: BEIRUT_TZ,
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function fmtBeirutDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', {
    timeZone: BEIRUT_TZ,
    weekday: 'short',
    day: '2-digit',
    month: 'short'
  });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ────────────────────────────────────────────────────────────────────────────

// Stop-words used by Unclassified "Group by words" view (Latin + Arabic).
export const UNCL_STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it',
  'was','are','be','been','has','had','have','do','does','did','will','would','could','should',
  'may','can','this','that','these','those','not','no','so','if','as','its','he','she','they',
  'we','you','i','my','your','his','her','our','their','me','him','us','them','what','which',
  'who','whom','when','where','how','why','all','each','every','both','few','more','most',
  'other','some','such','than','too','very','just','about','above','after','again','also',
  'any','because','before','between','during','into','only','over','same','then','through',
  'under','until','up','while','out','new','one','two','said','says','being',
  'get','got','still','back','much','even','well','here','there','now','via','per','المزيد',
  'من','في','على','إلى','عن','مع','هذا',' هذه','التي','الذي','ان','أن','لا','ما','هو','هي',
  'كان','بين','بعد','قبل','حتى','عند','ذلك','أو','ولا','كل','غير','بل','لم','ثم','إن',
  'يتم','تم','لن','قد','منذ','خلال','حول','ضد','نحو','عبر','أي','لها','له','لهم','التى',
  'وفي','وقد','يوم','أنه','تلك','هؤلاء','الى','وهو','أكثر','فيها','فيه','وعلى','ومن'
]);

// Returns top-N most-frequent tokens across messages (count 2+).
export function extractCommonWords(messages, topN = 30) {
  const freq = {};
  for (const m of messages) {
    const text = (m.preview || '').toLowerCase();
    const words = text.split(/[\s\p{P}\p{S}\d]+/u).filter((w) => w.length > 2);
    const seen = new Set();
    for (const w of words) {
      if (UNCL_STOP_WORDS.has(w) || w.length > 40) continue;
      if (!seen.has(w)) {
        seen.add(w);
        freq[w] = (freq[w] || 0) + 1;
      }
    }
  }
  return Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
}

// Splits a comma-separated string into tag chips (used by the messages tab).
// Returns null when there are no tags so the caller can render a placeholder.
export function splitTags(str) {
  if (!str) return null;
  const tags = String(str)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? tags : null;
}
