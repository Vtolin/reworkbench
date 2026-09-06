import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/contexts/SessionContext";
import { InferenceProvider } from "@/contexts/InferenceContext";

export const metadata: Metadata = {
  title: "Research Workbench",
  description: "Multi-user, cloud-coordinated, locally-executed AI research workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-neutral-200 antialiased">
        <SessionProvider>
          <InferenceProvider>{children}</InferenceProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
