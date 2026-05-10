import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const DialogsContext = createContext(null);

let _externalApi = null; // exposes window.showAlert / showConfirm / etc. for parity

export function useDialogs() {
  const ctx = useContext(DialogsContext);
  if (!ctx) throw new Error('useDialogs must be used inside <DialogsProvider>');
  return ctx;
}

export function DialogsProvider({ children }) {
  const [stack, setStack] = useState([]); // open dialog instances
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const close = useCallback((id) => {
    setStack((s) => s.filter((d) => d.id !== id));
  }, []);

  const showAlert = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      setStack((s) => [
        ...s,
        {
          kind: 'alert',
          id,
          message,
          title: opts.title || 'Notice',
          icon: opts.icon || 'ℹ️',
          onClose: () => {
            close(id);
            resolve();
          }
        }
      ]);
    });
  }, [close]);

  const showConfirm = useCallback((message, onConfirmCb, opts = {}) => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      setStack((s) => [
        ...s,
        {
          kind: 'confirm',
          id,
          message,
          title: opts.title || 'Confirm',
          icon: opts.icon || '⚠️',
          confirmLabel: opts.confirmLabel || 'Delete',
          confirmClass: opts.confirmClass || 'btn-danger',
          onConfirm: () => {
            close(id);
            if (typeof onConfirmCb === 'function') onConfirmCb();
            resolve(true);
          },
          onCancel: () => {
            close(id);
            resolve(false);
          }
        }
      ]);
    });
  }, [close]);

  const showPrompt = useCallback((title, defaultValue, onConfirmCb) => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      setStack((s) => [
        ...s,
        {
          kind: 'prompt',
          id,
          title,
          defaultValue: defaultValue ?? '',
          onConfirm: (value) => {
            close(id);
            if (typeof onConfirmCb === 'function') onConfirmCb(value);
            resolve(value);
          },
          onCancel: () => {
            close(id);
            resolve(null);
          }
        }
      ]);
    });
  }, [close]);

  const showNotification = useCallback((message, type = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  // Expose globals that mirror the legacy helpers — lets us port pages
  // incrementally without rewriting every showAlert/showConfirm callsite.
  useEffect(() => {
    _externalApi = { showAlert, showConfirm, showPrompt, showNotification };
    window.showAlert = showAlert;
    window.showConfirm = showConfirm;
    window.showPrompt = showPrompt;
    window.showNotification = showNotification;
    return () => {
      _externalApi = null;
      delete window.showAlert;
      delete window.showConfirm;
      delete window.showPrompt;
      delete window.showNotification;
    };
  }, [showAlert, showConfirm, showPrompt, showNotification]);

  return (
    <DialogsContext.Provider value={{ showAlert, showConfirm, showPrompt, showNotification }}>
      {children}
      <DialogsRenderer stack={stack} />
      <ToastRenderer toasts={toasts} />
    </DialogsContext.Provider>
  );
}

function DialogsRenderer({ stack }) {
  return stack.map((d) => {
    if (d.kind === 'alert') return <AlertDialog key={d.id} {...d} />;
    if (d.kind === 'confirm') return <ConfirmDialog key={d.id} {...d} />;
    if (d.kind === 'prompt') return <PromptDialog key={d.id} {...d} />;
    return null;
  });
}

function AlertDialog({ message, title, icon, onClose }) {
  const okRef = useRef(null);
  useEffect(() => {
    okRef.current?.focus();
  }, []);
  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === 'Escape') onClose();
  }
  return (
    <div className="dialog-overlay" onKeyDown={onKeyDown}>
      <div className="dialog-box" role="dialog" aria-modal="true">
        <span className="dialog-icon">{icon}</span>
        <div className="dialog-title">{title}</div>
        {/* dangerouslySetInnerHTML matches legacy showAlert which accepts HTML */}
        <div className="dialog-message" dangerouslySetInnerHTML={{ __html: message }} />
        <div className="dialog-actions" style={{ justifyContent: 'center' }}>
          <button ref={okRef} className="btn btn-primary dialog-ok" onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ message, title, icon, confirmLabel, confirmClass, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  function onKeyDown(e) {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter') onConfirm();
  }
  return (
    <div className="dialog-overlay" onKeyDown={onKeyDown}>
      <div className="dialog-box" role="dialog" aria-modal="true">
        <span className="dialog-icon">{icon}</span>
        <div className="dialog-title">{title}</div>
        <div className="dialog-message" dangerouslySetInnerHTML={{ __html: message }} />
        <div className="dialog-actions">
          <button ref={cancelRef} className="btn btn-secondary dialog-cancel" onClick={onCancel}>Cancel</button>
          <button className={`btn ${confirmClass} dialog-confirm`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({ title, defaultValue, onConfirm, onCancel }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  function onKeyDown(e) {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter') onConfirm(inputRef.current.value);
  }
  return (
    <div className="dialog-overlay" onKeyDown={onKeyDown}>
      <div className="dialog-box" role="dialog" aria-modal="true">
        <span className="dialog-icon">✏️</span>
        <div className="dialog-title">{title}</div>
        <div className="dialog-message">
          <input
            ref={inputRef}
            type="text"
            className="input dialog-input"
            defaultValue={defaultValue}
            style={{ width: '100%', marginTop: 8 }}
          />
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary dialog-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary dialog-confirm"
            onClick={() => onConfirm(inputRef.current.value)}
          >Save</button>
        </div>
      </div>
    </div>
  );
}

function ToastRenderer({ toasts }) {
  return toasts.map((t, idx) => (
    <div
      key={t.id}
      className={`notification notification-${t.type}`}
      style={{
        position: 'fixed',
        bottom: 20 + idx * 60,
        right: 20,
        padding: '16px 24px',
        background:
          t.type === 'success' ? '#10b981' :
          t.type === 'error' ? '#ef4444' : '#3b82f6',
        color: 'white',
        borderRadius: 8,
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        zIndex: 10001,
        animation: 'slideIn 0.3s'
      }}
    >
      {t.message}
    </div>
  ));
}
