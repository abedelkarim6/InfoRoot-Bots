// ==================== Custom Dialogs ====================
function showAlert(message, { title = 'Notice', icon = 'ℹ️' } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">${icon}</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">${message}</div>
            <div class="dialog-actions" style="justify-content:center;">
                <button class="btn btn-primary dialog-ok">OK</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-ok').addEventListener('click', close);
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-ok').focus();
}

function showConfirm(message, onConfirm, { title = 'Confirm', icon = '⚠️', confirmLabel = 'Delete', confirmClass = 'btn-danger' } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">${icon}</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">${message}</div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn ${confirmClass} dialog-confirm">${confirmLabel}</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => { close(); onConfirm(); });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { close(); onConfirm(); }
    });
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-cancel').focus();
}

function showPrompt(title, defaultValue, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
        <div class="dialog-box" role="dialog" aria-modal="true">
            <span class="dialog-icon">✏️</span>
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">
                <input type="text" class="input dialog-input" value="${escapeHtmlSys(defaultValue)}" style="width:100%;margin-top:8px;">
            </div>
            <div class="dialog-actions">
                <button class="btn btn-secondary dialog-cancel">Cancel</button>
                <button class="btn btn-primary dialog-confirm">Save</button>
            </div>
        </div>
    `;
    const close = () => overlay.remove();
    const input = overlay.querySelector('.dialog-input');
    overlay.querySelector('.dialog-cancel').addEventListener('click', close);
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => { close(); onConfirm(input.value); });
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') close();
        if (e.key === 'Enter') { close(); onConfirm(input.value); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
}

function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 16px 24px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        z-index: 10001;
        animation: slideIn 0.3s;
    `;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}
