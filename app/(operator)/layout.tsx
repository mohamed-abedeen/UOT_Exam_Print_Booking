export default function OperatorLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-zinc-300 px-4 py-3 font-bold dark:border-zinc-700">
        بوابة المشغّل
      </header>
      <main className="flex-1 p-4">{children}</main>
    </div>
  );
}
