// Suspense-boundary fallback for /signals and /trends (both wrap a
// useSearchParams()-using client component in Suspense -- see each
// page.tsx's header comment). Previously both fell back to
// `<AppShell>{null}</AppShell>`: an empty content column with only the
// masthead visible while the client bundle for SignalsView/TrendsView
// loads and hydrates, which on a cold load/slow connection left the
// page looking blank for several seconds with no indication anything
// was happening. This renders immediately (no client JS required, no
// data fetch) so there's always *something* moving on screen from the
// first paint.
//
// Matches signal-feed.tsx's and trends-view.tsx's own post-mount
// loading skeletons (`border-2 border-ink ... animate-pulse` blocks) so
// there's no visual jump when the real component takes over -- this is
// deliberately the same shape, not a spinner or a different style.
export function PageLoadingSkeleton() {
  return (
    <div className="p-4 md:p-6 flex flex-col gap-4" aria-busy="true" aria-label="Loading page">
      <div className="flex flex-col gap-1 border-b-2 border-ink pb-4">
        <div className="h-6 w-48 bg-muted animate-pulse" />
        <div className="h-4 w-full max-w-md bg-muted animate-pulse" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="border-2 border-ink p-4 h-20 bg-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}
