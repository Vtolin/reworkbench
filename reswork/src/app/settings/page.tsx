"use client";

import Topbar from "@/components/Topbar";
import { InferenceCard } from "./_components/InferenceCard";
import { SummarizationCard } from "./_components/SummarizationCard";
import { MakalahPipelineCard } from "./_components/MakalahPipelineCard";
import { CitationCard } from "./_components/CitationCard";
import { ImportExportCard } from "./_components/ImportExportCard";
import {
  PrivacyCard,
  ShortcutsCard,
  StorageCard,
  WorkspaceCard,
} from "./_components/WorkspaceStorageCard";
import { useCitationSettings } from "./_components/useCitationSettings";

export default function SettingsPage() {
  // Single owner for CSL style state: the citation selector and the
  // bibliography export must always agree on the current default.
  const citation = useCitationSettings();

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-black">
      <Topbar
        title="Settings"
        subtitle="Inference (this device) • Citation • Import/export • Workspace • Storage"
      />
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 lg:px-6">
        <InferenceCard />
        <SummarizationCard />
        <MakalahPipelineCard />
        <CitationCard settings={citation} />
        <ImportExportCard defaultStyle={citation.defaultStyle} />
        <WorkspaceCard />
        <PrivacyCard />
        <StorageCard />
        <ShortcutsCard />
      </div>
    </div>
  );
}
