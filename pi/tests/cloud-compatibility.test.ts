import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import celestoPiExtension from "../src/index.js";

const execute = promisify(execFile);

test("Pi creates a computer, runs bash, and pushes files through the current Cloud HTTP contract", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "celesto-cloud-http-"));
  const localRoot = path.join(root, "project");
  const remoteRoot = path.join(root, "remote", "workspace");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(localRoot), mkdir(remoteRoot, { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(localRoot, "hello.txt"), "hello from Pi\n");
  // macOS lacks setsid; this scenario only exercises completed commands.
  if (process.platform === "darwin") {
    await writeFile(path.join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    // The guest uses GNU base64's positional input file; BSD requires -i.
    await writeFile(path.join(bin, "base64"),
      '#!/bin/sh\nif [ "$1" = -d ] && [ "$#" = 2 ]; then exec /usr/bin/base64 -d -i "$2"; fi\nexec /usr/bin/base64 "$@"\n',
      { mode: 0o755 });
  }
  const calls: Array<{ method?: string; url?: string }> = [];
  const keys: string[] = [];
  const server = createServer(async (request, response) => {
    calls.push({ method: request.method, url: request.url });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, "Bearer contract-test-key");
    if (request.method === "POST" && request.url === "/v1/computers") {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key) {
        response.writeHead(400).end(JSON.stringify({ detail: "Idempotency-Key is required for computer creation" }));
        return;
      }
      keys.push(key);
      response.writeHead(201).end(JSON.stringify({
        id: "cmp_contract", name: "contract", status: "running", vcpus: 1,
        ram_mb: 1024, disk_size_mb: 1024, template_id: "scratch", image: "ubuntu",
        external_volume_enabled: body.external_volume_enabled,
        created_at: "2026-11-13T00:00:00Z",
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/computers/cmp_contract/exec") {
      response.writeHead(404).end(JSON.stringify({ detail: "Not Found" }));
      return;
    }
    let result = { exit_code: 0, stdout: `${remoteRoot}\n`, stderr: "" };
    if (!body.command.includes('home=$(cd "${HOME:?HOME is not set}"')) {
      try {
        const output = await execute("/bin/bash", ["-c", body.command], {
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
          timeout: 10_000,
        });
        result = { exit_code: 0, ...output };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        result = { exit_code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
      }
    }
    response.end(JSON.stringify({ ...result, command_id: `cmd_${calls.length}`, timed_out: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CELESTO_API_KEY;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.celesto.ai");
    return originalFetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  };
  process.env.CELESTO_API_KEY = "contract-test-key";
  try {
    const flags = new Map<string, unknown>();
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const errors: string[] = [];
    if (process.env.PI_TEST_EXTENSION_PATH) {
      const loaded = await discoverAndLoadExtensions(
        [process.env.PI_TEST_EXTENSION_PATH], localRoot, path.join(root, "agent"),
      );
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      const extension = loaded.extensions[0]!;
      loaded.runtime.appendEntry = () => {};
      loaded.runtime.flagValues.set("celesto", true);
      for (const [name, tool] of extension.tools) tools.set(name, tool.definition);
      for (const [name, callbacks] of extension.handlers) handlers.set(name, callbacks[0]!);
      for (const [name, command] of extension.commands) {
        commands.set(name, async (args, ctx) => { await command.handler(args, ctx as ExtensionCommandContext); });
      }
    } else celestoPiExtension({
      registerFlag(name: string, options: { default?: unknown }) { flags.set(name, options.default); },
      getFlag(name: string) { return flags.get(name); },
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
        commands.set(name, options.handler);
      },
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
      appendEntry() {},
    } as unknown as ExtensionAPI);
    flags.set("celesto", true);
    const context = {
      cwd: localRoot,
      sessionManager: { getBranch: () => [] },
      ui: {
        theme: { fg: (_color: string, value: string) => value }, setStatus() {},
        notify(message: string, level: string) { if (level === "error") errors.push(message); },
      },
    } as unknown as ExtensionToolContext;
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
    assert.deepEqual(errors, []);
    assert.equal(keys.length, 1);
    const bash = tools.get("bash")!;
    const pwd = await bash.execute("pwd", { command: "pwd" }, undefined, undefined, context);
    assert(pwd.content.some((item) => item.type === "text" && item.text.trim() === remoteRoot));
    const silent = await bash.execute("true", { command: "true" }, undefined, undefined, context);
    assert(!silent.isError);
    const failed = await bash.execute("failure", { command: "printf problem >&2; exit 7" }, undefined, undefined, context);
    assert(failed.content.some((item) => item.type === "text" && item.text.includes("problem") && item.text.includes("7")));
    await commands.get("celesto")!("push", context);
    assert.deepEqual(errors, []);
    assert.equal(await readFile(path.join(remoteRoot, "hello.txt"), "utf8"), "hello from Pi\n");
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: `<cwd>\n${localRoot}\n</cwd>` }, context) as { systemPrompt: string };
    assert.equal(prompt.systemPrompt, `<cwd>${remoteRoot}</cwd>`);
    assert(calls.filter((call) => call.url?.endsWith("/exec")).length > 3);
    assert(!calls.some((call) => call.url?.endsWith("/exec/stream")));
    if (process.env.PI_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.PI_TEST_ARTIFACT_DIR, { recursive: true });
      await writeFile(path.join(process.env.PI_TEST_ARTIFACT_DIR, "cloud-contract.json"),
        JSON.stringify({ requests: calls, prompt: prompt.systemPrompt, uploadedFile: await readFile(path.join(remoteRoot, "hello.txt"), "utf8"), errors }, null, 2));
    }

  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CELESTO_API_KEY;
    else process.env.CELESTO_API_KEY = originalKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
