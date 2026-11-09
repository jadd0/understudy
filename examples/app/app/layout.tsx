import type { ReactNode } from "react";
import { Geist } from "next/font/google";
import "./globals.css";
import { PREPAINT_SCRIPT } from "@/lib/ui/theme";

const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-geist" });

export const metadata = { title: "Understudy" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PREPAINT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-ground font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
