"use client";
import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
};

/** Boolean persisted in localStorage; SSR-safe (renders `fallback` on the server). */
export function useLocalFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw === "1";
      } catch {
        return fallback;
      }
    },
    () => fallback,
  );
  const set = useCallback(
    (v: boolean) => {
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}

const noop = () => () => undefined;
/** True after hydration. */
export const useMounted = () =>
  useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
