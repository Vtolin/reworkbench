import { describe, expect, it } from "vitest";
import { IngestWorkerClient, WorkerUnavailableError } from "./workerClient";
import type { IngestWorkerRequest } from "./workerProtocol";

interface FakeEvent {
  data?: unknown;
  message?: string;
}
type Listener = (event: FakeEvent) => void;

class FakeWorker {
  posted: IngestWorkerRequest[] = [];
  terminated = false;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  postMessage(request: IngestWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const asWorker = (fake: FakeWorker): Worker => fake as unknown as Worker;

describe("IngestWorkerClient", () => {
  it("correlates responses by id and kind", async () => {
    const fake = new FakeWorker();
    const client = new IngestWorkerClient(() => asWorker(fake));
    const promise = client.run("chunk", { text: "hello" });
    expect(fake.posted).toHaveLength(1);
    const request = fake.posted[0];
    expect(request).toMatchObject({ id: 1, kind: "chunk", payload: { text: "hello" } });
    fake.emit("message", {
      data: { id: request.id, kind: "chunk", ok: true, result: [{ content: "hello", chunk_index: 0 }] },
    });
    await expect(promise).resolves.toMatchObject({
      ok: true,
      kind: "chunk",
      result: [{ content: "hello" }],
    });
  });

  it("keeps concurrent tasks independent", async () => {
    const fake = new FakeWorker();
    const client = new IngestWorkerClient(() => asWorker(fake));
    const first = client.run("chunk", { text: "first" });
    const second = client.run("chunk", { text: "second" });
    const [a, b] = fake.posted;
    // Resolve out of order: each promise must receive its own result.
    fake.emit("message", { data: { id: b.id, kind: "chunk", ok: true, result: [{ content: "b", chunk_index: 0 }] } });
    fake.emit("message", { data: { id: a.id, kind: "chunk", ok: true, result: [{ content: "a", chunk_index: 0 }] } });
    await expect(first).resolves.toMatchObject({ result: [{ content: "a" }] });
    await expect(second).resolves.toMatchObject({ result: [{ content: "b" }] });
  });

  it("marks the worker broken after a crash and rejects pending tasks", async () => {
    const fake = new FakeWorker();
    const client = new IngestWorkerClient(() => asWorker(fake));
    const pending = client.run("chunk", { text: "x" });
    fake.emit("error", { message: "boom" });
    await expect(pending).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(fake.terminated).toBe(true);
    expect(client.available).toBe(false);
    await expect(client.run("chunk", { text: "y" })).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it("falls back cleanly when the worker cannot be created", async () => {
    const client = new IngestWorkerClient(() => {
      throw new Error("no worker support");
    });
    await expect(client.run("chunk", { text: "x" })).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(client.available).toBe(false);
  });

  it("treats a non-cloneable payload as worker-unavailable", async () => {
    class ThrowingWorker extends FakeWorker {
      override postMessage(): void {
        throw new Error("DataCloneError");
      }
    }
    const client = new IngestWorkerClient(() => asWorker(new ThrowingWorker()));
    const error = await client.run("chunk", { text: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerUnavailableError);
    expect((error as Error).message).toContain("DataCloneError");
  });

  it("rejects in-flight tasks on dispose", async () => {
    const fake = new FakeWorker();
    const client = new IngestWorkerClient(() => asWorker(fake));
    const pending = client.run("chunk", { text: "x" });
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(fake.terminated).toBe(true);
  });
});
