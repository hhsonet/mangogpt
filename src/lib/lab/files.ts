const LANG: Record<string, string> = {
  py: "python", ipynb: "json", json: "json", md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  js: "javascript", mjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", html: "html", css: "css", scss: "scss",
  sh: "shell", bash: "shell", sql: "sql", r: "r", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cu: "cpp", cuh: "cpp", java: "java", go: "go", rs: "rust", xml: "xml", txt: "plaintext", csv: "plaintext", log: "plaintext",
};
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
export const languageFor = (name: string) => LANG[extOf(name)] ?? "plaintext";
export const isImageFile = (name: string) => IMAGES.has(extOf(name));
export const isNotebookFile = (name: string) => name.endsWith(".ipynb");
/** Files we are willing to try opening in the text editor (the server still checks size and encoding). */
export const isProbablyText = (name: string, size: number) => size <= 2 * 1024 * 1024 && !["zip", "gz", "tar", "pt", "pth", "bin", "npy", "npz", "parquet", "pdf", "so", "whl", "onnx", "safetensors", "ckpt", "h5"].includes(extOf(name));
export const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
export const baseOf = (path: string) => path.split("/").pop() ?? path;
export const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
