// Minimal static server for local preview of web/. No dependencies.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/common.js";

const WEB = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.normalize(path.join(WEB, urlPath));
    if (!file.startsWith(WEB)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Reader Map at http://localhost:${PORT}`));
