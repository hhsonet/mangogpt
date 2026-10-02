"use client";
import { MessageSquare, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConversations } from "@/hooks/api";
import { useApp } from "@/hooks/useApp";
import { formatDate } from "@/lib/utils/format";

export function SearchDialog() {
  const { searchOpen, setSearchOpen, setMobileOpen } = useApp();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const { conversations } = useConversations(debounced);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const open = (id: string) => {
    setSearchOpen(false);
    setMobileOpen(false);
    setQuery("");
    router.push(`/c/${id}`);
  };

  return (
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
      <DialogContent title="Search conversations" description="Searches titles and message text." className="max-w-xl">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="pl-9" aria-label="Search" />
        </div>
        <ul className="mt-3 max-h-[50vh] overflow-y-auto">
          {conversations.slice(0, 30).map((c) => (
            <li key={c.id}>
              <button onClick={() => open(c.id)} className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-2">
                <MessageSquare size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                <span className="shrink-0 text-xs text-muted">{formatDate(c.updatedAt)}</span>
              </button>
            </li>
          ))}
          {conversations.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-muted">No conversations found.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
