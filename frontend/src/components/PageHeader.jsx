/**
 * Standard page header used by every page. Mirrors the legacy `.page-header`
 * markup so all the existing CSS rules apply unchanged.
 *
 *   <PageHeader title="Foo" subtitle="Bar">
 *     <button className="btn btn-secondary">Action</button>
 *   </PageHeader>
 */
export default function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-header">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}
