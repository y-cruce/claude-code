import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

assert.ok(process.argv[2], "usage: node scripts/verify-settings-proxy.mjs <installed cli.js>");
const cli = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "cc-settings-proxy-"));
const servers = [];
const sockets = new Set();
const tunnelPorts = new Set();
const modelRoutes = [];
const host = "127.0.0.1";
let shellConnects = 0;

async function listen(server) {
  servers.push(server);
  server.on("connection", track);
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
}

function track(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

try {
  const certPath = join(root, "cert.pem");
  const keyPath = join(root, "key.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=IP:${host}`,
    "-keyout", keyPath, "-out", certPath,
  ], { stdio: "pipe", timeout: 5000 });

  const origin = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    if (req.method === "POST" && new URL(req.url, "https://localhost").pathname === "/v1/messages") {
      modelRoutes.push(tunnelPorts.has(req.socket.remotePort) ? "settings proxy" : "direct");
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_proxy_smoke", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "proxy smoke passed" }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const originPort = await listen(origin);

  const settingsProxy = createHttpServer().on("connect", (req, socket) => {
    if (req.url !== `${host}:${originPort}`) {
      socket.end("HTTP/1.1 502 Unexpected destination\r\n\r\n");
      return;
    }
    const target = connect(originPort, host, () => {
      const port = target.localPort;
      tunnelPorts.add(port);
      target.once("close", () => tunnelPorts.delete(port));
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(target).pipe(socket);
    });
    track(target);
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
    socket.on("close", () => target.destroy());
  });
  const settingsPort = await listen(settingsProxy);
  const shellProxy = createHttpServer().on("connect", (_req, socket) => {
    shellConnects++;
    socket.end("HTTP/1.1 502 Wrong proxy\r\n\r\n");
  });
  const shellPort = await listen(shellProxy);
  await writeFile(join(root, "settings.json"), JSON.stringify({
    env: { HTTPS_PROXY: `http://${host}:${settingsPort}` },
  }));

  const { stdout } = await promisify(execFile)(process.execPath, [
    cli, "-p", "Proxy smoke test", "--model", "sonnet", "--output-format", "text",
  ], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: root,
      ANTHROPIC_CC_DATA_DIR: process.env.ANTHROPIC_CC_DATA_DIR,
      ANTHROPIC_API_KEY: "local-proxy-smoke-key",
      ANTHROPIC_BASE_URL: `https://${host}:${originPort}`,
      HTTPS_PROXY: `http://${host}:${shellPort}`,
      NODE_EXTRA_CA_CERTS: certPath,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    timeout: 15000,
    encoding: "utf8",
  });
  assert.equal(stdout.trim(), "proxy smoke passed");
  assert.ok(modelRoutes.length, "no model request reached the mock server");
  assert.ok(modelRoutes.every(route => route === "settings proxy"), `model request routes: ${modelRoutes.join(", ")}`);
  assert.equal(shellConnects, 0, "the launcher environment proxy received CONNECT");
  console.log("Model requests used the HTTPS_PROXY from settings.json");
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(done => server.close(done))));
  await rm(root, { recursive: true, force: true });
}
