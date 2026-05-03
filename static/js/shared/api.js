// ==================== API Helper ====================
async function api(path, body) {
    const options = {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    try {
        const response = await fetch(path, options);
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return { status: 'error', message: text || `Server error (${response.status})` };
        }
    } catch (error) {
        console.error('API Error:', error);
        return { status: 'error', message: error.message };
    }
}

// ==================== Utilities ====================
function debounce(fn, ms = 250) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeHtmlSys(str) {
    if (str == null) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function jsAttr(str) {
    if (str == null) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Format an ISO/UTC timestamp for display in Lebanon time (Asia/Beirut).
function _fmtLBN(iso) {
    if (!iso && iso !== 0) return '—';
    let d;
    if (typeof iso === 'number') {
        d = new Date(iso);
    } else {
        const s = String(iso).replace(' ', 'T');
        const norm = (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) ? s : s + 'Z';
        d = new Date(norm);
    }
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-GB', {
        timeZone: 'Asia/Beirut',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

// Build comma-separated tag chips for monitor tables.
function _monTagsHtml(str, cls) {
    const tags = (str || '').split(',').map(t => t.trim()).filter(Boolean)
        .map(t => `<span class="mon-tag${cls ? ' ' + cls : ''}">${escapeHtml(t)}</span>`).join(' ');
    return tags || '<span style="color:var(--text-muted)">—</span>';
}

// ==================== Debounced filter wrappers ====================
// Used by oninput handlers in HTML — debounced to avoid re-rendering on every keystroke.
const _dApplyMonMessageFilters = debounce(() => typeof applyMonMessageFilters === 'function' && applyMonMessageFilters(), 220);
const _dApplyMonUnclassFilters = debounce(() => typeof applyMonUnclassFilters === 'function' && applyMonUnclassFilters(), 220);
const _dApplyMonMissedFilters  = debounce(() => typeof applyMonMissedFilters  === 'function' && applyMonMissedFilters(),  220);
const _dApplyLogFilters        = debounce(() => typeof applyLogFilters        === 'function' && applyLogFilters(),        220);
const _dFilterSourceMatrix     = debounce(() => typeof filterSourceMatrix     === 'function' && filterSourceMatrix(),     220);
