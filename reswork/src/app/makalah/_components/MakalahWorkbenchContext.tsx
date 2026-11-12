"use client";

// One workbench instance for the Makalah route. The three hooks own their
// domains; the provider only composes them so steps never prop-drill a
// 60-field model through the component tree.

import { createContext, useContext, type ReactNode } from "react";
import { useMakalahDraft, type MakalahDraftModel } from "./useMakalahDraft";
import {
  useMakalahGeneration,
  type MakalahGenerationModel,
} from "./useMakalahGeneration";
import { useMakalahExport, type MakalahExportModel } from "./useMakalahExport";

export interface MakalahWorkbench {
  draft: MakalahDraftModel;
  gen: MakalahGenerationModel;
  exporter: MakalahExportModel;
}

const MakalahWorkbenchContext = createContext<MakalahWorkbench | null>(null);

export function MakalahWorkbenchProvider({ children }: { children: ReactNode }) {
  const draft = useMakalahDraft();
  const gen = useMakalahGeneration(draft);
  const exporter = useMakalahExport(draft);
  return (
    <MakalahWorkbenchContext.Provider value={{ draft, gen, exporter }}>
      {children}
    </MakalahWorkbenchContext.Provider>
  );
}

export function useMakalahWorkbench(): MakalahWorkbench {
  const ctx = useContext(MakalahWorkbenchContext);
  if (!ctx) throw new Error("useMakalahWorkbench must be used within MakalahWorkbenchProvider");
  return ctx;
}
