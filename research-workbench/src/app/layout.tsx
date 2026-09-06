import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ChatProvider } from "@/contexts/ChatContext";
import { SessionProvider } from "@/contexts/SessionContext";
import { InferenceProvider } from "@/contexts/InferenceContext";
import AppShell from "@/components/AppShell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Research Workbench — Shared Academic Library",
  description: "Multi-user research workbench with hybrid retrieval over shared documents. Each member uses their own inference.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`} style={{ colorScheme: "dark" }}>
      <body className="min-h-screen flex bg-black text-[#ececec] overflow-hidden">
        <SessionProvider>
          <InferenceProvider>
            <ChatProvider>
              <AppShell>{children}</AppShell>
            </ChatProvider>
          </InferenceProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
