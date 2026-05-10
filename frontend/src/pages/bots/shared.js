/**
 * Shared helpers for the Bots page family (BotsPage / BotList / BotDetail and
 * its sub-sections).
 *
 * Conventions for owner-scoped mutations:
 *   - Most /api/bot/* and /api/topic/* endpoints accept the *current* request
 *     user's identity from the JWT — the frontend never has to send owner_id
 *     itself; the backend resolves it from the token. So this file's helpers
 *     are mostly about config lookup and small formatting utilities, NOT auth.
 */

/**
 * Build a complete bot save payload from a partial set of overrides.
 * The legacy code repeatedly constructed this exact object before calling
 * /api/bot/save to avoid clobbering omitted keys server-side. We preserve that
 * defensive pattern.
 */
export function buildFullBotSavePayload(botName, bot, overrides = {}) {
  return {
    name: botName,
    enabled: overrides.enabled ?? bot?.enabled ?? true,
    collections: overrides.collections ?? bot?.collections ?? [],
    minimum_messages: overrides.minimum_messages ?? bot?.minimum_messages ?? 5,
    rules: overrides.rules ?? bot?.rules ?? { remove: [], replace: [] },
    default_schedules: overrides.default_schedules ?? bot?.default_schedules ?? [],
    categories: overrides.categories ?? bot?.categories ?? {}
  };
}

/**
 * Look up a bot by name from the global config blob, returning `null` when
 * the requested name is missing.
 */
export function lookupBot(config, botName) {
  if (!config || !botName) return null;
  const bots = config.bots || {};
  return bots[botName] || null;
}

/**
 * Render a small formatted spec for a default schedule (mirrors the legacy
 * scheduleSpec / scheduleIcon helpers). Used by the Default Schedules UI in
 * Basic Settings — Agent B will replace this with the full schedule editor,
 * but the read-only chip needs a stable formatter.
 */
export function scheduleIcon(s) {
  if (!s) return '⏰';
  const t = s.type;
  if (t === 'minute') return '⏱️';
  if (t === 'hourly') return '🕐';
  if (t === 'daily') return '📅';
  if (t === 'interval' || t === 'interval_minutes' || t === 'interval_hourly') return '🔁';
  if (t === 'speeches_interval') return '🗣️';
  return '⏰';
}

export function scheduleSpec(s) {
  if (!s) return '';
  const t = s.type;
  if (t === 'minute') return `every ${s.minute || 0}m`;
  if (t === 'hourly') return `:${String(s.minute || 0).padStart(2, '0')}`;
  if (t === 'daily') {
    const h = String(s.hour ?? 0).padStart(2, '0');
    const m = String(s.minute ?? 0).padStart(2, '0');
    return `${h}:${m}`;
  }
  if (t === 'interval_minutes') {
    const sh = String(s.start_hour ?? 0).padStart(2, '0');
    const sm = String(s.start_minute ?? 0).padStart(2, '0');
    let suffix = '';
    if (s.end_hour !== undefined) {
      const eh = String(s.end_hour).padStart(2, '0');
      const em = String(s.end_minute ?? 0).padStart(2, '0');
      suffix = ` → ${eh}:${em}`;
    }
    return `every ${s.minutes || 30}m from ${sh}:${sm}${suffix}`;
  }
  if (t === 'interval_hourly' || t === 'interval') {
    const sh = String(s.start_hour ?? 0).padStart(2, '0');
    const sm = String(s.start_minute ?? 0).padStart(2, '0');
    let suffix = '';
    if (s.end_hour !== undefined) {
      const eh = String(s.end_hour).padStart(2, '0');
      const em = String(s.end_minute ?? 0).padStart(2, '0');
      suffix = ` → ${eh}:${em}`;
    }
    return `every ${s.hours || 1}h from ${sh}:${sm}${suffix}`;
  }
  if (t === 'speeches_interval') return `wait ${s.wait_time || 5}m`;
  return t || '';
}

/**
 * Long-form schedule formatter (matches legacy `formatSchedule()` in
 * bots-topics.js). Used in the schedule list cards inside a topic's body.
 */
export function formatScheduleLong(schedule) {
  if (!schedule) return 'Not set';
  const type = schedule.type;
  if (type === 'minute') return `Every ${schedule.minute || 1} minute(s)`;
  if (type === 'hourly')
    return `Hourly at :${String(schedule.minute || 0).padStart(2, '0')}`;
  if (type === 'interval_minutes' || type === 'interval_hourly') {
    const sh = String(schedule.start_hour ?? 0).padStart(2, '0');
    const sm = String(schedule.start_minute ?? 0).padStart(2, '0');
    let endPart = '';
    if (schedule.end_hour != null && schedule.end_minute != null) {
      const startMins = (schedule.start_hour ?? 0) * 60 + (schedule.start_minute ?? 0);
      const endMins = schedule.end_hour * 60 + schedule.end_minute;
      const tag = endMins < startMins ? ' (+1d)' : '';
      endPart = ` → ${String(schedule.end_hour).padStart(2, '0')}:${String(
        schedule.end_minute
      ).padStart(2, '0')}${tag}`;
    }
    if (type === 'interval_minutes')
      return `Every ${schedule.minutes || 30}min — starts ${sh}:${sm}${endPart}`;
    return `Every ${schedule.hours || 1}h — starts ${sh}:${sm}${endPart}`;
  }
  if (type === 'daily')
    return `Daily at ${String(schedule.hour || 0).padStart(2, '0')}:${String(
      schedule.minute || 0
    ).padStart(2, '0')}`;
  if (type === 'speeches_interval')
    return `Speeches — every 1min check — send after ${schedule.wait_time || 5}m idle`;
  return type || '';
}

