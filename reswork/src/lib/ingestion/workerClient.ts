// Typed RPC client for the ingest Web Worker.
//
// Bun/Node/SSR/tests have no Worker global: callers get null and run the
// direct path. A worker that fails to load or crashes is marked broken for
// the session, so one environment-level failure cannot cause a retry storm -
// every later task runs on the main thread instead.
import type {
  IngestTaskInput,
  IngestTaskKind,
  IngestWorkerRequest,
  IngestWorkerResponse,
} from "./workerProtocol";

export class WorkerUnavailableError extends Error {
  constructor(message = "Ingest worker unavailable") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export type IngestWorkerFactory = () => Worker;

interface Pending {
  resolve: (response: IngestWorkerResponse) => void;
  reject: (error: Error) => void;
}

export class IngestWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private broken = false;

  constructor(private readonly factory: IngestWorkerFactory) {}

  get available(): boolean {
    return !this.broken;
  }

  run<K extends IngestTaskKind>(
    kind: K,
    payload: IngestTaskInput[K],
  ): Promise<IngestWorkerResponse> {
    if (this.broken) return Promise.reject(new WorkerUnavailableError());
    const worker = this.ensure();
    if (!worker) return Promise.reject(new WorkerUnavailableError());
    const id = this.nextId++;
    // The generic pair is proven by the signature; the assertion only widens
    // it back to the discriminated union for postMessage.
    const request = { id, kind, payload } as IngestWorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage(request);
      } catch (e) {
        // DataCloneError (File/Blob not cloneable in this browser) is an
        // environment limitation: fall back like any other worker failure.
        this.pending.delete(id);
        reject(new WorkerUnavailableError(e instanceof Error ? e.message : String(e)));
      }
    });
  }

  /** Terminate the worker (HMR/tests). The next run recreates it. */
  dispose(): void {
    this.failAll(new WorkerUnavailableError("Ingest worker disposed"));
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = this.factory();
      worker.addEventListener("message", this.onMessage);
      worker.addEventListener("error", this.onError);
      worker.addEventListener("messageerror", this.onMessageError);
      this.worker = worker;
      return worker;
    } catch {
      this.broken = true;
      return null;
    }
  }

  private onMessage = (event: MessageEvent<IngestWorkerResponse>): void => {
    const response = event.data;
    if (!response || typeof response !== "object") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  };

  // An uncaught worker error means the bundle failed to load or the worker
  // crashed (OOM): infrastructure-level, never a per-document parse error
  // (the task dispatcher converts those into { ok: false } responses).
  private onError = (event: ErrorEvent): void => {
    this.failAll(
      new WorkerUnavailableError(event.message || "Ingest worker crashed"),
    );
  };

  private onMessageError = (): void => {
    this.failAll(new WorkerUnavailableError("Ingest worker message could not be deserialized"));
  };

  private failAll(error: Error): void {
    this.broken = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(error);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

function createIngestWorker(): Worker {
  // Turbopack/webpack recognize this exact `new Worker(new URL(...))` shape
  // and emit the worker (and its imports) as a separate bundle.
  return new Worker(new URL("./ingest.worker.ts", import.meta.url), {
    type: "module",
    name: "ingest-worker",
  });
}

let shared: IngestWorkerClient | null = null;

/**
 * The shared worker, or null when the current environment cannot use one.
 * Lazy: no Worker is constructed during SSR, tests, or until the first task.
 */
export function getIngestWorkerClient(): IngestWorkerClient | null {
  if (typeof Worker === "undefined") return null;
  shared ??= new IngestWorkerClient(createIngestWorker);
  return shared.available ? shared : null;
}

/** Test/HMR hook: drop the singleton (a later call recreates it). */
export function resetIngestWorkerClient(): void {
  shared?.dispose();
  shared = null;
}
