// ==================== Bots — Default & Topic Schedule Management ====================
(function () {
    // ==================== Default Schedule Management ====================
    function openDefaultScheduleModal(botName) {
        const botPrompts = globalPrompts[botName] || {};
        const promptOptions = Object.keys(botPrompts).length
            ? Object.keys(botPrompts).map(key => `<option value="${key}">${key}</option>`).join('')
            : '<option value="">No prompts defined</option>';

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'default-schedule-modal';
        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <h3>Add Default Schedule</h3>
                    <button class="btn-icon" onclick="closeModal('default-schedule-modal')">×</button>
                </div>
                <div class="modal-body">
                    <small class="text-muted d-block mb-2">This schedule template will be auto-created on every new topic. Use <code>{topic_name}</code> in name/header to insert the topic name.</small>
                    <div class="form-group">
                        <label class="form-label">Schedule Name</label>
                        <input type="text" class="input" id="ds-name" value="{topic_name}" placeholder="{topic_name}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Type</label>
                        <select class="select" id="ds-type" onchange="updateDsInputs()">
                            <option value="minute">Minute</option>
                            <option value="hourly">Hourly</option>
                            <option value="interval_minutes">Interval (Minutes)</option>
                            <option value="interval_hourly">Interval (Hours)</option>
                            <option value="daily">Daily</option>
                            <option value="speeches_interval">Speeches Interval</option>
                        </select>
                    </div>
                    <div id="ds-type-inputs"></div>
                    <div class="form-group">
                        <label class="form-label">Prompt</label>
                        <select class="select" id="ds-prompt">${promptOptions}</select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Header</label>
                        <input type="text" class="input" id="ds-header" value="*{topic_name}*" placeholder="*{topic_name}*">
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-header-datetime" onchange="toggleSchDatetimeOptions('ds')">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Show date & time in header</span>
                    </div>
                    <div id="ds-datetime-opts" style="display:none;padding-left:16px;">
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="ds-date-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Date in Arabic numerals</span>
                        </div>
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="ds-time-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Time in Arabic numerals</span>
                        </div>
                        <div class="form-group" style="margin-top:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <label class="form-label" style="margin:0;width:110px;flex-shrink:0;">Time offset</label>
                                <input type="number" class="input" id="ds-datetime-offset" value="0" style="width:90px;">
                                <span class="text-muted" style="font-size:12px;">min (+ = later, − = earlier)</span>
                            </div>
                            <small class="text-muted">Shift the displayed time in the header by this many minutes.</small>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Telegram Targets (optional)</label>
                        <div class="tags-container" id="ds-tg-targets"></div>
                        <input type="text" class="input mt-1" id="ds-tg-input"
                               placeholder="@channel or chat ID — press Enter to add"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('ds');}">
                        <small class="text-muted sch-tg-hint" id="ds-tg-hint">Leave empty to use collection targets.</small>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('default-schedule-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="saveDefaultSchedule('${botName}')">Add</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        updateDsInputs();
    }

    function updateDsInputs() {
        const type = document.getElementById('ds-type')?.value;
        const container = document.getElementById('ds-type-inputs');
        if (!container) return;
        if (type === 'minute') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Every N Minutes</label>
                <input type="number" class="input" id="ds-minute" min="1" max="59" value="30"></div>`;
        } else if (type === 'hourly') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Minute</label>
                <input type="number" class="input" id="ds-minute" min="0" max="59" value="0"></div>`;
        } else if (type === 'interval_minutes') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Every N Minutes</label>
                <input type="number" class="input" id="ds-minutes" min="1" value="30">
                <div class="form-group"><label class="form-label">Starting at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
                </div>
                </div>
                <div class="form-group"><label class="form-label">Ends at (HH : MM) — leave blank for indefinite</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="ds-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="ds-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at start time, then every X minutes within the window</small>
            </div>`;
        } else if (type === 'interval_hourly') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Every X Hours</label>
                <input type="number" class="input" id="ds-hours" min="1" max="24" value="3">
                <div class="form-group"><label class="form-label">Starting at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="ds-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="ds-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
                </div>
                </div>
                <div class="form-group"><label class="form-label">Ends at (HH : MM) — leave blank for indefinite</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="ds-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="ds-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">First run at start time, then every X hours within the window</small>
            </div>`;
        } else if (type === 'daily') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Hour</label>
                <input type="number" class="input" id="ds-hour" min="0" max="23" value="18">
                <div class="form-group"><label class="form-label">Minute</label>
                <input type="number" class="input" id="ds-minute" min="0" max="59" value="0">
            </div>`;
        } else if (type === 'speeches_interval') {
            container.innerHTML = `<div class="form-group"><label class="form-label">Wait Time (mins) — send buckets when idle</label>
                <input type="number" class="input" id="ds-wait-time" min="1" value="5">
                <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code> on its own line.</small>`;
        } else {
            container.innerHTML = '';
        }
    }

    async function saveDefaultSchedule(botName) {
        const name = document.getElementById('ds-name')?.value.trim();
        const type = document.getElementById('ds-type')?.value;
        const prompt_key = document.getElementById('ds-prompt')?.value;
        if (!name) { showAlert('Please enter a schedule name', { icon: '✏️' }); return; }

        const ds = {
            name, type, prompt_key, enabled: true,
            header: document.getElementById('ds-header')?.value || `*${name}*`,
            header_datetime: document.getElementById('ds-header-datetime')?.checked || false,
            header_date_arabic: document.getElementById('ds-date-arabic')?.checked || false,
            header_time_arabic: document.getElementById('ds-time-arabic')?.checked || false,
            header_datetime_offset: Number(document.getElementById('ds-datetime-offset')?.value || 0),
            telegram_targets: getSchTgTargets('ds'),
        };

        if (type === 'minute' || type === 'hourly') ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
        if (type === 'interval_minutes') {
            ds.minutes = Number(document.getElementById('ds-minutes')?.value || 30);
            ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
            ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
            const eh = document.getElementById('ds-end-hour')?.value;
            const em = document.getElementById('ds-end-minute')?.value;
            if (eh !== '') { ds.end_hour = Number(eh); ds.end_minute = em !== '' ? Number(em) : 0; }
        }
        if (type === 'interval_hourly') {
            ds.hours = Number(document.getElementById('ds-hours')?.value || 3);
            ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
            ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
            const eh = document.getElementById('ds-end-hour')?.value;
            const em = document.getElementById('ds-end-minute')?.value;
            if (eh !== '') { ds.end_hour = Number(eh); ds.end_minute = em !== '' ? Number(em) : 0; }
        }
        if (type === 'daily') {
            ds.hour = Number(document.getElementById('ds-hour')?.value || 0);
            ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
        }
        if (type === 'speeches_interval') {
            ds.wait_time = Number(document.getElementById('ds-wait-time')?.value || 5);
        }

        const bot = globalConfig.bots[botName];
        if (!bot.default_schedules) bot.default_schedules = [];
        bot.default_schedules.push(ds);

        await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
        closeModal('default-schedule-modal');
        await loadAllData();
        renderBotsPage();
    }

    async function removeDefaultSchedule(botName, index) {
        showConfirm('Remove this default schedule?', async () => {
            const bot = globalConfig.bots[botName];
            bot.default_schedules.splice(index, 1);
            await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
            await loadAllData();
            renderBotsPage();
        }, { title: 'Remove Default Schedule' });
    }

    function editDefaultSchedule(botName, idx) {
        const bot = globalConfig.bots[botName];
        if (!bot || !bot.default_schedules) return;
        const ds = bot.default_schedules[idx];
        if (!ds) return;

        const botPrompts = globalPrompts[botName] || {};
        const promptOptions = Object.keys(botPrompts).length
            ? Object.keys(botPrompts).map(key => `<option value="${key}">${key}</option>`).join('')
            : '<option value="">No prompts defined</option>';

        const existingModal = document.getElementById('default-schedule-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'default-schedule-modal';
        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <h3>Edit Default Schedule</h3>
                    <button class="btn-icon" onclick="closeModal('default-schedule-modal')">×</button>
                </div>
                <div class="modal-body">
                    <small class="text-muted d-block mb-2">This schedule template will be auto-created on every new topic. Use <code>{topic_name}</code> in name/header to insert the topic name.</small>
                    <div class="form-group">
                        <label class="form-label">Schedule Name</label>
                        <input type="text" class="input" id="ds-name" placeholder="{topic_name}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Type</label>
                        <select class="select" id="ds-type" onchange="updateDsInputs()">
                            <option value="minute">Minute</option>
                            <option value="hourly">Hourly</option>
                            <option value="interval_minutes">Interval (Minutes)</option>
                            <option value="interval_hourly">Interval (Hours)</option>
                            <option value="daily">Daily</option>
                            <option value="speeches_interval">Speeches Interval</option>
                        </select>
                    </div>
                    <div id="ds-type-inputs"></div>
                    <div class="form-group">
                        <label class="form-label">Prompt</label>
                        <select class="select" id="ds-prompt">${promptOptions}</select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Header</label>
                        <input type="text" class="input" id="ds-header" placeholder="*{topic_name}*">
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ds-header-datetime" onchange="toggleSchDatetimeOptions('ds')">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Show date & time in header</span>
                    </div>
                    <div id="ds-datetime-opts" style="display:none;padding-left:16px;">
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="ds-date-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Date in Arabic numerals</span>
                        </div>
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="ds-time-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Time in Arabic numerals</span>
                        </div>
                        <div class="form-group" style="margin-top:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <label class="form-label" style="margin:0;width:110px;flex-shrink:0;">Time offset</label>
                                <input type="number" class="input" id="ds-datetime-offset" value="0" style="width:90px;">
                                <span class="text-muted" style="font-size:12px;">min (+ = later, − = earlier)</span>
                            </div>
                            <small class="text-muted">Shift the displayed time in the header by this many minutes.</small>
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Telegram Targets (optional)</label>
                        <div class="tags-container" id="ds-tg-targets"></div>
                        <input type="text" class="input mt-1" id="ds-tg-input"
                               placeholder="@channel or chat ID — press Enter to add"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('ds');}">
                        <small class="text-muted sch-tg-hint" id="ds-tg-hint">Leave empty to use collection targets.</small>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('default-schedule-modal')">Cancel</button>
                    <button class="btn btn-primary" onclick="saveEditedDefaultSchedule('${botName}', ${idx})">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Pre-fill type and render type-specific inputs first
        const typeSelect = document.getElementById('ds-type');
        if (typeSelect) typeSelect.value = ds.type || 'daily';
        updateDsInputs();

        // Pre-fill type-specific numeric fields
        if (ds.type === 'minute' || ds.type === 'hourly') {
            const el = document.getElementById('ds-minute');
            if (el) el.value = ds.minute ?? 0;
        } else if (ds.type === 'interval_minutes') {
            const el = document.getElementById('ds-minutes');
            if (el) el.value = ds.minutes ?? 30;
            const sh = document.getElementById('ds-start-hour');
            if (sh) sh.value = ds.start_hour ?? 0;
            const sm = document.getElementById('ds-start-minute');
            if (sm) sm.value = ds.start_minute ?? 0;
            const eh = document.getElementById('ds-end-hour');
            if (eh && ds.end_hour != null) eh.value = ds.end_hour;
            const em = document.getElementById('ds-end-minute');
            if (em && ds.end_minute != null) em.value = ds.end_minute;
        } else if (ds.type === 'interval_hourly') {
            const el = document.getElementById('ds-hours');
            if (el) el.value = ds.hours ?? 3;
            const sh = document.getElementById('ds-start-hour');
            if (sh) sh.value = ds.start_hour ?? 0;
            const sm = document.getElementById('ds-start-minute');
            if (sm) sm.value = ds.start_minute ?? 0;
            const eh = document.getElementById('ds-end-hour');
            if (eh && ds.end_hour != null) eh.value = ds.end_hour;
            const em = document.getElementById('ds-end-minute');
            if (em && ds.end_minute != null) em.value = ds.end_minute;
        } else if (ds.type === 'daily') {
            const h = document.getElementById('ds-hour');
            if (h) h.value = ds.hour ?? 18;
            const m = document.getElementById('ds-minute');
            if (m) m.value = ds.minute ?? 0;
        } else if (ds.type === 'speeches_interval') {
            const el = document.getElementById('ds-wait-time');
            if (el) el.value = ds.wait_time ?? 5;
        }

        // Pre-fill remaining fields
        const nameEl = document.getElementById('ds-name');
        if (nameEl) nameEl.value = ds.name || '';

        const promptEl = document.getElementById('ds-prompt');
        if (promptEl && ds.prompt_key) promptEl.value = ds.prompt_key;

        const headerEl = document.getElementById('ds-header');
        if (headerEl) headerEl.value = ds.header || '';

        const dtCheck = document.getElementById('ds-header-datetime');
        if (dtCheck && ds.header_datetime) {
            dtCheck.checked = true;
            toggleSchDatetimeOptions('ds');
            const dateAr = document.getElementById('ds-date-arabic');
            if (dateAr) dateAr.checked = !!ds.header_date_arabic;
            const timeAr = document.getElementById('ds-time-arabic');
            if (timeAr) timeAr.checked = !!ds.header_time_arabic;
            const offsetEl = document.getElementById('ds-datetime-offset');
            if (offsetEl) offsetEl.value = ds.header_datetime_offset ?? 0;
        }

        // Pre-fill telegram targets
        const tgInput = document.getElementById('ds-tg-input');
        (ds.telegram_targets || []).forEach(t => {
            if (t && tgInput) { tgInput.value = t; addSchTgTarget('ds'); }
        });
    }

    async function saveEditedDefaultSchedule(botName, idx) {
        const name = document.getElementById('ds-name')?.value.trim();
        const type = document.getElementById('ds-type')?.value;
        const prompt_key = document.getElementById('ds-prompt')?.value;
        if (!name) { showAlert('Please enter a schedule name', { icon: '✏️' }); return; }

        const ds = {
            name, type, prompt_key, enabled: true,
            header: document.getElementById('ds-header')?.value || `*${name}*`,
            header_datetime: document.getElementById('ds-header-datetime')?.checked || false,
            header_date_arabic: document.getElementById('ds-date-arabic')?.checked || false,
            header_time_arabic: document.getElementById('ds-time-arabic')?.checked || false,
            header_datetime_offset: Number(document.getElementById('ds-datetime-offset')?.value || 0),
            telegram_targets: getSchTgTargets('ds'),
        };

        if (type === 'minute' || type === 'hourly') ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
        if (type === 'interval_minutes') {
            ds.minutes = Number(document.getElementById('ds-minutes')?.value || 30);
            ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
            ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
            const eh = document.getElementById('ds-end-hour')?.value;
            const em = document.getElementById('ds-end-minute')?.value;
            ds.end_hour   = eh !== '' && eh != null ? Number(eh) : null;
            ds.end_minute = eh !== '' && eh != null ? (em !== '' ? Number(em) : 0) : null;
        }
        if (type === 'interval_hourly') {
            ds.hours = Number(document.getElementById('ds-hours')?.value || 3);
            ds.start_hour = Number(document.getElementById('ds-start-hour')?.value || 0);
            ds.start_minute = Number(document.getElementById('ds-start-minute')?.value || 0);
            const eh = document.getElementById('ds-end-hour')?.value;
            const em = document.getElementById('ds-end-minute')?.value;
            ds.end_hour   = eh !== '' && eh != null ? Number(eh) : null;
            ds.end_minute = eh !== '' && eh != null ? (em !== '' ? Number(em) : 0) : null;
        }
        if (type === 'daily') {
            ds.hour = Number(document.getElementById('ds-hour')?.value || 0);
            ds.minute = Number(document.getElementById('ds-minute')?.value || 0);
        }
        if (type === 'speeches_interval') {
            ds.wait_time = Number(document.getElementById('ds-wait-time')?.value || 5);
        }

        const bot = globalConfig.bots[botName];
        if (!bot || !bot.default_schedules) return;
        bot.default_schedules[idx] = ds;

        await updateBotSetting(botName, 'default_schedules', bot.default_schedules);
        closeModal('default-schedule-modal');
        await loadAllData();
        renderBotsPage();
    }


    // ==================== Topic Schedule Management ====================
    function _toggleBulletPtsField(cb, wrapId) {
        const wrap = document.getElementById(wrapId);
        if (wrap) wrap.style.display = cb.checked ? 'flex' : 'none';
    }

    function openAddTopicScheduleModal(botName, categoryName, topicName) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'topic-schedule-modal';

        // Get bot-specific prompts
        const botPrompts = (globalPrompts && globalPrompts[botName]) || {};

        // Build "Load from defaults" picker
        const defaultSchedules = (globalConfig.bots?.[botName]?.default_schedules || []);
        const defaultsHtml = defaultSchedules.length ? `
            <div class="form-group" style="background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:10px 14px;">
                <label class="form-label" style="margin-bottom:6px;">Load from default schedule</label>
                <div style="display:flex;gap:8px;">
                    <select class="select" id="topic-sch-from-default" style="flex:1;">
                        <option value="">— pick a default —</option>
                        ${defaultSchedules.map((ds, i) => `<option value="${i}">${escapeHtml(ds.name || ds.type)}</option>`).join('')}
                    </select>
                    <button class="btn btn-secondary btn-sm" type="button" onclick="applyDefaultScheduleToForm('${jsAttr(botName)}')">Apply</button>
                </div>
            </div>` : '';

        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <h3>Add Schedule to ${topicName}</h3>
                    <button class="btn-icon" onclick="closeModal('topic-schedule-modal')">×</button>
                </div>
                <div class="modal-body">
                    ${defaultsHtml}
                    <div class="form-group">
                        <label class="form-label">Schedule Name</label>
                        <input type="text" class="input" id="topic-schedule-name" placeholder="e.g., Hourly Updates">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Schedule Type</label>
                        <select class="select" id="topic-schedule-type" onchange="updateTopicScheduleInputs()">
                            <option value="minute">Every Minute</option>
                            <option value="hourly" selected>Hourly</option>
                            <option value="interval_minutes">Every X Minutes</option>
                            <option value="interval_hourly">Every X Hours</option>
                            <option value="daily">Daily</option>
                            <option value="speeches_interval">Speeches Interval</option>
                        </select>
                    </div>
                    <div class="form-group" id="topic-schedule-inputs">
                        <label class="form-label">Minute</label>
                        <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Prompt</label>
                        <select class="select" id="topic-schedule-prompt">
                            ${Object.keys(botPrompts).map(key => `
                                <option value="${key}">${key}</option>
                            `).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Header</label>
                        <input type="text" class="input" id="topic-schedule-header" placeholder="**Schedule Name**">
                        <small class="text-muted">Leave empty to use *schedule name* as header. Clear completely to send without header.</small>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="topic-schedule-header-datetime" onchange="toggleSchDatetimeOptions('topic-schedule')">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Show date & time in header</span>
                    </div>
                    <div id="topic-schedule-datetime-opts" style="display:none;padding-left:16px;">
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="topic-schedule-date-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Date in Arabic numerals (٢٠٢٦/٠٣/٢١)</span>
                        </div>
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="topic-schedule-time-arabic">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Time in Arabic numerals (٠٣:٠٩ م)</span>
                        </div>
                        <div class="form-group" style="margin-top:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <label class="form-label" style="margin:0;width:110px;flex-shrink:0;">Time offset</label>
                                <input type="number" class="input" id="topic-schedule-datetime-offset" value="0" style="width:90px;">
                                <span class="text-muted" style="font-size:12px;">min (+ = later, − = earlier)</span>
                            </div>
                            <small class="text-muted">Shift the displayed time in the header by this many minutes.</small>
                        </div>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;font-weight:500;">
                            <input type="checkbox" id="topic-schedule-bullet-pts"
                                   onchange="_toggleBulletPtsField(this,'topic-schedule-bullet-count-wrap')">
                            Bullet Points
                        </label>
                        <span id="topic-schedule-bullet-count-wrap" style="display:none;align-items:center;gap:6px">
                            <input type="number" class="input" id="topic-schedule-bullet-count" value="10" min="1" max="25" style="width:64px;padding:4px 8px">
                            <span style="font-size:12px;color:var(--text-muted)">points (interim batch auto-set to 26 − N)</span>
                        </span>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Telegram Targets (optional)</label>
                        <div class="tags-container" id="topic-schedule-tg-targets"></div>
                        <input type="text" class="input mt-1" id="topic-schedule-tg-input"
                               placeholder="@channel or chat ID — press Enter to add"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('topic-schedule');}">
                        <small class="text-muted sch-tg-hint" id="topic-schedule-tg-hint">Leave empty to use collection targets.</small>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('topic-schedule-modal')">Cancel</button>
                    <button class="btn btn-primary"
                            onclick="saveTopicSchedule('${botName}', '${categoryName}', '${topicName}')">Add</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    function applyDefaultScheduleToForm(botName) {
        const sel = document.getElementById('topic-sch-from-default');
        if (!sel || sel.value === '') return;
        const ds = globalConfig.bots?.[botName]?.default_schedules?.[Number(sel.value)];
        if (!ds) return;

        // Fill name (replace {topic_name} placeholder with empty for now)
        const nameEl = document.getElementById('topic-schedule-name');
        if (nameEl) nameEl.value = (ds.name || '').replace(/\{topic_name\}/g, '');

        // Set type and re-render type inputs
        const typeEl = document.getElementById('topic-schedule-type');
        if (typeEl) { typeEl.value = ds.type || 'hourly'; updateTopicScheduleInputs(); }

        // Fill type-specific fields
        if (ds.type === 'minute' || ds.type === 'hourly') {
            const m = document.getElementById('topic-schedule-minute'); if (m) m.value = ds.minute ?? 0;
        } else if (ds.type === 'interval_minutes') {
            const em = document.getElementById('topic-schedule-minutes'); if (em) em.value = ds.minutes ?? 30;
            const sh = document.getElementById('topic-schedule-start-hour'); if (sh) sh.value = ds.start_hour ?? 0;
            const sm = document.getElementById('topic-schedule-start-minute'); if (sm) sm.value = ds.start_minute ?? 0;
            const eh = document.getElementById('topic-schedule-end-hour'); if (eh && ds.end_hour != null) eh.value = ds.end_hour;
            const emin = document.getElementById('topic-schedule-end-minute'); if (emin && ds.end_minute != null) emin.value = ds.end_minute;
        } else if (ds.type === 'interval_hourly') {
            const hrs = document.getElementById('topic-schedule-hours'); if (hrs) hrs.value = ds.hours ?? 3;
            const sh = document.getElementById('topic-schedule-start-hour'); if (sh) sh.value = ds.start_hour ?? 0;
            const sm = document.getElementById('topic-schedule-start-minute'); if (sm) sm.value = ds.start_minute ?? 0;
            const eh = document.getElementById('topic-schedule-end-hour'); if (eh && ds.end_hour != null) eh.value = ds.end_hour;
            const emin = document.getElementById('topic-schedule-end-minute'); if (emin && ds.end_minute != null) emin.value = ds.end_minute;
        } else if (ds.type === 'daily') {
            const h = document.getElementById('topic-schedule-hour'); if (h) h.value = ds.hour ?? 18;
            const m = document.getElementById('topic-schedule-minute'); if (m) m.value = ds.minute ?? 0;
        } else if (ds.type === 'speeches_interval') {
            const w = document.getElementById('topic-schedule-wait-time'); if (w) w.value = ds.wait_time ?? 5;
        }

        // Fill header
        const headerEl = document.getElementById('topic-schedule-header');
        if (headerEl) headerEl.value = (ds.header || '').replace(/\{topic_name\}/g, '');

        // Fill prompt
        const promptEl = document.getElementById('topic-schedule-prompt');
        if (promptEl && ds.prompt_key) promptEl.value = ds.prompt_key;

        // Fill datetime options
        const dtCheck = document.getElementById('topic-schedule-header-datetime');
        if (dtCheck) {
            dtCheck.checked = !!ds.header_datetime;
            toggleSchDatetimeOptions('topic-schedule');
            const dateAr = document.getElementById('topic-schedule-date-arabic'); if (dateAr) dateAr.checked = !!ds.header_date_arabic;
            const timeAr = document.getElementById('topic-schedule-time-arabic'); if (timeAr) timeAr.checked = !!ds.header_time_arabic;
            const offset = document.getElementById('topic-schedule-datetime-offset'); if (offset) offset.value = ds.header_datetime_offset ?? 0;
        }
    }

    function updateTopicScheduleInputs() {
        const type = document.getElementById('topic-schedule-type').value;
        const container = document.getElementById('topic-schedule-inputs');

        if (type === 'minute') {
            container.innerHTML = `
                <label class="form-label">Every N Minutes</label>
                <input type="number" class="input" id="topic-schedule-minute" min="1" max="59" value="1">
            `;
        } else if (type === 'hourly') {
            container.innerHTML = `
                <label class="form-label">Minute</label>
                <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
            `;
        } else if (type === 'interval_minutes') {
            container.innerHTML = `
                <label class="form-label">Every X Minutes</label>
                <input type="number" class="input" id="topic-schedule-minutes" min="1" max="1440" value="30">
                <label class="form-label mt-1">Starts at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
                </div>
                <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="topic-schedule-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="topic-schedule-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">Fires every X minutes within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.</small>
            `;
        } else if (type === 'interval_hourly') {
            container.innerHTML = `
                <label class="form-label">Every X Hours</label>
                <input type="number" class="input" id="topic-schedule-hours" min="1" max="24" value="2">
                <label class="form-label mt-1">Starts at (HH : MM)</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="topic-schedule-start-hour" min="0" max="23" value="0" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="topic-schedule-start-minute" min="0" max="59" value="0" placeholder="MM" style="width:80px;">
                </div>
                <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                <div style="display:flex;gap:8px;">
                    <input type="number" class="input" id="topic-schedule-end-hour" min="0" max="23" placeholder="HH" style="width:80px;">
                    <input type="number" class="input" id="topic-schedule-end-minute" min="0" max="59" placeholder="MM" style="width:80px;">
                </div>
                <small class="text-muted">Fires every X hours within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.</small>
            `;
        } else if (type === 'daily') {
            container.innerHTML = `
                <label class="form-label">Hour</label>
                <input type="number" class="input" id="topic-schedule-hour" min="0" max="23" value="18">
                <label class="form-label mt-1">Minute</label>
                <input type="number" class="input" id="topic-schedule-minute" min="0" max="59" value="0">
            `;
        } else if (type === 'speeches_interval') {
            container.innerHTML = `
                <label class="form-label">Wait Time (mins) — send buckets when idle</label>
                <input type="number" class="input" id="topic-schedule-wait-time" min="1" value="5">
                <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code>.</small>`;
        }
    }

    async function saveTopicSchedule(botName, categoryName, topicName) {
        const name = document.getElementById('topic-schedule-name').value.trim();
        const type = document.getElementById('topic-schedule-type').value;
        const prompt_key = document.getElementById('topic-schedule-prompt').value;

        if (!name) {
            showAlert('Please enter a schedule name', { icon: '✏️' });
            return;
        }

        const header = document.getElementById('topic-schedule-header').value;
        const header_datetime = document.getElementById('topic-schedule-header-datetime').checked;
        const header_date_arabic = document.getElementById('topic-schedule-date-arabic').checked;
        const header_time_arabic = document.getElementById('topic-schedule-time-arabic').checked;
        const header_datetime_offset = Number(document.getElementById('topic-schedule-datetime-offset')?.value || 0);
        const telegram_targets = getSchTgTargets('topic-schedule');
        const bullet_points = document.getElementById('topic-schedule-bullet-pts')?.checked || false;
        const bullet_points_count = parseInt(document.getElementById('topic-schedule-bullet-count')?.value || '10', 10) || 10;
        const schedule = { name, type, prompt_key, header, header_datetime, header_date_arabic, header_time_arabic, header_datetime_offset, telegram_targets, bullet_points, bullet_points_count };

        if (type === 'minute') {
            schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
        } else if (type === 'hourly') {
            schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
        } else if (type === 'interval_minutes') {
            schedule.minutes      = Number(document.getElementById('topic-schedule-minutes').value);
            schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
            schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
            const ehM = document.getElementById('topic-schedule-end-hour').value;
            const emM = document.getElementById('topic-schedule-end-minute').value;
            if (ehM !== '') { schedule.end_hour = Number(ehM); schedule.end_minute = emM !== '' ? Number(emM) : 0; }
        } else if (type === 'interval_hourly') {
            schedule.hours        = Number(document.getElementById('topic-schedule-hours').value);
            schedule.start_hour   = Number(document.getElementById('topic-schedule-start-hour').value);
            schedule.start_minute = Number(document.getElementById('topic-schedule-start-minute').value);
            const ehI = document.getElementById('topic-schedule-end-hour').value;
            const emI = document.getElementById('topic-schedule-end-minute').value;
            if (ehI !== '') { schedule.end_hour = Number(ehI); schedule.end_minute = emI !== '' ? Number(emI) : 0; }
        } else if (type === 'daily') {
            schedule.hour   = Number(document.getElementById('topic-schedule-hour').value);
            schedule.minute = Number(document.getElementById('topic-schedule-minute').value);
        } else if (type === 'speeches_interval') {
            schedule.wait_time = Number(document.getElementById('topic-schedule-wait-time').value);
        }

        const result = await api('/api/topic/schedule/add', {
            bot_name: botName,
            category_name: categoryName,
            topic_name: topicName,
            schedule
        });

        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]); // Keep topic and category open
            closeModal('topic-schedule-modal');
            showNotification('Schedule added', 'success');
        } else {
            showNotification('Failed to add schedule', 'error');
        }
    }

    async function toggleTopicSchedule(botName, categoryName, topicName, scheduleId, enabled) {
        const result = await api('/api/topic/schedule/update', {
            schedule_id: scheduleId,
            schedule: { enabled }
        });

        if (result.status === 'ok') {
            await loadAllData();
            const topicId = `topic-${botName}-${categoryName}-${topicName}`;
            const categoryId = `categories-${botName}`;
            renderBotsPage([topicId, categoryId]);
            showNotification('Schedule updated', 'success');
        }
    }

    async function deleteTopicSchedule(botName, categoryName, topicName, scheduleId) {
        showConfirm('Delete this schedule?', async () => {
            const result = await api('/api/topic/schedule/delete', {
                schedule_id: scheduleId,
                bot_name: botName,
                category_name: categoryName,
                topic_name: topicName
            });

            if (result.status === 'ok') {
                await loadAllData();
                const topicId = `topic-${botName}-${categoryName}-${topicName}`;
                const categoryId = `categories-${botName}`;
                renderBotsPage([topicId, categoryId]);
                showNotification('Schedule deleted', 'success');
            }
        }, { title: 'Delete Schedule' });
    }

    // ==================== Schedule 3-dots Menu ====================
    function toggleSchMenu(e, btn) {
        e.stopPropagation();
        const dropdown = btn.nextElementSibling;
        const isOpen = dropdown.classList.contains('open');
        closeAllSchMenus();
        if (!isOpen) {
            // Show hidden first to measure dimensions, then position
            dropdown.style.visibility = 'hidden';
            dropdown.classList.add('open');
            const rect = btn.getBoundingClientRect();
            const dw   = dropdown.offsetWidth;
            const dh   = dropdown.offsetHeight;
            // Right-align with button; flip up if no room below
            const left     = Math.max(4, rect.right - dw);
            const topBelow = rect.bottom + 4;
            const topAbove = rect.top - dh - 4;
            const finalTop = (topBelow + dh > window.innerHeight) ? topAbove : topBelow;
            dropdown.style.top        = `${finalTop}px`;
            dropdown.style.left       = `${left}px`;
            dropdown.style.visibility = '';
        }
    }

    function closeAllSchMenus() {
        document.querySelectorAll('.sch-menu-dropdown.open').forEach(d => d.classList.remove('open'));
    }

    document.addEventListener('click', closeAllSchMenus);

    // ==================== Edit Schedule Modal ====================
    function toggleSchDatetimeOptions(prefix) {
        const checked = document.getElementById(`${prefix}-header-datetime`).checked;
        const opts = document.getElementById(`${prefix}-datetime-opts`);
        if (opts) opts.style.display = checked ? 'block' : 'none';
    }

    function addSchTgTarget(prefix) {
        const input = document.getElementById(`${prefix}-tg-input`);
        const container = document.getElementById(`${prefix}-tg-targets`);
        if (!input || !container) return;
        const val = input.value.trim();
        if (!val) return;
        // Check for duplicate
        const existing = [...container.querySelectorAll('.tag')].map(t => t.textContent.replace('×', '').trim());
        if (existing.includes(val)) { input.value = ''; return; }
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.innerHTML = `${escapeHtmlSys(val)}<span class="tag-remove" onclick="removeSchTgTarget('${prefix}', this)">×</span>`;
        container.appendChild(tag);
        input.value = '';
        _updateSchTgHint(prefix);
    }

    function removeSchTgTarget(prefix, el) {
        el.closest('.tag').remove();
        _updateSchTgHint(prefix);
    }

    function _updateSchTgHint(prefix) {
        const hint = document.getElementById(`${prefix}-tg-hint`);
        if (!hint) return;
        const container = document.getElementById(`${prefix}-tg-targets`);
        const hasTargets = container && container.querySelectorAll('.tag').length > 0;
        if (hasTargets) {
            hint.innerHTML = '⚠️ These targets <b>override</b> the collection target channels your bot is subscribed to.';
            hint.style.color = 'var(--warning)';
        } else {
            hint.textContent = 'Leave empty to use collection targets.';
            hint.style.color = '';
        }
    }

    function getSchTgTargets(prefix) {
        // Auto-add any text left in the input field (user typed but didn't press Enter)
        const input = document.getElementById(`${prefix}-tg-input`);
        if (input && input.value.trim()) {
            addSchTgTarget(prefix);
        }
        const container = document.getElementById(`${prefix}-tg-targets`);
        if (!container) return [];
        return [...container.querySelectorAll('.tag')].map(t => t.textContent.replace('×', '').trim()).filter(Boolean);
    }

    function openEditTopicScheduleModal(botName, categoryName, topicName, scheduleId) {
        const schedules = globalConfig.bots[botName]?.categories[categoryName]?.topics[topicName]?.schedules || [];
        const schedule = schedules.find(s => s.id === scheduleId);
        if (!schedule) return;

        const botPrompts = (globalPrompts && globalPrompts[botName]) || {};
        const existingModal = document.getElementById('topic-schedule-edit-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'topic-schedule-edit-modal';
        modal.dataset.botName = botName;
        modal.dataset.categoryName = categoryName;
        modal.dataset.topicName = topicName;

        const typeOptions = ['minute', 'hourly', 'interval_minutes', 'interval_hourly', 'daily', 'speeches_interval'];
        const typeLabels  = { minute: 'Every Minute', hourly: 'Hourly', interval_minutes: 'Every X Minutes', interval_hourly: 'Every X Hours', daily: 'Daily', speeches_interval: 'Speeches Interval' };

        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-header">
                    <h3>Edit Schedule — ${escapeHtmlSys(schedule.name)}</h3>
                    <button class="btn-icon" onclick="closeModal('topic-schedule-edit-modal')">×</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label">Schedule Name</label>
                        <input type="text" class="input" id="edit-sch-name" value="${escapeHtmlSys(schedule.name)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Schedule Type</label>
                        <select class="select" id="edit-sch-type" onchange="updateEditScheduleInputs()">
                            ${typeOptions.map(t => `<option value="${t}"${schedule.type === t ? ' selected' : ''}>${typeLabels[t]}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group" id="edit-sch-inputs">
                        ${buildEditScheduleInputs(schedule)}
                    </div>
                    <div class="form-group">
                        <label class="form-label">Prompt</label>
                        <select class="select" id="edit-sch-prompt">
                            ${Object.keys(botPrompts).map(key => `
                                <option value="${key}"${schedule.prompt_key === key ? ' selected' : ''}>${key}</option>`
                            ).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Header</label>
                        <input type="text" class="input" id="edit-sch-header" value="${escapeHtmlSys(schedule.header || `*${schedule.name}*`)}">
                        <small class="text-muted">Leave empty to send without header.</small>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                        <label class="toggle-switch">
                            <input type="checkbox" id="edit-sch-header-datetime" ${schedule.header_datetime ? 'checked' : ''} onchange="toggleSchDatetimeOptions('edit-sch')">
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="form-label" style="margin:0;">Show date & time in header</span>
                    </div>
                    <div id="edit-sch-datetime-opts" style="display:${schedule.header_datetime ? 'block' : 'none'};padding-left:16px;">
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="edit-sch-date-arabic" ${schedule.header_date_arabic ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Date in Arabic numerals (٢٠٢٦/٠٣/٢١)</span>
                        </div>
                        <div class="form-group" style="display:flex;align-items:center;gap:10px;">
                            <label class="toggle-switch">
                                <input type="checkbox" id="edit-sch-time-arabic" ${schedule.header_time_arabic ? 'checked' : ''}>
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="form-label" style="margin:0;">Time in Arabic numerals (٠٣:٠٩ م)</span>
                        </div>
                        <div class="form-group" style="margin-top:8px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <label class="form-label" style="margin:0;width:110px;flex-shrink:0;">Time offset</label>
                                <input type="number" class="input" id="edit-sch-datetime-offset" value="${schedule.header_datetime_offset || 0}" style="width:90px;">
                                <span class="text-muted" style="font-size:12px;">min (+ = later, − = earlier)</span>
                            </div>
                            <small class="text-muted">Shift the displayed time in the header by this many minutes.</small>
                        </div>
                    </div>
                    <div class="form-group" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                        <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;font-weight:500;">
                            <input type="checkbox" id="edit-sch-bullet-pts"
                                   ${schedule.bullet_points ? 'checked' : ''}
                                   onchange="_toggleBulletPtsField(this,'edit-sch-bullet-count-wrap')">
                            Bullet Points
                        </label>
                        <span id="edit-sch-bullet-count-wrap" style="display:${schedule.bullet_points ? 'flex' : 'none'};align-items:center;gap:6px">
                            <input type="number" class="input" id="edit-sch-bullet-count" value="${schedule.bullet_points_count || 10}" min="1" max="25" style="width:64px;padding:4px 8px">
                            <span style="font-size:12px;color:var(--text-muted)">points (interim batch auto-set to 26 − N)</span>
                        </span>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Telegram Targets (optional)</label>
                        <div class="tags-container" id="edit-sch-tg-targets">
                            ${(schedule.telegram_targets || []).map(t => `
                                <span class="tag">${escapeHtmlSys(t)}
                                    <span class="tag-remove" onclick="removeSchTgTarget('edit-sch', this)">×</span>
                                </span>
                            `).join('')}
                        </div>
                        <input type="text" class="input mt-1" id="edit-sch-tg-input"
                               placeholder="@channel or chat ID — press Enter to add"
                               onkeydown="if(event.key==='Enter'){event.preventDefault();addSchTgTarget('edit-sch');}">
                        <small class="text-muted sch-tg-hint" id="edit-sch-tg-hint">${(schedule.telegram_targets || []).length ? 'These targets override the collection target channels your bot is subscribed to.' : 'Leave empty to use collection targets.'}</small>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeModal('topic-schedule-edit-modal')">Cancel</button>
                    <button class="btn btn-primary"
                            onclick="saveEditedSchedule(${scheduleId})">Save Changes</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    function buildEditScheduleInputs(schedule) {
        const type = schedule.type;
        if (type === 'minute') {
            return `<label class="form-label">Every N Minutes</label>
                    <input type="number" class="input" id="edit-sch-minute" min="1" max="59" value="${schedule.minute || 1}">`;
        } else if (type === 'hourly') {
            return `<label class="form-label">Minute</label>
                    <input type="number" class="input" id="edit-sch-minute" min="0" max="59" value="${schedule.minute || 0}">`;
        } else if (type === 'interval_minutes') {
            const ehM = schedule.end_hour   != null ? schedule.end_hour   : '';
            const emM = schedule.end_minute != null ? schedule.end_minute : '';
            return `<label class="form-label">Every X Minutes</label>
                    <input type="number" class="input" id="edit-sch-minutes" min="1" max="1440" value="${schedule.minutes || 30}">
                    <label class="form-label mt-1">Starts at (HH : MM)</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                        <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                    </div>
                    <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="edit-sch-end-hour" min="0" max="23" value="${ehM}" placeholder="HH" style="width:80px;">
                        <input type="number" class="input" id="edit-sch-end-minute" min="0" max="59" value="${emM}" placeholder="MM" style="width:80px;">
                    </div>
                    <small class="text-muted">Fires every X minutes within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.</small>`;
        } else if (type === 'interval_hourly') {
            const ehI = schedule.end_hour   != null ? schedule.end_hour   : '';
            const emI = schedule.end_minute != null ? schedule.end_minute : '';
            return `<label class="form-label">Every X Hours</label>
                    <input type="number" class="input" id="edit-sch-hours" min="1" max="24" value="${schedule.hours || 2}">
                    <label class="form-label mt-1">Starts at (HH : MM)</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="edit-sch-start-hour" min="0" max="23" value="${schedule.start_hour ?? 0}" placeholder="HH" style="width:80px;">
                        <input type="number" class="input" id="edit-sch-start-minute" min="0" max="59" value="${schedule.start_minute ?? 0}" placeholder="MM" style="width:80px;">
                    </div>
                    <label class="form-label mt-1">Ends at (HH : MM) — leave blank to run indefinitely</label>
                    <div style="display:flex;gap:8px;">
                        <input type="number" class="input" id="edit-sch-end-hour" min="0" max="23" value="${ehI}" placeholder="HH" style="width:80px;">
                        <input type="number" class="input" id="edit-sch-end-minute" min="0" max="59" value="${emI}" placeholder="MM" style="width:80px;">
                    </div>
                    <small class="text-muted">Fires every X hours within the window. If end &lt; start (e.g. 08:00 → 02:00), runs overnight until end time next day.</small>`;
        } else if (type === 'daily') {
            return `<label class="form-label">Hour</label>
                    <input type="number" class="input" id="edit-sch-hour" min="0" max="23" value="${schedule.hour || 0}">
                    <label class="form-label mt-1">Minute</label>
                    <input type="number" class="input" id="edit-sch-minute" min="0" max="59" value="${schedule.minute || 0}">`;
        } else if (type === 'speeches_interval') {
            return `<label class="form-label">Wait Time (mins) — send buckets when idle</label>
                    <input type="number" class="input" id="edit-sch-wait-time" min="1" value="${schedule.wait_time || 5}">
                    <small class="text-muted">Checks every minute. Sends each bucket as a separate message after this many idle minutes. Separate LLM response sections with <code>---</code>.</small>`;
        }
        return '';
    }

    function updateEditScheduleInputs() {
        const type = document.getElementById('edit-sch-type').value;
        const container = document.getElementById('edit-sch-inputs');
        container.innerHTML = buildEditScheduleInputs({ type });
    }

    async function saveEditedSchedule(scheduleId) {
        const name = document.getElementById('edit-sch-name').value.trim();
        const type = document.getElementById('edit-sch-type').value;
        const prompt_key = document.getElementById('edit-sch-prompt').value;

        if (!name) {
            showAlert('Please enter a schedule name', { icon: '✏️' });
            return;
        }

        const header = document.getElementById('edit-sch-header').value;
        const header_datetime = document.getElementById('edit-sch-header-datetime').checked;
        const header_date_arabic = document.getElementById('edit-sch-date-arabic').checked;
        const header_time_arabic = document.getElementById('edit-sch-time-arabic').checked;
        const header_datetime_offset = Number(document.getElementById('edit-sch-datetime-offset')?.value || 0);
        const telegram_targets = getSchTgTargets('edit-sch');
        const bullet_points = document.getElementById('edit-sch-bullet-pts')?.checked || false;
        const bullet_points_count = parseInt(document.getElementById('edit-sch-bullet-count')?.value || '10', 10) || 10;
        const schedule = { name, type, prompt_key, header, header_datetime, header_date_arabic, header_time_arabic, header_datetime_offset, telegram_targets, bullet_points, bullet_points_count };

        if (type === 'minute') {
            schedule.minute = Number(document.getElementById('edit-sch-minute').value);
        } else if (type === 'hourly') {
            schedule.minute = Number(document.getElementById('edit-sch-minute').value);
        } else if (type === 'interval_minutes') {
            schedule.minutes      = Number(document.getElementById('edit-sch-minutes').value);
            schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
            schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
            const ehM = document.getElementById('edit-sch-end-hour').value;
            const emM = document.getElementById('edit-sch-end-minute').value;
            schedule.end_hour   = ehM !== '' ? Number(ehM) : null;
            schedule.end_minute = ehM !== '' ? (emM !== '' ? Number(emM) : 0) : null;
        } else if (type === 'interval_hourly') {
            schedule.hours        = Number(document.getElementById('edit-sch-hours').value);
            schedule.start_hour   = Number(document.getElementById('edit-sch-start-hour').value);
            schedule.start_minute = Number(document.getElementById('edit-sch-start-minute').value);
            const ehI = document.getElementById('edit-sch-end-hour').value;
            const emI = document.getElementById('edit-sch-end-minute').value;
            schedule.end_hour   = ehI !== '' ? Number(ehI) : null;
            schedule.end_minute = ehI !== '' ? (emI !== '' ? Number(emI) : 0) : null;
        } else if (type === 'daily') {
            schedule.hour   = Number(document.getElementById('edit-sch-hour').value);
            schedule.minute = Number(document.getElementById('edit-sch-minute').value);
        } else if (type === 'speeches_interval') {
            schedule.wait_time = Number(document.getElementById('edit-sch-wait-time').value);
        }

        const result = await api('/api/topic/schedule/update', {
            schedule_id: scheduleId,
            schedule
        });

        if (result.status === 'ok') {
            await loadAllData();
            const modal = document.getElementById('topic-schedule-edit-modal');
            const bn = modal?.dataset.botName;
            const cn = modal?.dataset.categoryName;
            const tn = modal?.dataset.topicName;
            const keepOpen = bn ? [`topic-${bn}-${cn}-${tn}`, `categories-${bn}`] : null;
            renderBotsPage(keepOpen);
            closeModal('topic-schedule-edit-modal');
            showNotification('Schedule updated', 'success');
        } else {
            showNotification('Failed to update schedule', 'error');
        }
    }

    // showNotification → shared/dialogs.js


    // ── Exports ──────────────────────────────────────────────────────────────────────────
    window._toggleBulletPtsField      = _toggleBulletPtsField;
    window.openDefaultScheduleModal   = openDefaultScheduleModal;
    window.updateDsInputs             = updateDsInputs;
    window.saveDefaultSchedule        = saveDefaultSchedule;
    window.removeDefaultSchedule      = removeDefaultSchedule;
    window.editDefaultSchedule        = editDefaultSchedule;
    window.saveEditedDefaultSchedule  = saveEditedDefaultSchedule;
    window.openAddTopicScheduleModal  = openAddTopicScheduleModal;
    window.applyDefaultScheduleToForm = applyDefaultScheduleToForm;
    window.updateTopicScheduleInputs  = updateTopicScheduleInputs;
    window.saveTopicSchedule          = saveTopicSchedule;
    window.toggleTopicSchedule        = toggleTopicSchedule;
    window.deleteTopicSchedule        = deleteTopicSchedule;
    window.toggleSchMenu              = toggleSchMenu;
    window.closeAllSchMenus           = closeAllSchMenus;
    window.toggleSchDatetimeOptions   = toggleSchDatetimeOptions;
    window.addSchTgTarget             = addSchTgTarget;
    window.removeSchTgTarget          = removeSchTgTarget;
    window._updateSchTgHint           = _updateSchTgHint;
    window.getSchTgTargets            = getSchTgTargets;
    window.openEditTopicScheduleModal = openEditTopicScheduleModal;
    window.buildEditScheduleInputs    = buildEditScheduleInputs;
    window.updateEditScheduleInputs   = updateEditScheduleInputs;
    window.saveEditedSchedule         = saveEditedSchedule;
})();
