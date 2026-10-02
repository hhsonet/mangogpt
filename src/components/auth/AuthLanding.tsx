"use client";
import { ArrowRight, Check, Cpu, Eye, EyeOff, Layers, Loader2, Lock, ShieldCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { cn } from "@/lib/utils/cn";

// Mirrors the server check (the server is the source of truth).
const UIU_EMAIL = /^[a-z0-9._%+-]+@([a-z0-9-]+\.)+uiu\.ac\.bd$/;

type Mode = "signin" | "signup";
type Notice = { tone: "error" | "info"; text: string } | null;

const FEATURES = [
  { icon: Cpu, title: "Runs on your own GPU", text: "Models run on a server you control, not in someone else’s cloud." },
  { icon: ShieldCheck, title: "Private by design", text: "Conversations and files stay on this server." },
  { icon: Layers, title: "Built for daily work", text: "Projects, search, and a full history you can pick back up." },
];

function PasswordField({ id, label, value, onChange, autoComplete, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <Input id={id} type={show ? "text" : "password"} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} className="pr-10" />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted hover:text-fg"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        notice.tone === "error" ? "border-danger/40 bg-danger/10" : "border-accent/40 bg-accent/10",
      )}
    >
      {notice.text}
    </p>
  );
}

function Panel() {
  const params = useSearchParams();
  const { data: cfg } = useSWR<{ signupMode: "closed" | "approval" | "open" }>("/api/auth/config", (u: string) => fetch(u).then((r) => r.json()), { revalidateOnFocus: false });
  const signupOpen = cfg ? cfg.signupMode !== "closed" : true;
  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const effectiveMode: Mode = mode === "signup" && !signupOpen ? "signin" : mode;

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [requested, setRequested] = useState(false);

  const switchMode = (m: Mode) => {
    setMode(m);
    setNotice(null);
    setPassword("");
    setConfirm("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (effectiveMode === "signup") {
      if (!UIU_EMAIL.test(email.trim().toLowerCase())) return setNotice({ tone: "error", text: "Use your university email. It should look like name@department.uiu.ac.bd." });
      if (password.length < 10) return setNotice({ tone: "error", text: "Use at least 10 characters. A short phrase of random words works well." });
      if (password !== confirm) return setNotice({ tone: "error", text: "Passwords don’t match." });
    }
    setBusy(true);
    try {
      const res = await fetch(effectiveMode === "signin" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string; code?: string; status?: string } | null;
      if (res.ok) {
        if (effectiveMode === "signup" && body?.status === "pending") {
          setRequested(true);
        } else {
          // Full reload so no data from a previous session lingers in client caches.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload clears client caches
          window.location.assign("/");
        }
      } else {
        setNotice({ tone: body?.code === "pending" ? "info" : "error", text: body?.message ?? "Something went wrong. Please try again." });
      }
    } catch {
      setNotice({ tone: "error", text: "Can’t reach the server. Check your connection and try again." });
    }
    setBusy(false);
  };

  if (requested) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Check size={22} />
        </div>
        <h2 className="text-xl font-semibold">Request sent</h2>
        <p className="text-sm text-muted">An admin needs to approve your account before you can sign in. Check back soon.</p>
        <Button variant="outline" className="w-full" onClick={() => { setRequested(false); switchMode("signin"); }}>
          Back to sign in
        </Button>
      </div>
    );
  }

  const signup = effectiveMode === "signup";
  return (
    <div>
      {signupOpen && (
        <div role="tablist" aria-label="Account" className="mb-6 grid grid-cols-2 rounded-lg border border-border bg-bg p-0.5">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={effectiveMode === m}
              onClick={() => switchMode(m)}
              className={cn("h-9 cursor-pointer rounded-md text-sm font-medium transition-colors", effectiveMode === m ? "bg-surface-2" : "text-muted hover:text-fg")}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
      )}
      <h2 className="text-xl font-semibold">{signup ? "Create your account" : "Welcome back"}</h2>
      <p className="mb-5 mt-1 text-sm text-muted">
        {signup
          ? cfg?.signupMode === "open"
            ? "Pick a username and password. You’ll be signed in right away."
            : "An admin reviews new accounts before you can sign in."
          : "Sign in to pick up where you left off."}
      </p>

      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          {signup && (
            <div className="mb-4">
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
                University email
              </label>
              <Input id="email" type="email" autoFocus autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@department.uiu.ac.bd" value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="mt-1.5 text-xs text-muted">Only @***.uiu.ac.bd addresses can sign up.</p>
            </div>
          )}
          <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
            {signup ? "Username" : "Username or email"}
          </label>
          <Input id="username" autoFocus={!signup} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          {signup && <p className="mt-1.5 text-xs text-muted">2–32 letters, numbers, dots, dashes or underscores.</p>}
        </div>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete={signup ? "new-password" : "current-password"}
          hint={signup ? "At least 10 characters. A short phrase of random words works well." : undefined}
        />
        {signup && <PasswordField id="confirm" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />}
        <NoticeBox notice={notice} />
        <Button type="submit" variant="primary" size="md" className="h-10 w-full" disabled={busy || !username || !password || (signup && !email)}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy ? (signup ? "Creating account…" : "Signing in…") : signup ? "Create account" : "Sign in"}
          {!busy && <ArrowRight size={16} />}
        </Button>
      </form>

      {!signupOpen && <p className="mt-5 text-center text-sm text-muted">Sign-ups are closed. Ask an admin to create an account for you.</p>}
    </div>
  );
}

export function AuthLanding() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-surface p-12 lg:flex">
        <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-accent/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <Lock size={16} />
          </span>
          {APP_NAME}
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            {APP_TAGLINE.split(". ").map((part, i, all) => (
              <span key={part} className="block">
                {i < all.length - 1 ? `${part}.` : part}
              </span>
            ))}
          </h1>
          <p className="mt-4 text-base text-muted">A private AI workspace that runs on a server you control. Nothing you write leaves it.</p>
          <ul className="mt-10 space-y-6">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-accent">
                  <Icon size={17} />
                </span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="text-sm text-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted">Powered by Ollama · Encrypted in transit</p>
      </section>

      <main className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 text-lg font-semibold tracking-tight lg:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
              <Lock size={16} />
            </span>
            {APP_NAME}
          </div>
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
          <p className="mt-8 text-center text-xs text-muted lg:hidden">{APP_TAGLINE}</p>
        </div>
      </main>
    </div>
  );
}
