import type { Metadata } from "next";
import { Tajawal } from "next/font/google";
import "./globals.css";

const tajawal = Tajawal({
  variable: "--font-tajawal",
  subsets: ["arabic", "latin"],
  weight: ["300", "400", "500", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "حجز طباعة الامتحانات",
  description: "حجز مواعيد تصوير الأوراق الامتحانية في مركز الطباعة بجامعة طرابلس",
};

// Sets <html data-theme> before the first paint from the saved choice ("light" | "dark" | "system"; none = system),
// and follows the OS while the choice is "system". CSP allows inline scripts (next.config.ts).
const themeScript = `(function(){try{var r=document.documentElement,q=matchMedia("(prefers-color-scheme: dark)");function a(){var c=localStorage.getItem("theme");r.dataset.theme=c==="dark"||(c!=="light"&&q.matches)?"dark":"light"}a();q.addEventListener("change",a);addEventListener("storage",a)}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className={`${tajawal.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
