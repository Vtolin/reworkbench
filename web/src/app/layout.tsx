import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { ChatProvider } from "@/contexts/ChatContext";
import MobileShell from "@/components/MobileShell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Research Workbench — Local Academic Library",
  description: "Mendeley-like local-first research workbench with hybrid retrieval over your documents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`} style={{ colorScheme: "dark" }}>
      <body className="min-h-screen flex bg-black text-[#ececec] overflow-hidden">
        <ChatProvider>
          <MobileShell>
            <Sidebar />
            <div className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden bg-black">
              <div className="flex-1 overflow-auto">
                {children}
              </div>
            </div>
          </MobileShell>
        </ChatProvider>
      </body>
    </html>
  );
}
