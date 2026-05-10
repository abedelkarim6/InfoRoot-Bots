/**
 * Phase 1 placeholder. Each page is replaced incrementally in Phase 3
 * by a real port of the corresponding legacy module.
 */
export default function Placeholder({ title, subtitle, legacyFile }) {
  return (
    <div className="page active">
      <header className="page-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
      </header>
      <div className="card" style={{ padding: 24, marginTop: 16 }}>
        <p style={{ marginBottom: 8 }}>
          <strong>Phase 1 placeholder.</strong> This page hasn’t been ported to React yet.
        </p>
        {legacyFile && (
          <p style={{ color: 'var(--text-muted)' }}>
            Legacy implementation: <code>{legacyFile}</code>
          </p>
        )}
      </div>
    </div>
  );
}
