"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/observability/report";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, { digest: error.digest, boundary: "global" });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-black text-[#ececec] grid place-items-center px-4">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold text-white">Something went wrong</h1>
          <p className="text-sm text-[#8e8e8e]">
            The error has been logged. You can try again.
          </p>
          <button
            onClick={() => reset()}
            className="rounded-xl bg-white text-black px-4 py-2 text-sm font-medium"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
