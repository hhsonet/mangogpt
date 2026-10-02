// TLS front door: the Next.js app stays on 127.0.0.1; only this proxy listens on the network.
// Usage: node scripts/https-proxy.mjs   (env: TLS_PORT=3443, TLS_HOST=0.0.0.0, APP_PORT=3000)
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const TLS_PORT = Number(process.env.TLS_PORT ?? 3443);
const TLS_HOST = process.env.TLS_HOST ?? "0.0.0.0";
const APP_PORT = Number(process.env.APP_PORT ?? 3000);

const server = https.createServer(
  { key: fs.readFileSync(new URL("../certs/server.key", import.meta.url)), cert: fs.readFileSync(new URL("../certs/server.crt", import.meta.url)), minVersion: "TLSv1.2" },
  (req, res) => {
    const headers = { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-for": req.socket.remoteAddress ?? "" };
    const upstream = http.request({ host: "127.0.0.1", port: APP_PORT, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res); // streamed, so token-by-token output is not buffered
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("App is not running.");
    });
    res.on("close", () => upstream.destroy()); // client gone / Stop pressed: cancel upstream
    req.pipe(upstream);
  },
);
server.listen(TLS_PORT, TLS_HOST, () => console.log(`HTTPS proxy on ${TLS_HOST}:${TLS_PORT} -> 127.0.0.1:${APP_PORT}`));
