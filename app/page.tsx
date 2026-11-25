import Link from "next/link";

const areas = [
  { href: "/college", label: "بوابة الكلية" },
  { href: "/operator", label: "بوابة المشغّل" },
  { href: "/admin", label: "لوحة الإدارة" },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-16 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">حجز طباعة الامتحانات</h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          مركز الطباعة — جامعة طرابلس
        </p>
      </div>
      <nav className="flex w-full max-w-sm flex-col gap-3">
        {areas.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            className="rounded-lg border border-zinc-300 px-5 py-3 font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {area.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
