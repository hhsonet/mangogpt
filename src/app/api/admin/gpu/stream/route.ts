import { ensureSampler, pushToRing, takeSample } from "@/lib/monitor/sampler";
import { authed } from "../../../_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** Server-sent events: a fresh sample every 2 seconds until the admin closes the page. */
export async function GET(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  ensureSampler();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const push = async () => {
        if (closed) return;
        try {
          const s = await takeSample();
          pushToRing(s);
          controller.enqueue(encoder.encode(`event: sample\ndata: ${JSON.stringify(s)}\n\n`));
        } catch {
          close();
        }
      };
      req.signal.addEventListener("abort", close);
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      void push();
      timer = setInterval(push, 2000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
