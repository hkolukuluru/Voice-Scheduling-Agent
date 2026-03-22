import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Scheduling Agent",
  description:
    "A real-time voice assistant that confirms meeting details and writes real Google Calendar events.",
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
