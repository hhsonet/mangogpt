"use client";
import { Check, Copy, Dices } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/api";

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword(length = 16) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function PasswordInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" aria-label="Password" />
      <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" title="Generate a strong password" aria-label="Generate password" onClick={() => onChange(generatePassword())}>
        <Dices size={16} />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        title="Copy password"
        aria-label="Copy password"
        disabled={!value}
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </Button>
    </div>
  );
}

export function AddUserDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, email: email || undefined, password, role }) });
      setUsername("");
      setEmail("");
      setPassword("");
      setRole("user");
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add user" description="The account is active immediately. Share the password with them securely.">
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">Username</span>
            <Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" spellCheck={false} />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">Email <span className="font-normal text-muted">(optional)</span></span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@department.uiu.ac.bd" autoCapitalize="none" spellCheck={false} />
          </label>
          <div className="text-sm">
            <span className="mb-1.5 block font-medium">Password</span>
            <PasswordInput value={password} onChange={setPassword} />
          </div>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">Role</span>
            <select value={role} onChange={(e) => setRole(e.target.value as "user" | "admin")} className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy || !username || !password}>
              Add user
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({ user, onClose, onDone }: { user: { id: string; username: string } | null; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const close = () => {
    setPassword("");
    setError("");
    setDone(false);
    onClose();
  };
  const save = async () => {
    if (!user) return;
    setError("");
    try {
      await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setDone(true);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Dialog open={Boolean(user)} onOpenChange={(o) => !o && close()}>
      <DialogContent title={`Reset password for ${user?.username ?? ""}`} description="Their current password stops working immediately. Active sessions stay signed in until they expire.">
        {done ? (
          <div className="space-y-4">
            <p className="text-sm">Password updated. Share it with {user?.username} securely. It won’t be shown again.</p>
            <PasswordInput value={password} onChange={setPassword} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <PasswordInput value={password} onChange={setPassword} />
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!password} onClick={save}>
                Set password
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent title={title} description={description}>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onCancel}>
            Keep user
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
