"use client";
import { Activity, ArrowLeft, Cpu, Menu, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useApp } from "@/hooks/useApp";
import { cn } from "@/lib/utils/cn";

const TABS = [
  { href: "/admin", label: "Users", icon: Users },
  { href: "/admin/usage", label: "Usage & logs", icon: Activity },
  { href: "/admin/gpu", label: "GPU monitor", icon: Cpu },
];

export function AdminHeader() {
  const { setMobileOpen } = useApp();
  const pathname = usePathname();
  return (
    <div>
      <header className="flex h-12 items-center gap-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open sidebar">
          <Menu size={18} />
        </Button>
        <Link href="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft size={15} /> Back to chat
        </Link>
      </header>
      <nav aria-label="Admin sections" className="mb-5 mt-3 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn("-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm", active ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg")}
            >
              <Icon size={15} /> {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
