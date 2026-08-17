import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Career Intelligence Assistant",
  description: "Ask how your resume measures up against the roles you are considering.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* `h-full overflow-hidden`, not `min-h-full`: with only a minimum the
          column has no ceiling, so a long answer grew `main` past the viewport
          and the whole page scrolled -- taking the sidebar and the composer out
          of view. Fixed to the viewport, the transcript is the only thing that
          scrolls. */}
      <body className="flex h-full flex-col overflow-hidden">{children}</body>
    </html>
  );
}
