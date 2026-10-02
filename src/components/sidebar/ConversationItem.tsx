"use client";
import { Copy, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { api, refreshConversations } from "@/hooks/api";
import { useApp } from "@/hooks/useApp";
import { cn } from "@/lib/utils/cn";
import type { ConversationSummary } from "@/types";

export function ConversationItem({ conv, active }: { conv: ConversationSummary; active: boolean }) {
  const router = useRouter();
  const { setMobileOpen } = useApp();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [title, setTitle] = useState(conv.title);

  const patch = async (body: object) => {
    await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: JSON.stringify(body) });
    await refreshConversations();
  };

  const duplicate = async () => {
    const copy = await api<ConversationSummary>(`/api/conversations/${conv.id}/duplicate`, { method: "POST" });
    await refreshConversations();
    router.push(`/c/${copy.id}`);
  };

  const remove = async () => {
    await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
    setDeleting(false);
    await refreshConversations();
    if (active) router.push("/");
  };

  return (
    <div className={cn("group relative flex items-center rounded-md", active ? "bg-surface-2" : "hover:bg-surface-2/60")}>
      <Link
        href={`/c/${conv.id}`}
        onClick={() => setMobileOpen(false)}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-sm"
        title={conv.title}
      >
        {conv.pinned && <Pin size={12} className="shrink-0 text-muted" />}
        <span className="truncate">{conv.title}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Conversation options"
            className="mr-1 h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
          >
            <MoreHorizontal size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil size={14} /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => patch({ pinned: !conv.pinned })}>
            {conv.pinned ? <PinOff size={14} /> : <Pin size={14} />} {conv.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={duplicate}>
            <Copy size={14} /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => setDeleting(true)}>
            <Trash2 size={14} /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent title="Rename conversation">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (title.trim()) await patch({ title });
              setRenaming(false);
            }}
            className="flex flex-col gap-4"
          >
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Title" />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent title="Delete conversation?" description={`“${conv.title}” and all its messages will be permanently deleted.`}>
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
