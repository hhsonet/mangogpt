"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocalFlag } from "./useLocalFlag";

interface AppContextValue {
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  /** Bumped by "New chat" so the chat view resets even if already on "/". */
  chatNonce: number;
  newChat: () => void;
}

const Ctx = createContext<AppContextValue | null>(null);
const COLLAPSE_KEY = "sidebar-collapsed";

export function AppProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useLocalFlag(COLLAPSE_KEY, false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatNonce, setChatNonce] = useState(0);

  const toggleCollapsed = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  const newChat = useCallback(() => {
    setChatNonce((n) => n + 1);
    setMobileOpen(false);
    router.push("/");
    setTimeout(() => document.getElementById("composer-input")?.focus(), 50);
  }, [router]);

  // Global shortcuts: Ctrl/Cmd+K search, Ctrl/Cmd+N new chat, Ctrl/Cmd+/ focus prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (k === "n" || (k === "o" && e.shiftKey)) {
        // Browsers often reserve Ctrl+N; Ctrl+Shift+O is the reliable alternative.
        e.preventDefault();
        newChat();
      } else if (k === "/") {
        e.preventDefault();
        document.getElementById("composer-input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  const value = useMemo(
    () => ({ mobileOpen, setMobileOpen, collapsed, toggleCollapsed, searchOpen, setSearchOpen, chatNonce, newChat }),
    [mobileOpen, collapsed, toggleCollapsed, searchOpen, chatNonce, newChat],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
