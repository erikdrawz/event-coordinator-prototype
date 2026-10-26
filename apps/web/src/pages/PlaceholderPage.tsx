export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <main className="page">
      <div className="page-header"><h1 className="page-title">{title}</h1></div>
      <section className="card empty-state">
        <div className="empty-state-title">Not built yet</div>
        {title} arrives in {phase}.
      </section>
    </main>
  );
}
