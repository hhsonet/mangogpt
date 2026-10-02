"use client";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useSettings } from "@/hooks/api";
import { AppProvider, useApp } from "@/hooks/useApp";
import { SearchDialog } from "./sidebar/SearchDialog";
import { Sidebar } from "./sidebar/Sidebar";

function Inner({ children }: { children: React.ReactNode }) {
  const { chatNonce } = useApp();
  const { settings } = useSettings();

  useEffect(() => {
    document.documentElement.dataset.font = settings?.fontSize ?? "md";
    document.documentElement.classList.toggle("compact", Boolean(settings?.compact));
  }, [settings?.fontSize, settings?.compact]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <main className="min-w-0 flex-1" key={chatNonce}>
        {children}
      </main>
      <SearchDialog />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  // The login page and the notebook workspace render full-bleed: no MangoGPT sidebar.
  const pathname = usePathname();
  if (pathname === "/login" || pathname.startsWith("/lab/p/")) return <>{children}</>;
  return (
    <AppProvider>
      <Inner>{children}</Inner>
    </AppProvider>
  );
}
