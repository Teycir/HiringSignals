// F.3 placeholder for the /signals dashboard (spec 10.2). AppShell
// (masthead, scroll-progress, filter-rail scaffolding) now wraps this
// via src/app/layout.tsx -- this page only needs to render its own
// content column. F.4 replaces this body with the real signal-feed +
// filter-rail composition; nothing here is meant to survive F.4.
export default function Home() {
  return (
    <div className="p-6">
      <p className="text-soft-ink">Signal feed lands in Milestone F.4.</p>
    </div>
  );
}
