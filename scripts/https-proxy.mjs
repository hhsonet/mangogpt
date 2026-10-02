// Gateway: the only thing that listens on the network. It terminates TLS and routes by path:
//   /lab-api/*  /lab-ws/*  ->  MangoLab control plane (FastAPI, 127.0.0.1:8200), including WebSockets
//   everything else        ->  the MangoGPT app (Next.js, 127.0.0.1:3000)
// Usage: node scripts/https-proxy.mjs
// Env:   TLS_PORT=3443  TLS_HOST=0.0.0.0  PLAIN_PORT=3080 (loopback, for SSH tunnels / cloudflared; 0 disables)
//        APP_PORT=3000  LAB_PORT=8200
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const TLS_PORT = Number(process.env.TLS_PORT ?? 3443);
const TLS_HOST = process.env.TLS_HOST ?? "0.0.0.0";
const PLAIN_PORT = Number(process.env.PLAIN_PORT ?? 3080);
const APP_PORT = Number(process.env.APP_PORT ?? 3000);
const LAB_PORT = Number(process.env.LAB_PORT ?? 8200);

const isLabPath = (url = "") => url.startsWith("/lab-api/") || url === "/lab-api" || url.startsWith("/lab-ws/");
const targetPort = (url) => (isLabPath(url) ? LAB_PORT : APP_PORT);

function makeHandler(proto) {
  return (req, res) => {
    // Behind another TLS terminator (e.g. a tunnel) keep what it told us; otherwise state our own scheme.
    const forwardedProto = proto === "https" ? "https" : (req.headers["x-forwarded-proto"] ?? "http");
    const headers = { ...req.headers, "x-forwarded-proto": forwardedProto, "x-forwarded-for": req.socket.remoteAddress ?? "" };
    const upstream = http.request({ host: "127.0.0.1", port: targetPort(req.url), method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res); // streamed, so token-by-token output is not buffered
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(isLabPath(req.url) ? "MangoLab service is not running." : "App is not running.");
    });
    res.on("close", () => upstream.destroy()); // client gone / Stop pressed: cancel upstream
    req.pipe(upstream);
  };
}

/** WebSocket upgrades are only allowed for /lab-ws/ (nothing else in the app uses them). */
function makeUpgrade(proto) {
  return (req, socket, head) => {
    if (!(req.url ?? "").startsWith("/lab-ws/")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const up = net.connect(LAB_PORT, "127.0.0.1", () => {
      const forwardedProto = proto === "https" ? "https" : (req.headers["x-forwarded-proto"] ?? "http");
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^x-forwarded-(proto|for)$/i.test(k)) continue;
        raw += `${k}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      raw += `X-Forwarded-Proto: ${forwardedProto}\r\nX-Forwarded-For: ${req.socket.remoteAddress ?? ""}\r\n\r\n`;
      up.write(raw);
      if (head?.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    const close = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", close);
    socket.on("error", close);
    socket.on("close", () => up.destroy());
  };
}

const tls = https.createServer(
  { key: fs.readFileSync(new URL("../certs/server.key", import.meta.url)), cert: fs.readFileSync(new URL("../certs/server.crt", import.meta.url)), minVersion: "TLSv1.2" },
  makeHandler("https"),
);
tls.on("upgrade", makeUpgrade("https"));
tls.listen(TLS_PORT, TLS_HOST, () => console.log(`HTTPS gateway on ${TLS_HOST}:${TLS_PORT} -> app :${APP_PORT}, MangoLab :${LAB_PORT}`));

if (PLAIN_PORT > 0) {
  const plain = http.createServer(makeHandler("http"));
  plain.on("upgrade", makeUpgrade("http"));
  plain.listen(PLAIN_PORT, "127.0.0.1", () => console.log(`Plain gateway on 127.0.0.1:${PLAIN_PORT} (tunnels only)`));
}
