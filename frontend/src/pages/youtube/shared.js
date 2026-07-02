/**
 * Shared helpers for the YouTube section (Channels / Keywords / Videos pages).
 *
 * Mirrors the small utilities that live at the bottom of static/js/youtube.js
 * (timeAgo, _parseCommaSep, _kwScheduleToFields, _kwFieldsToIntervalMinutes).
 */

export const LANG_OPTIONS = [
  { value: '',   label: 'Any' },
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'Arabic' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ru', label: 'Russian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'hi', label: 'Hindi' },
  { value: 'tr', label: 'Turkish' }
];

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function parseCommaSep(val) {
  return (val || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Format a duration in seconds as H:MM:SS or M:SS. Returns '—' when unknown. */
export function formatDuration(secs) {
  const s = Number(secs);
  if (!s || s <= 0 || isNaN(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function kwScheduleToFields(intervalMinutes) {
  if (!intervalMinutes) return { val: '', unit: 'hours' };
  if (intervalMinutes >= 1440 && intervalMinutes % 1440 === 0) {
    return { val: intervalMinutes / 1440, unit: 'days' };
  }
  if (intervalMinutes >= 60 && intervalMinutes % 60 === 0) {
    return { val: intervalMinutes / 60, unit: 'hours' };
  }
  return { val: intervalMinutes, unit: 'minutes' };
}

export function kwFieldsToIntervalMinutes(val, unit) {
  const v = parseInt(val, 10);
  if (!v || v <= 0) return null;
  if (unit === 'days') return v * 1440;
  if (unit === 'hours') return v * 60;
  return v;
}

export function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

/** Estimate cost for a "done" video row. Returns { costStr, tip } or null. */
export function estimateCost(item) {
  if (item.status !== 'done') return null;
  let inp = item.input_tokens || 0;
  const out = item.output_tokens || 0;
  if (!inp && item.transcript_source === 'gemini_video' && item.duration_secs) {
    inp = Math.round(item.duration_secs * 299);
  }
  if (!inp && !out) return null;
  const cost = (inp / 1_000_000) * 0.10 + (out / 1_000_000) * 0.40;
  const costStr = cost < 0.000001 ? '<$0.000001' : '$' + cost.toFixed(6);
  const tip = `In: ${inp.toLocaleString()} · Out: ${out.toLocaleString()} tokens`;
  return { costStr, tip };
}
