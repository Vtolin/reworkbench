"use client";

import { useEffect, useState } from "react";

// Shared localStorage hydrate/persist (Phase 6).
//
// ChatContext, MakalahContext and InferenceContext each carried their own
// copy of: read+parse with fallback, write with quota detection, and a
// persistError surface. This module is the ONE implementation — contexts
// keep only their domain shapes (defaults, migrations, normalization,
// cross-key validation) and delegate every storage touch to it.
//
// Testability: the storage primitives take an injected StorageLike, so unit
// tests drive quota/corruption paths with fakes (no DOM needed). The hooks
// are thin glue over those tested primitives and preserve the established
// effect-hydration timing exactly (SSR-safe: no storage access during render).

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Quota-shaped failure (name or message based — browsers differ). */
export function isQuotaError(e: unknown): boolean {
  if (e instanceof DOMException && (e.name === "QuotaExceededError" || e.code === 22)) return true;
  return e instanceof Error && /quota|exceed/i.test(e.message);
}

/**
 * Read and JSON-parse a key. Returns undefined when missing, corrupt, or
 * storage is unavailable — callers apply their own fallback. Never throws.
 */
export function readJsonDoc(store: StorageLike | null, key: string): unknown {
  if (!store) return undefined;
  try {
    const raw = store.getItem(key);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Write a JSON doc. Quota/full/private-mode surfaces as { ok: false }. Never throws. */
export function writeJsonDoc(
  store: StorageLike | null,
  key: string,
  value: unknown,
): { ok: boolean; quota: boolean } {
  if (!store) return { ok: false, quota: false };
  try {
    store.setItem(key, JSON.stringify(value));
    return { ok: true, quota: false };
  } catch (e) {
    return { ok: false, quota: isQuotaError(e) };
  }
}

export interface PersistMessages {
  quotaMessage: string;
  failureMessage: string;
}

/** Map a write outcome to the persistError surface (null = healthy). Pure. */
export function persistErrorFor(result: { ok: boolean; quota: boolean }, messages: PersistMessages): string | null {
  if (result.ok) return null;
  return result.quota ? messages.quotaMessage : messages.failureMessage;
}

export interface LocalDocList<D> {
  items: D[];
  activeId: string | null;
}

/**
 * Load a persisted {items, activeId} pair: parse, migrate legacy keys,
 * validate the active id, guarantee a non-empty list. Pure over injected
 * storage — the domain loader decides shapes, this decides structure.
 */
export function loadDocList<D>(opts: {
  store: StorageLike | null;
  itemsKey: string;
  activeKey: string;
  parseItems: (raw: unknown) => D[];
  migrate?: (store: StorageLike | null) => D[];
  getId: (d: D) => string;
  freshItem: () => D;
  sort?: (items: D[]) => D[];
  /** Corrupt-entry fallback: "empty" (Chat: swallow → []/null) or "fresh"
   *  (Makalah: reset to one fresh draft). Matches each caller's historical
   *  catch path exactly. */
  onParseError?: "empty" | "fresh";
}): LocalDocList<D> {
  try {
    let items = opts.parseItems(readJsonDoc(opts.store, opts.itemsKey));
    if (!items.length && opts.migrate) items = opts.migrate(opts.store);
    if (!items.length) items = [opts.freshItem()];
    let activeId = opts.store?.getItem(opts.activeKey) ?? null;
    if (!activeId || !items.some((d) => opts.getId(d) === activeId)) activeId = opts.getId(items[0]);
    const sorted = opts.sort ? opts.sort(items) : items;
    return { items: sorted, activeId };
  } catch {
    if (opts.onParseError === "empty") return { items: [], activeId: null };
    const fresh = opts.freshItem();
    return { items: [fresh], activeId: opts.getId(fresh) };
  }
}

export interface LocalStorageList<D> {
  items: D[];
  activeId: string | null;
  setItems: React.Dispatch<React.SetStateAction<D[]>>;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
  hydrated: boolean;
  persistError: string | null;
}

/**
 * useLocalStorageDoc-style hook for list+active documents (chats, drafts):
 * effect-hydrates once, persists items on change (quota-aware), persists the
 * active id on change. Identical timing to the code it replaces.
 */
export function useLocalStorageList<D>(opts: {
  itemsKey: string;
  activeKey: string;
  parseItems: (raw: unknown) => D[];
  migrate?: (store: StorageLike | null) => D[];
  getId: (d: D) => string;
  freshItem: () => D;
  sort?: (items: D[]) => D[];
  onParseError?: "empty" | "fresh";
  messages: PersistMessages;
  store?: StorageLike | null;
}): LocalStorageList<D> {
  const [items, setItems] = useState<D[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);

  useEffect(() => {
    const store = opts.store ?? browserStorage();
    const loaded = loadDocList({ ...opts, store });
    setItems(loaded.items);
    setActiveId(loaded.activeId);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deps mirror the code this replaces ([items]/[activeId] + hydrated):
  // option objects are render-stable by convention (module constants).
  useEffect(() => {
    if (!hydrated) return;
    const store = opts.store ?? browserStorage();
    setPersistError(persistErrorFor(writeJsonDoc(store, opts.itemsKey, items), opts.messages));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const store = opts.store ?? browserStorage();
    try {
      store?.setItem(opts.activeKey, activeId || "");
    } catch {
      /* active pointer is disposable; the list is the source of truth */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, hydrated]);

  return { items, activeId, setItems, setActiveId, hydrated, persistError };
}

export interface LocalStorageDoc<T> {
  value: T;
  setValue: React.Dispatch<React.SetStateAction<T>>;
  hydrated: boolean;
  persistError: string | null;
}

/**
 * useLocalStorageDoc-style hook for a single settings document: loads once
 * (sanitized), writes through on every set (quota-aware). Same write-through
 * timing InferenceContext always had.
 */
export function useLocalStorageDoc<T>(opts: {
  key: string;
  defaults: T;
  sanitize: (raw: unknown, defaults: T) => T;
  messages: PersistMessages;
  store?: StorageLike | null;
}): LocalStorageDoc<T> {
  const [value, setValueState] = useState<T>(opts.defaults);
  const [hydrated, setHydrated] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);

  useEffect(() => {
    const store = opts.store ?? browserStorage();
    const raw = readJsonDoc(store, opts.key);
    if (raw !== undefined) setValueState(opts.sanitize(raw, opts.defaults));
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setValue: React.Dispatch<React.SetStateAction<T>> = (action) => {
    setValueState((prev) => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      const store = opts.store ?? browserStorage();
      setPersistError(persistErrorFor(writeJsonDoc(store, opts.key, next), opts.messages));
      return next;
    });
  };

  return { value, setValue, hydrated, persistError };
}
