"use client";
import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

const DARK = { background: "#121214", foreground: "#e4e4e7", cursor: "#2dd4bf", selectionBackground: "#3f3f46" };
const LIGHT = { background: "#f6f6f7", foreground: "#18181b", cursor: "#0d9488", selectionBackground: "#d4d4d8", black: "#18181b" };

interface Props {
  projectId: string;
  terminalId: string;
  /** Visible right now. Hidden terminals stay connected but cannot measure themselves, so they re-fit when shown. */
  active: boolean;
  onEnded: () => void;
}

/** One xterm.js screen wired to a server shell. The shell keeps running if the page closes; reconnecting replays the recent output. */
export function TerminalView({ projectId, terminalId, active, onEnded }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? LIGHT : DARK;
  const themeRef = useRef(theme);
  const endedRef = useRef(onEnded);

  useEffect(() => {
    themeRef.current = theme;
    endedRef.current = onEnded;
    if (term.current) term.current.options.theme = theme;
  });

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let exited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ro: ResizeObserver | undefined;

    const send = (m: Record<string, unknown>) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/lab-ws/v1/projects/${projectId}/terminals/${terminalId}`);
      ws.onopen = () => {
        retry = 0;
        const t = term.current;
        if (t) send({ type: "resize", cols: t.cols, rows: t.rows });
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string) as { type: string; data?: string };
        const t = term.current;
        if (!t) return;
        if (m.type === "replay") {
          t.reset();
          t.write(m.data ?? "");
        } else if (m.type === "output") t.write(m.data ?? "");
        else if (m.type === "exit") {
          exited = true;
          t.write("\r\n\x1b[2m[The shell has ended. Close this tab or open a new terminal.]\x1b[0m\r\n");
          endedRef.current();
        }
      };
      ws.onclose = () => {
        if (disposed || exited) return;
        if (retry < 5) timer = setTimeout(connect, 600 * ++retry);
        else term.current?.write("\r\n\x1b[2m[Disconnected. The terminal may have been closed.]\x1b[0m\r\n");
      };
    };

    void (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-web-links")]);
      if (disposed || !box.current) return;
      const t = new Terminal({ fontFamily: "var(--font-jetbrains), ui-monospace, monospace", fontSize: 13, cursorBlink: true, scrollback: 5000, theme: themeRef.current, allowProposedApi: false });
      const f = new FitAddon();
      t.loadAddon(f);
      t.loadAddon(new WebLinksAddon());
      t.open(box.current);
      t.attachCustomKeyEventHandler((e) => {
        // Ctrl+C copies when text is selected; otherwise it goes to the shell as an interrupt
        if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && t.hasSelection()) {
          void navigator.clipboard?.writeText(t.getSelection());
          return false;
        }
        return true;
      });
      term.current = t;
      fit.current = f;
      try {
        f.fit();
      } catch {
        /* not measurable yet */
      }
      t.onData((d) => send({ type: "input", data: d }));
      t.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
      ro = new ResizeObserver(() => {
        try {
          if (box.current && box.current.offsetParent !== null) f.fit();
        } catch {
          /* ignore */
        }
      });
      ro.observe(box.current);
      connect();
    })();

    return () => {
      disposed = true;
      clearTimeout(timer);
      ro?.disconnect();
      ws?.close(1000);
      term.current?.dispose();
      term.current = null;
    };
  }, [projectId, terminalId]);

  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
        term.current?.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return <div ref={box} className="h-full w-full overflow-hidden px-2 py-1" style={{ backgroundColor: theme.background }} aria-label="Terminal" />;
}
