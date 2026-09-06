import type { Metadata } from "next";
import "@/app/globals.css";
import { DesktopGate } from "@/components/desktop-gate";

export const metadata: Metadata = {
  title: "DocuVoz — Escucha tus documentos",
  description:
    "Convierte documentos PDF a audio natural. Lee en cualquier momento con voz realista.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>
        <DesktopGate>{children}</DesktopGate>
      </body>
    </html>
  );
}
