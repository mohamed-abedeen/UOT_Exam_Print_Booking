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
        <p className="text-lg text-muted-foreground">
          مركز الطباعة — جامعة طرابلس
        </p>
      </div>
      <nav className="flex w-full max-w-sm flex-col gap-3">
        {areas.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            className="glass-soft flex h-12 items-center justify-center px-5 font-semibold"
          >
            {area.label}
          </Link>
        ))}
      </nav>
    </main>
  );
}
