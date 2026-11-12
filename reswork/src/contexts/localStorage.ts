"use client";

import { useCallback, useEffect, useReducer, useRef, type Dispatch, type SetStateAction } from "react";

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

interface ListState<D> {
  items: D[];
  activeId: string | null;
  hydrated: boolean;
  persistError: string | null;
}

type ListAction<D> =
  | { type: "hydrate"; items: D[]; activeId: string | null }
  | { type: "setItems"; action: SetStateAction<D[]> }
  | { type: "setActiveId"; action: SetStateAction<string | null> }
  | { type: "persistResult"; error: string | null };

/**
 * Hydration + persistence transitions live in one reducer so the storage
 * effect dispatches a single state transition instead of cascading setters.
 * Functional updaters are applied against the reducer's current value, which
 * preserves React's setState semantics.
 */
function listReducer<D>(state: ListState<D>, action: ListAction<D>): ListState<D> {
  switch (action.type) {
    case "hydrate":
      return { ...state, items: action.items, activeId: action.activeId, hydrated: true };
    case "setItems": {
      const items =
        typeof action.action === "function"
          ? (action.action as (prev: D[]) => D[])(state.items)
          : action.action;
      return items === state.items ? state : { ...state, items };
    }
    case "setActiveId": {
      const activeId =
        typeof action.action === "function"
          ? (action.action as (prev: string | null) => string | null)(state.activeId)
          : action.action;
      return activeId === state.activeId ? state : { ...state, activeId };
    }
    case "persistResult":
      return state.persistError === action.error ? state : { ...state, persistError: action.error };
  }
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
  const [state, dispatch] = useReducer(listReducer<D>, {
    items: [],
    activeId: null,
    hydrated: false,
    persistError: null,
  });

  useEffect(() => {
    const store = opts.store ?? browserStorage();
    const loaded = loadDocList({ ...opts, store });
    dispatch({ type: "hydrate", items: loaded.items, activeId: loaded.activeId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deps mirror the code this replaces ([items]/[activeId] + hydrated):
  // option objects are render-stable by convention (module constants).
  useEffect(() => {
    if (!state.hydrated) return;
    const store = opts.store ?? browserStorage();
    dispatch({
      type: "persistResult",
      error: persistErrorFor(writeJsonDoc(store, opts.itemsKey, state.items), opts.messages),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.items, state.hydrated]);

  useEffect(() => {
    if (!state.hydrated) return;
    const store = opts.store ?? browserStorage();
    try {
      store?.setItem(opts.activeKey, state.activeId || "");
    } catch {
      /* active pointer is disposable; the list is the source of truth */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId, state.hydrated]);

  const setItems = useCallback<Dispatch<SetStateAction<D[]>>>(
    (action) => dispatch({ type: "setItems", action }),
    [],
  );
  const setActiveId = useCallback<Dispatch<SetStateAction<string | null>>>(
    (action) => dispatch({ type: "setActiveId", action }),
    [],
  );

  return {
    items: state.items,
    activeId: state.activeId,
    setItems,
    setActiveId,
    hydrated: state.hydrated,
    persistError: state.persistError,
  };
}

export interface LocalStorageDoc<T> {
  value: T;
  setValue: React.Dispatch<React.SetStateAction<T>>;
  hydrated: boolean;
  persistError: string | null;
}

interface DocState<T> {
  value: T;
  hydrated: boolean;
  persistError: string | null;
}

type DocAction<T> =
  | { type: "hydrate"; value: T }
  | { type: "set"; action: SetStateAction<T> }
  | { type: "persistResult"; error: string | null };

function docReducer<T>(state: DocState<T>, action: DocAction<T>): DocState<T> {
  switch (action.type) {
    case "hydrate":
      return { ...state, value: action.value, hydrated: true };
    case "set": {
      const value =
        typeof action.action === "function"
          ? (action.action as (prev: T) => T)(state.value)
          : action.action;
      return value === state.value ? state : { ...state, value };
    }
    case "persistResult":
      return state.persistError === action.error ? state : { ...state, persistError: action.error };
  }
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
  const [state, dispatch] = useReducer(docReducer<T>, {
    value: opts.defaults,
    hydrated: false,
    persistError: null,
  });
  // Hydration itself must not write: the first persist effect run is the
  // hydration commit, matching the previous write-on-set-only behavior.
  const hydratedOnce = useRef(false);

  useEffect(() => {
    const store = opts.store ?? browserStorage();
    const raw = readJsonDoc(store, opts.key);
    dispatch({
      type: "hydrate",
      value: raw !== undefined ? opts.sanitize(raw, opts.defaults) : opts.defaults,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    if (!hydratedOnce.current) {
      hydratedOnce.current = true;
      return;
    }
    const store = opts.store ?? browserStorage();
    dispatch({
      type: "persistResult",
      error: persistErrorFor(writeJsonDoc(store, opts.key, state.value), opts.messages),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.value, state.hydrated]);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => dispatch({ type: "set", action }),
    [],
  );

  return {
    value: state.value,
    setValue,
    hydrated: state.hydrated,
    persistError: state.persistError,
  };
}
