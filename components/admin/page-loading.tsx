// Fallback of an admin page while it reads its data. Client navigations between admin pages only re-render below
// the shared layout, so each page needs a <Suspense> of its own (Next "instant navigation" validation).
export function PageLoading() {
  return <p role="status">جارٍ التحميل…</p>;
}
