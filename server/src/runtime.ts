// Runtime-agnostic polyfills — same codebase runs on Bun (x64) and Node.js (x86).
// Bun has no x86 Windows binary, so x86 builds ship Node.js instead.

import { readFile, writeFile, stat, unlink, readdir, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { WebSocketServer } from "ws";

export const IS_BUN = typeof (globalThis as any).Bun !== "undefined";

// ── File I/O ──────────────────────────────────────────────────────────────

export async function readTextFile(path: string): Promise<string> {
  if (IS_BUN) return (globalThis as any).Bun.file(path).text();
  return readFile(path, "utf-8");
}

export async function writeFileData(path: string, data: string | Uint8Array | Response): Promise<void> {
  if (IS_BUN) {
    await (globalThis as any).Bun.write(path, data);
    return;
  }
  if (data instanceof Response) {
    const buf = Buffer.from(await data.arrayBuffer());
    await writeFile(path, buf);
  } else if (typeof data === "string") {
    await writeFile(path, data, "utf-8");
  } else {
    await writeFile(path, data);
  }
}

export async function fileExists(path: string): Promise<boolean> {
  if (IS_BUN) return (globalThis as any).Bun.file(path).exists();
  try { await stat(path); return true; } catch { return false; }
}

export async function deleteFileData(path: string): Promise<void> {
  if (IS_BUN) {
    await (globalThis as any).Bun.file(path).delete?.().catch(() => {});
    return;
  }
  try { await unlink(path); } catch {}
}

export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (IS_BUN) return (globalThis as any).Bun.file(path).bytes();
  const buf = await readFile(path);
  return new Uint8Array(buf);
}

export function fileSizeSync(path: string): number {
  if (IS_BUN) return (globalThis as any).Bun.file(path).size;
  try {
    const { statSync } = require("node:fs");
    return statSync(path).size;
  } catch { return 0; }
}

export function globSync(pattern: string, opts: { cwd: string; absolute?: boolean }): string[] {
  if (IS_BUN) {
    return Array.from(new (globalThis as any).Bun.Glob(pattern).scanSync(opts));
  }
  // Node.js: simple glob for common patterns. For *.json, filter by extension.
  try {
    const { readdirSync } = require("node:fs");
    const files = readdirSync(opts.cwd) as string[];
    if (pattern === "*.json") {
      return files
        .filter((f: string) => f.endsWith(".json"))
        .map((f: string) => opts.absolute ? `${opts.cwd}/${f}` : f);
    }
    // Fallback: return all files matching the simple pattern
    const [prefix, suffix] = pattern.split("*");
    return files
      .filter((f: string) => f.startsWith(prefix || "") && f.endsWith(suffix || ""))
      .map((f: string) => opts.absolute ? `${opts.cwd}/${f}` : f);
  } catch { return []; }
}

