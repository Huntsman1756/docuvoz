import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AUIDIO NAN — document-to-audio reading laboratory",
  description:
    "Phase 0 prototype: turning Spanish financial and regulatory documents into speech optimized for listening. Literal vs deterministic Listen vs Manual Gold.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
