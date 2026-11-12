// Ingest Web Worker entry. All heavy, deterministic ingestion work runs here:
// document extraction, hashing, text analysis, chunking and embedding.
//
// The entry is intentionally tiny: dispatch + response lives in workerTasks
// (tested directly), so this file only adapts postMessage to that function.
import { runIngestTask } from "./workerTasks";
import type { IngestWorkerRequest, IngestWorkerResponse } from "./workerProtocol";

interface IngestWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<IngestWorkerRequest>) => void,
  ): void;
  postMessage(message: IngestWorkerResponse): void;
}

const scope = self as unknown as IngestWorkerScope;

scope.addEventListener("message", (event) => {
  void runIngestTask(event.data).then((response) => scope.postMessage(response));
});