export function createFileResponse(path: string): Response {
  if (IS_BUN) return new Response((globalThis as any).Bun.file(path));
  // Node.js: create a ReadableStream from the file
  try {
    const stream = createReadStream(path);
    const webStream = Readable.toWeb(stream) as ReadableStream;
    const { statSync } = require("node:fs");
    const size = statSync(path).size;
    return new Response(webStream, {
      headers: {
        "Content-Length": String(size),
        "Content-Type": contentTypeFromPath(path),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function contentTypeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const mime: Record<string, string> = {
    html: "text/html", htm: "text/html",
    css: "text/css",
    js: "application/javascript", mjs: "application/javascript",
    json: "application/json",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2",
    txt: "text/plain", xml: "application/xml",
    wasm: "application/wasm",
  };
  return mime[ext] || "application/octet-stream";
}

// ── Module directory (replaces import.meta.dir) ──────────────────────────

export function moduleDir(importMeta: ImportMeta): string {
  if (IS_BUN) return (importMeta as any).dir;
  // Node.js: derive from import.meta.url — pathname is percent-encoded, decode it
  let pathname = new URL(".", importMeta.url).pathname;
  // On Windows, file URL pathnames start with "/C:", strip the leading slash
  if (process.platform === "win32" && pathname.startsWith("/")) {
    pathname = pathname.slice(1);
  }
  return decodeURIComponent(pathname);
}

// ── Process management ────────────────────────────────────────────────────

export interface SpawnedProcess {
  pid: number;
  killed: boolean;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  kill(signal?: string): void;
  stdinWrite(data: Uint8Array): void;
  stdinFlush(): void;
  stdinEnd(): void;
}

export function spawnProcess(cmd: string, args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}): SpawnedProcess {
  if (IS_BUN) {
    const proc = (globalThis as any).Bun.spawn([cmd, ...args], opts);
    return {
      pid: proc.pid,
      get killed() { return proc.killed; },
      exited: proc.exited,
      stdout: proc.stdout,
      stderr: proc.stderr,
      stdin: proc.stdin,
      kill(signal?: string) { proc.kill(signal); },
      stdinWrite(data: Uint8Array) { proc.stdin.write(data); },
      stdinFlush() { proc.stdin.flush(); },
      stdinEnd() { proc.stdin.end(); },
    };
  }
  // Node.js: spawn and wrap to match Bun's ReadableStream API
  const nodeOpts: any = { ...opts };
  if (opts?.stdin === "pipe") nodeOpts.stdio = ["pipe", opts.stdout === "pipe" ? "pipe" : "inherit", opts.stderr === "pipe" ? "pipe" : "inherit"];
  else if (opts?.stdout === "pipe") nodeOpts.stdio = ["ignore", "pipe", opts?.stderr === "pipe" ? "pipe" : "inherit"];
  else nodeOpts.stdio = "inherit";

  const proc = nodeSpawn(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    stdio: nodeOpts.stdio,
    shell: process.platform === "win32",
  });

  const result: SpawnedProcess = {
    pid: proc.pid || 0,
    killed: false,
    exited: new Promise<number>((resolve) => {
      proc.on("exit", (code) => { result.killed = true; resolve(code || 0); });
      proc.on("error", () => { result.killed = true; resolve(-1); });
    }),
    stdout: Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(proc.stderr!) as ReadableStream<Uint8Array>,
    stdin: new WritableStream({
      write(chunk) { proc.stdin!.write(chunk); },
      close() { proc.stdin!.end(); },
      abort() { proc.stdin!.destroy(); },
    }),
    kill() { proc.kill(); },
    stdinWrite(data: Uint8Array) { proc.stdin!.write(data); },
    stdinFlush() { /* Node.js stdin is unbuffered — writes go through immediately */ },
    stdinEnd() { proc.stdin!.end(); },
  };
  return result;
}

export function spawnSync(cmd: string, args: string[], opts?: {
  cwd?: string;
  env?: Record<string, string>;
  stdout?: "pipe" | "inherit";
  stderr?: "pipe" | "inherit";
}): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } {
  if (IS_BUN) {
    return (globalThis as any).Bun.spawnSync([cmd, ...args], opts);
  }
  const result = nodeSpawnSync(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    shell: process.platform === "win32",
    encoding: "buffer",
  });
  return {
    exitCode: result.status ?? 0,
    stdout: new Uint8Array(result.stdout),
    stderr: new Uint8Array(result.stderr),
  };
}

// ── Stream helpers ────────────────────────────────────────────────────────

export async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ── HTTP + WebSocket server (Bun.serve polyfill for Node.js) ──────────────

export interface ServeWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
}

export interface ServeOptions {
  port: number;
  fetch(req: Request, server: { upgrade(req: Request): boolean }): Response | Promise<Response | undefined> | undefined;
  websocket?: {
    open(ws: ServeWebSocket): void;
    message(ws: ServeWebSocket, data: string | Buffer): void;
    close(ws: ServeWebSocket): void;
  };
}

export function serve(opts: ServeOptions): any {
  if (IS_BUN) {
    return (globalThis as any).Bun.serve(opts);
  }

  // ── Node.js implementation ──────────────────────────────────────────────

  const httpServer = http.createServer(async (nodeReq, nodeRes) => {
    // Build Web API Request from Node.js IncomingMessage
    const protocol = "http";
    const host = nodeReq.headers.host || `localhost:${opts.port}`;
    const url = `${protocol}://${host}${nodeReq.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeReq.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, String(value));
      }
    }

    let body: BodyInit | null | undefined;
    if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD" && nodeReq.method !== "OPTIONS") {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      body = Buffer.concat(chunks);
    }

    const req = new Request(url, {
      method: nodeReq.method || "GET",
      headers,
      body: body as any,
    });

    const serverShim = {
      upgrade(_req: Request): boolean {
        // WebSocket upgrades handled by ws on the 'upgrade' event — never true here.
        return false;
      },
    };

    try {
      const resp = await opts.fetch(req, serverShim);
      if (!resp) {
        nodeRes.statusCode = 404;
        nodeRes.end("Not found");
        return;
      }
      nodeRes.statusCode = resp.status;
      resp.headers.forEach((value, key) => {
        nodeRes.setHeader(key, value);
      });

      if (resp.body) {
        const reader = resp.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { nodeRes.end(); break; }
            nodeRes.write(value);
          }
        };
        pump().catch(() => { try { nodeRes.end(); } catch {} });
      } else {
        nodeRes.end();
      }
    } catch {
      if (!nodeRes.headersSent) {
        nodeRes.statusCode = 500;
        nodeRes.end("Internal Server Error");
      }
    }
  });

  if (opts.websocket) {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    });

    wss.on("connection", (ws) => {
      opts.websocket!.open(ws);
      ws.on("message", (data) => opts.websocket!.message(ws, data));
      ws.on("close", () => opts.websocket!.close(ws));
    });
  }

  httpServer.listen(opts.port);
  return httpServer;
}
