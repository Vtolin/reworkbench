"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface CitationStyle {
  id: string;
  title: string;
  custom?: boolean;
}

export interface CitationSettings {
  styles: CitationStyle[];
  defaultStyle: string;
  setDefaultStyle: (style: string) => Promise<void>;
  fetchStyle: (id: string) => Promise<string>;
  addCustomStyle: (xml: string) => Promise<string>;
  message: string | null;
  setMessage: (msg: string | null) => void;
}

/**
 * One owner for CSL style state so the Citation and Import/Export cards can
 * never disagree about which style is the default.
 */
export function useCitationSettings(): CitationSettings {
  const [styles, setStyles] = useState<CitationStyle[]>([]);
  const [defaultStyle, setDefaultStyleState] = useState("apa");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .citationStyles()
      .then((r) => {
        setStyles(r.styles ?? []);
        setDefaultStyleState(r.default ?? "apa");
      })
      .catch(() => {});
  }, []);

  const setDefaultStyle = async (style: string) => {
    setDefaultStyleState(style);
    try {
      await api.citationStyleDefault(style);
      setMessage("Default saved");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save default style");
    }
  };

  const fetchStyle = async (id: string) => {
    const r = await api.citationStyleFetch(id);
    setStyles(r.styles ?? []);
    const title = r.style.title;
    setMessage(`Fetched: ${title}`);
    return title;
  };

  const addCustomStyle = async (xml: string) => {
    const r = await api.citationStyleCustom(xml);
    setStyles(r.styles ?? []);
    setMessage("Custom style added - select 'Custom CSL' above");
    return "Custom CSL";
  };

  return { styles, defaultStyle, setDefaultStyle, fetchStyle, addCustomStyle, message, setMessage };
}