/**
 * Build a flat schedule object from the field-by-field state of either the
 * Add or Edit schedule modals. Mirrors the field-collection logic in legacy
 * `saveTopicSchedule` / `saveEditedSchedule` / `saveDefaultSchedule`.
 *
 * `endHourBlankIsNull` controls how blank end_* fields are handled:
 *   - true  (edit mode)  → emit `end_hour: null`
 *   - false (add mode)   → omit end_hour entirely
 */
export function buildScheduleFromForm(form, { endHourBlankIsNull = false } = {}) {
  const t = form.type;
  const out = {
    name: (form.name || '').trim(),
    type: t,
    prompt_key: form.prompt_key || '',
    header: form.header || '',
    header_datetime: !!form.header_datetime,
    header_date_arabic: !!form.header_date_arabic,
    header_time_arabic: !!form.header_time_arabic,
    header_datetime_offset: Number(form.header_datetime_offset) || 0,
    telegram_targets: (form.telegram_targets || []).filter(Boolean),
    bullet_points: !!form.bullet_points,
    bullet_points_count: parseInt(form.bullet_points_count, 10) || 10
  };

  if (t === 'minute' || t === 'hourly') {
    out.minute = Number(form.minute) || 0;
  } else if (t === 'interval_minutes') {
    out.minutes = Number(form.minutes) || 30;
    out.start_hour = Number(form.start_hour) || 0;
    out.start_minute = Number(form.start_minute) || 0;
    const eh = form.end_hour;
    const em = form.end_minute;
    const ehFilled = eh !== '' && eh != null;
    if (ehFilled) {
      out.end_hour = Number(eh);
      out.end_minute = em !== '' && em != null ? Number(em) : 0;
    } else if (endHourBlankIsNull) {
      out.end_hour = null;
      out.end_minute = null;
    }
  } else if (t === 'interval_hourly') {
    out.hours = Number(form.hours) || 3;
    out.start_hour = Number(form.start_hour) || 0;
    out.start_minute = Number(form.start_minute) || 0;
    const eh = form.end_hour;
    const em = form.end_minute;
    const ehFilled = eh !== '' && eh != null;
    if (ehFilled) {
      out.end_hour = Number(eh);
      out.end_minute = em !== '' && em != null ? Number(em) : 0;
    } else if (endHourBlankIsNull) {
      out.end_hour = null;
      out.end_minute = null;
    }
  } else if (t === 'daily') {
    out.hour = Number(form.hour) || 0;
    out.minute = Number(form.minute) || 0;
  } else if (t === 'speeches_interval') {
    out.wait_time = Number(form.wait_time) || 5;
  }
  return out;
}

/**
 * Default form state for the schedule modals — used by both Add and Edit when
 * we initialise from scratch or from an existing schedule.
 */
export function emptyScheduleForm(type = 'hourly') {
  return {
    name: '',
    type,
    prompt_key: '',
    header: '',
    header_datetime: false,
    header_date_arabic: false,
    header_time_arabic: false,
    header_datetime_offset: 0,
    telegram_targets: [],
    bullet_points: false,
    bullet_points_count: 10,

    // type-specific defaults — all fields rendered conditionally so unused
    // entries are simply ignored by buildScheduleFromForm.
    minute: 0,
    minutes: 30,
    hours: 3,
    hour: 18,
    start_hour: 0,
    start_minute: 0,
    end_hour: '',
    end_minute: '',
    wait_time: 5
  };
}

export function scheduleFormFromExisting(s) {
  return {
    name: s.name || '',
    type: s.type || 'hourly',
    prompt_key: s.prompt_key || '',
    header: s.header || '',
    header_datetime: !!s.header_datetime,
    header_date_arabic: !!s.header_date_arabic,
    header_time_arabic: !!s.header_time_arabic,
    header_datetime_offset: s.header_datetime_offset ?? 0,
    telegram_targets: [...(s.telegram_targets || [])],
    bullet_points: !!s.bullet_points,
    bullet_points_count: s.bullet_points_count ?? 10,

    minute: s.minute ?? 0,
    minutes: s.minutes ?? 30,
    hours: s.hours ?? 3,
    hour: s.hour ?? 18,
    start_hour: s.start_hour ?? 0,
    start_minute: s.start_minute ?? 0,
    end_hour: s.end_hour != null ? s.end_hour : '',
    end_minute: s.end_minute != null ? s.end_minute : '',
    wait_time: s.wait_time ?? 5
  };
}

/**
 * Apply a default-schedule object to a topic-schedule form (used by the
 * "Load from default" picker). Replaces `{topic_name}` with empty string in
 * name/header — mirrors legacy `applyDefaultScheduleToForm`.
 */
export function applyDefaultToForm(ds) {
  const next = scheduleFormFromExisting(ds);
  next.name = (ds.name || '').replace(/\{topic_name\}/g, '');
  next.header = (ds.header || '').replace(/\{topic_name\}/g, '');
  return next;
}

