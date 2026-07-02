/**
 * ReplacePairsEditor — controlled editor for a replace group's from→to pairs.
 * `value` is [{ from, to, enabled }]; `onChange` receives the updated array.
 * Used both in the Add Replace Group modal and inside ReplaceGroupBox.
 */

export default function ReplacePairsEditor({ value, onChange, disabled }) {
  const pairs = value || [];

  function update(idx, patch) {
    onChange(pairs.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function removeAt(idx) {
    onChange(pairs.filter((_, i) => i !== idx));
  }
  function addRow() {
    onChange([...pairs, { from: '', to: '', enabled: true }]);
  }

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 18px 1fr auto auto',
          gap: 6,
          alignItems: 'center',
          fontSize: 11,
          color: 'var(--text-muted)',
          fontWeight: 600,
          marginBottom: 4
        }}
      >
        <span>From</span>
        <span />
        <span>To</span>
        <span style={{ textAlign: 'center' }}>On</span>
        <span />
      </div>

      {pairs.map((p, idx) => (
        <div
          key={idx}
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 18px 1fr auto auto',
            gap: 6,
            alignItems: 'center',
            marginBottom: 6,
            opacity: p.enabled === false ? 0.55 : 1
          }}
        >
          <input
            className="input"
            style={{ width: '100%' }}
            placeholder="match…"
            value={p.from}
            disabled={disabled}
            onChange={(e) => update(idx, { from: e.target.value })}
          />
          <span style={{ textAlign: 'center', color: 'var(--text-muted)' }}>→</span>
          <input
            className="input"
            style={{ width: '100%' }}
            placeholder="replace with…"
            value={p.to}
            disabled={disabled}
            onChange={(e) => update(idx, { to: e.target.value })}
          />
          <input
            type="checkbox"
            title="Enabled"
            checked={p.enabled !== false}
            disabled={disabled}
            onChange={(e) => update(idx, { enabled: e.target.checked })}
            style={{ cursor: 'pointer' }}
          />
          <button
            type="button"
            className="btn-icon btn-danger"
            title="Remove pair"
            disabled={disabled}
            onClick={() => removeAt(idx)}
          >
            ×
          </button>
        </div>
      ))}

      {pairs.length === 0 && (
        <div className="text-muted" style={{ fontSize: 12, padding: '4px 0 8px' }}>
          No pairs yet — add at least one.
        </div>
      )}

      <button type="button" className="btn btn-secondary btn-sm" onClick={addRow} disabled={disabled}>
        + Add Pair
      </button>
    </div>
  );
}
