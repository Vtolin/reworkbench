// Worker protocol for the ingest pipeline. Shared by the worker entry, the
// typed RPC client and tests - one place defines every task/result shape.
import type { ChunkInput } from "./chunking";
import type { EmbeddedSlice, EmbedMode } from "./embedCore";
import type { FileAnalysis } from "./fileAnalysis";

export interface IngestTaskInput {
  analyze: { file: File };
  chunk: { text: string };
  embed: { text: string; mode: EmbedMode };
}

export interface IngestTaskOutput {
  analyze: FileAnalysis;
  chunk: ChunkInput[];
  embed: EmbeddedSlice;
}

export type IngestTaskKind = keyof IngestTaskInput;

export type IngestWorkerRequest = {
  [K in IngestTaskKind]: {
    id: number;
    kind: K;
    payload: IngestTaskInput[K];
  };
}[IngestTaskKind];

export type IngestWorkerResponse = {
  [K in IngestTaskKind]:
    | { id: number; kind: K; ok: true; result: IngestTaskOutput[K] }
    | { id: number; kind: K; ok: false; error: string };
}[IngestTaskKind];
