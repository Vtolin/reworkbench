import type { ReactNode } from "react";

/** Shared settings/detail panel with the app's existing dark card styling. */
export function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-[#2f2f2f] bg-[#0a0a0a] p-4 lg:p-5 ${className}`.trim()}>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {description ? <div className="mt-1 text-xs leading-relaxed text-[#8e8e8e]">{description}</div> : null}
      {children}
    </section>
  );
}

export const fieldClass =
  "mt-1 w-full rounded-xl border border-[#2f2f2f] bg-[#171717] px-3 py-2 text-sm text-white outline-none focus:border-[#404040]";

export const buttonClass =
  "rounded-xl border border-[#2f2f2f] bg-[#212121] px-4 py-2 text-sm text-white hover:bg-[#2f2f2f] disabled:opacity-50";

export const primaryButtonClass =
  "rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-[#ececec] disabled:opacity-50";
