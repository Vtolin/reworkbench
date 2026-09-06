import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No server-side localhost calls: all Ollama traffic originates in the browser.
  // Vercel only proxies cloud-AI (BYOK) requests.
};

export default nextConfig;
