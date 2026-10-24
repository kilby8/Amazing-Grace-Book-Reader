// Test helper: serve the pinned CDN files (pdf.js, JSZip) from CDN_DIR to a
// headless Chrome that can't reach cdnjs. Chrome is pointed at a local HTTPS
// server for cdnjs.cloudflare.com instead of using Puppeteer request
// interception, which stalls pdf.js's worker in about one open in four.
//
//   const cdn = await startCdn(process.env.CDN_DIR);   // null without CDN_DIR
//   puppeteer.launch({ args: [...cdn.chromeArgs] }); ... cdn.close();
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export async function startCdn(dir) {
  if (!dir) return null;
  const tmp = mkdtempSync(join(tmpdir(), "agr-cdn-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=cdnjs.cloudflare.com",
    "-keyout", join(tmp, "key.pem"), "-out", join(tmp, "cert.pem"),
  ], { stdio: "ignore" });
  const server = https.createServer({ key: readFileSync(join(tmp, "key.pem")), cert: readFileSync(join(tmp, "cert.pem")) }, (req, res) => {
    // /ajax/libs/<lib>/<version>/<file>  ->  CDN_DIR/<lib>/<file>
    const m = new URL(req.url, "https://x").pathname.match(/^\/ajax\/libs\/([^/]+)\/[^/]+\/(.+)$/);
    const file = m && normalize(join(dir, m[1], m[2]));
    if (!file || !file.startsWith(normalize(dir)) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    // Other outside hosts (web fonts) fail fast instead of hanging.
    chromeArgs: [
      `--host-resolver-rules=MAP cdnjs.cloudflare.com:443 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`,
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
    close() { server.close(); rmSync(tmp, { recursive: true, force: true }); },
  };
}
