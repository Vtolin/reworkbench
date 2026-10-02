import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No server-side localhost calls: all Ollama traffic originates in the browser.
  // Vercel only proxies cloud-AI (BYOK) requests.
  async redirects() {
    return [
      // The library lives at `/` (original IA); old placeholder routes merge back.
      { source: "/dashboard", destination: "/", permanent: false },
      { source: "/library", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
