"use client";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useRef, useState } from "react";

// Monaco is served from our own origin (copied to public/monaco by scripts/copy-monaco.mjs): no CDN, works offline.
if (typeof window !== "undefined") loader.config({ paths: { vs: "/monaco/vs" } });

type Monaco = Parameters<NonNullable<React.ComponentProps<typeof Editor>["beforeMount"]>>[0];
type IEditor = Parameters<OnMount>[0];

function defineThemes(monaco: Monaco) {
  monaco.editor.defineTheme("mango-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#121214", "editor.lineHighlightBackground": "#1a1a1e", "editorGutter.background": "#121214" } });
  monaco.editor.defineTheme("mango-light", { base: "vs", inherit: true, rules: [], colors: { "editor.background": "#f6f6f7", "editor.lineHighlightBackground": "#eeeef0", "editorGutter.background": "#f6f6f7" } });
}

interface Props {
  value: string;
  language: string;
  onChange: (v: string) => void;
  /** Take keyboard focus when this becomes true (entering edit mode). */
  focused?: boolean;
  /** "cell" grows to fit its content and gives page scrolling back to the browser; "file" fills its container. */
  mode?: "cell" | "file";
  wordWrap?: boolean;
  readOnly?: boolean;
  onSave?: () => void;
  onShiftEnter?: () => void;
  onEscape?: () => void;
}

export function CodeEditor({ value, language, onChange, focused, mode = "cell", wordWrap, readOnly, onSave, onShiftEnter, onEscape }: Props) {
  const { resolvedTheme } = useTheme();
  const [height, setHeight] = useState(48);
  const editorRef = useRef<IEditor | null>(null);
  const wantFocus = useRef(focused);
  const handlers = useRef({ onSave, onShiftEnter, onEscape });
  useEffect(() => {
    handlers.current = { onSave, onShiftEnter, onEscape }; // Monaco's commands are long-lived: always call the latest callbacks
  }, [onSave, onShiftEnter, onEscape]);
  useEffect(() => {
    wantFocus.current = focused;
    if (focused) editorRef.current?.focus();
  }, [focused]);

  const onMount: OnMount = useCallback(
    (editor: IEditor, monaco) => {
      if (mode === "cell") {
        const fit = () => setHeight(Math.min(Math.max(editor.getContentHeight(), 48), 900));
        editor.onDidContentSizeChange(fit);
        fit();
      }
      editorRef.current = editor;
      const KM = monaco.KeyMod;
      const KC = monaco.KeyCode;
      editor.addCommand(KM.CtrlCmd | KC.KeyS, () => handlers.current.onSave?.());
      editor.addCommand(KM.Shift | KC.Enter, () => handlers.current.onShiftEnter?.());
      // Escape leaves edit mode, unless it is needed to close a popup (suggestions, find, hints).
      editor.addCommand(KC.Escape, () => handlers.current.onEscape?.(), "!suggestWidgetVisible && !findWidgetVisible && !parameterHintsVisible && !inSnippetMode && !renameInputVisible");
      if (wantFocus.current) editor.focus();
    },
    [mode],
  );

  return (
    <Editor
      height={mode === "cell" ? height : "100%"}
      language={language}
      value={value}
      theme={resolvedTheme === "light" ? "mango-light" : "mango-dark"}
      beforeMount={defineThemes}
      onMount={onMount}
      onChange={(v) => onChange(v ?? "")}
      loading={<div className="p-3 text-xs text-muted">Loading editor…</div>}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
        lineNumbers: mode === "cell" ? "on" : "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: wordWrap ? "on" : "off",
        renderLineHighlight: "line",
        padding: { top: 8, bottom: 8 },
        tabSize: 4,
        readOnly,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { alwaysConsumeMouseWheel: false, vertical: mode === "cell" ? "hidden" : "auto", horizontal: "auto" },
        fixedOverflowWidgets: true,
        folding: mode === "file",
        glyphMargin: false,
        lineDecorationsWidth: 8,
        contextmenu: true,
      }}
    />
  );
}
