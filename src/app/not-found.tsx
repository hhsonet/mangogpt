import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link href="/" className="text-accent underline">Back to chat</Link>
    </div>
  );
}
