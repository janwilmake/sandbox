import {
  getSandbox,
  proxyToSandbox,
  type Sandbox as SandboxDurableObject
} from "@cloudflare/sandbox";
import { createAnthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<SandboxDurableObject>;
  CREDS_BUCKET: R2Bucket;
}

const TERMINAL_SESSION_ID = "terminal";
const ASSISTANT_SESSION_ID = "assistant";
const ASSISTANT_CWD_FILE = "/tmp/assistant-cwd";
const DEFAULT_SANDBOX_ENV = { IS_SANDBOX: "1" } as const;
const CHAT_MODEL = "claude-sonnet-4-6";
const CHAT_SYSTEM_PROMPT = [
  "You are the CLI copilot for a Cloudflare sandbox.",
  "Answer concisely and accurately.",
  "The main CLIs available in this sandbox are git, gh, wrangler, stripe, and claude.",
  "When the user asks what CLI commands are available, how to use a specific command, or wants you to run a one-off Claude Code prompt, use the run_terminal_command tool to inspect the real sandbox state.",
  'If the user wants Claude Code to answer a one-off prompt, run it with the exact pattern claude --dangerously-skip-permissions -p "...".',
  "The tool is non-interactive only. Do not attempt login flows, browser auth, prompts, TTY UIs, or any command that waits for user interaction.",
  "If a task requires authentication or an interactive command, tell the user clearly that they need to log in themselves via the UI buttons or the terminal.",
  "Prefer read-only and informational commands unless the user explicitly asks to change something.",
  "When you use the tool, explain what you ran and summarize the result."
].join(" ");

// Credential directories to backup/restore
const CREDENTIAL_DIRS: Record<string, string> = {
  gh: "/root/.config/gh",
  stripe: "/root/.config/stripe",
  wrangler: "/root/.wrangler",
  gitconfig: "/root/.gitconfig.d",
  claude: "/root/.claude"
};

const CREDENTIAL_FILES: Record<string, string> = {
  ".gitconfig": "/root/.gitconfig"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Proxy preview URLs
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);

    // Login page (no sandbox ID yet)
    if (url.pathname === "/" && !url.searchParams.has("id")) {
      return new Response(loginHtml(), {
        headers: { "Content-Type": "text/html" }
      });
    }

    const sandboxId = url.searchParams.get("id");
    if (!sandboxId) {
      return new Response("Missing sandbox id", { status: 400 });
    }

    const sandbox = getSandbox(env.Sandbox, sandboxId, { normalizeId: true });

    // Terminal WebSocket
    if (
      url.pathname === "/ws/terminal" &&
      request.headers.get("Upgrade") === "websocket"
    ) {
      const terminalSession = await getTerminalSession(sandbox);
      return terminalSession.terminal(request, { cols: 220, rows: 50 });
    }

    // Favicon
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Terminal page (no sandbox interaction needed)
    if (url.pathname === "/terminal") {
      return new Response(terminalHtml(sandboxId, url.hostname), {
        headers: { "Content-Type": "text/html" }
      });
    }

    // API routes — wrapped in try/catch so errors return JSON, not HTML
    try {
      switch (url.pathname) {
        case "/api/boot": {
          if (request.method !== "POST") break;
          const report = await bootSandbox(sandbox, env, sandboxId);
          return Response.json(report);
        }

        case "/api/save": {
          if (request.method !== "POST") break;
          const body = (await request.json().catch(() => ({}))) as {
            destroy?: boolean;
          };
          const saved = await saveCredentials(sandbox, env, sandboxId);
          if (body.destroy) await sandbox.destroy();
          return Response.json({ saved, destroyed: body.destroy ?? false });
        }

        case "/api/gh-login": {
          if (request.method !== "POST") break;
          return ghLogin(sandbox);
        }

        case "/api/gh-status": {
          const r = await sandbox.exec("gh auth status 2>&1");
          return Response.json({ ok: r.success, output: r.stdout + r.stderr });
        }

        case "/api/wrangler-login": {
          if (request.method !== "POST") break;
          return wranglerLogin(sandbox);
        }

        case "/api/wrangler-callback": {
          if (request.method !== "POST") break;
          const { callbackUrl } = (await request.json()) as {
            callbackUrl: string;
          };
          if (!callbackUrl) {
            return Response.json({ error: "No callback URL" }, { status: 400 });
          }
          return wranglerCallback(sandbox, callbackUrl);
        }

        case "/api/stripe-login": {
          if (request.method !== "POST") break;
          return stripeLogin(sandbox);
        }

        case "/api/stripe-status": {
          const processId = url.searchParams.get("processId");
          if (!processId) {
            return Response.json({ error: "No processId" }, { status: 400 });
          }
          return stripeStatus(sandbox, processId);
        }

        case "/api/claude-login": {
          if (request.method !== "POST") break;
          const { apiKey } = (await request.json()) as { apiKey: string };
          if (!apiKey) {
            return Response.json({ error: "No API key" }, { status: 400 });
          }
          return claudeLogin(sandbox, env, sandboxId, apiKey);
        }

        case "/api/status": {
          return cliStatus(sandbox);
        }

        case "/api/chat": {
          if (request.method !== "POST") break;
          return chatWithSandboxAssistant(sandbox, request);
        }

        case "/api/exec": {
          if (request.method !== "POST") break;
          const { command } = (await request.json()) as { command: string };
          if (!command) {
            return Response.json({ error: "No command" }, { status: 400 });
          }
          const r = await sandbox.exec(command);
          return Response.json({
            success: r.success,
            stdout: r.stdout,
            stderr: r.stderr
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  }
};

// ── Boot: restore credentials from R2 ──────────────────────────────────────

async function bootSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sandboxId: string
): Promise<Record<string, string>> {
  const report: Record<string, string> = {};

  await syncEnvVars(sandbox, {});
  report["sandbox_env"] = "restored";

  for (const [name, containerPath] of Object.entries(CREDENTIAL_DIRS)) {
    const key = `${sandboxId}/creds/${name}.tar.gz`;
    const obj = await env.CREDS_BUCKET.get(key);
    if (!obj) {
      report[name] = "no saved credentials";
      continue;
    }

    const tarBytes = await obj.arrayBuffer();
    const b64 = bufferToBase64(tarBytes);
    await sandbox.writeFile("/tmp/creds.tar.gz", b64, { encoding: "base64" });
    await sandbox.mkdir(containerPath, { recursive: true });
    const result = await sandbox.exec(
      `tar -xzf /tmp/creds.tar.gz -C / 2>&1 && rm /tmp/creds.tar.gz`
    );
    report[name] = result.success ? "restored" : `error: ${result.stderr}`;
  }

  for (const [name, containerPath] of Object.entries(CREDENTIAL_FILES)) {
    const key = `${sandboxId}/creds/files/${name}`;
    const obj = await env.CREDS_BUCKET.get(key);
    if (!obj) {
      report[name] = "no saved file";
      continue;
    }

    const content = await obj.text();
    await sandbox.writeFile(containerPath, content);
    report[name] = "restored";
  }

  // Restore env vars (e.g. ANTHROPIC_API_KEY)
  const envObj = await env.CREDS_BUCKET.get(`${sandboxId}/creds/env.json`);
  if (envObj) {
    const envVars = await envObj.json<Record<string, string>>();
    await syncEnvVars(sandbox, envVars);
    report["env"] = "restored";
  }

  // Ensure container is started even if no credentials were restored
  await sandbox.exec("echo ready");

  return report;
}

// ── Save credentials to R2 ────────────────────────────────────────────────

async function saveCredentials(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sandboxId: string
): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};

  for (const [name, containerPath] of Object.entries(CREDENTIAL_DIRS)) {
    const key = `${sandboxId}/creds/${name}.tar.gz`;
    const hasContainerCreds = await pathHasContents(sandbox, containerPath);
    if (!hasContainerCreds) {
      const existingBackup = await env.CREDS_BUCKET.head(key);
      saved[name] = existingBackup
        ? "skipped (container empty, previous backup kept)"
        : "skipped (container empty, no backup yet)";
      continue;
    }

    await sandbox.exec(
      `tar -czf /tmp/creds_save.tar.gz -C / ${containerPath.slice(1)} 2>&1`
    );
    const tarFile = await sandbox.readFile("/tmp/creds_save.tar.gz");
    const tarBytes = base64ToBuffer(tarFile.content);
    await env.CREDS_BUCKET.put(key, tarBytes, {
      httpMetadata: { contentType: "application/gzip" }
    });
    saved[name] = `saved (${Math.round(tarBytes.byteLength / 1024)} KB)`;
  }

  for (const [name, containerPath] of Object.entries(CREDENTIAL_FILES)) {
    const key = `${sandboxId}/creds/files/${name}`;
    try {
      const f = await sandbox.readFile(containerPath);
      await env.CREDS_BUCKET.put(key, f.content);
      saved[name] = "saved";
    } catch {
      const existingBackup = await env.CREDS_BUCKET.head(key);
      saved[name] = existingBackup
        ? "skipped (not found in container, previous backup kept)"
        : "skipped (not found in container, no backup yet)";
    }
  }

  // Persist env vars (e.g. ANTHROPIC_API_KEY) by reading them from the container
  const apiKey = await readAnthropicApiKey(sandbox);
  if (apiKey) {
    const envVars: Record<string, string> = {
      ...DEFAULT_SANDBOX_ENV,
      ANTHROPIC_API_KEY: apiKey
    };
    await env.CREDS_BUCKET.put(
      `${sandboxId}/creds/env.json`,
      JSON.stringify(envVars)
    );
    saved["env"] = "saved";
  } else {
    const existingBackup = await env.CREDS_BUCKET.head(
      `${sandboxId}/creds/env.json`
    );
    saved["env"] = existingBackup
      ? "skipped (not set in container, previous backup kept)"
      : "skipped (not set in container, no backup yet)";
  }

  return saved;
}

// ── gh device-flow login ───────────────────────────────────────────────────

async function ghLogin(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  const proc = await sandbox.startProcess(
    "gh auth login --hostname github.com --git-protocol https --web --insecure-storage",
    { env: { GH_NO_UPDATE_NOTIFIER: "1" } }
  );

  let code: string | null = null;
  let authUrl: string | null = null;

  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const logs = await sandbox.getProcessLogs(proc.id);
    const output = (logs.stdout || "") + (logs.stderr || "");
    const codeMatch = output.match(
      /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i
    );
    const urlMatch = output.match(
      /(https:\/\/github\.com\/login\/device[^\s]*)/
    );
    if (codeMatch) code = codeMatch[1];
    if (urlMatch) authUrl = urlMatch[1];
    if (code && authUrl) break;
  }

  if (!code || !authUrl) {
    return Response.json(
      { error: "Could not capture gh device code - try terminal" },
      { status: 500 }
    );
  }
  return Response.json({ code, authUrl, processId: proc.id });
}

// ── Wrangler login ─────────────────────────────────────────────────────────

async function wranglerLogin(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  const proc = await sandbox.startProcess("wrangler login 2>&1");

  let authUrl: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const logs = await sandbox.getProcessLogs(proc.id);
    const output = (logs.stdout || "") + (logs.stderr || "");
    const match = output.match(/(https:\/\/dash\.cloudflare\.com\/[^\s]+)/);
    if (match) {
      authUrl = match[1];
      break;
    }
  }

  if (!authUrl) {
    return Response.json(
      { error: "Could not capture Wrangler auth URL - try terminal" },
      { status: 500 }
    );
  }
  return Response.json({ authUrl, processId: proc.id });
}

// ── Wrangler OAuth callback relay ────────────────────────────────────────────

async function wranglerCallback(
  sandbox: ReturnType<typeof getSandbox>,
  callbackUrl: string
): Promise<Response> {
  const parsed = new URL(callbackUrl);
  const localUrl = `http://localhost:8976${parsed.pathname}${parsed.search}`;
  const result = await sandbox.exec(
    `curl -s -L -o /dev/null -w '%{http_code}' '${localUrl}'`
  );
  const status = result.stdout.trim();
  const ok =
    result.success && (status.startsWith("2") || status.startsWith("3"));
  return Response.json({ ok, output: result.stdout + result.stderr });
}

// ── Stripe login ───────────────────────────────────────────────────────────

async function stripeLogin(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  const proc = await sandbox.startProcess("stripe login 2>&1", {
    env: { NO_COLOR: "1" }
  });

  let authUrl: string | null = null;
  let pairingCode: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const logs = await sandbox.getProcessLogs(proc.id);
    const output = (logs.stdout || "") + (logs.stderr || "");
    const urlMatch = output.match(
      /(https:\/\/dashboard\.stripe\.com\/stripecli\/[^\s]+)/
    );
    const codeMatch = output.match(
      /pairing code[:\s]+([a-z]+-[a-z]+-[a-z]+-[a-z]+)/i
    );
    if (urlMatch) authUrl = urlMatch[1];
    if (codeMatch) pairingCode = codeMatch[1];
    if (authUrl) break;
  }

  if (!authUrl) {
    return Response.json(
      { error: "Could not capture Stripe auth URL - try terminal" },
      { status: 500 }
    );
  }
  return Response.json({ authUrl, pairingCode, processId: proc.id });
}

// ── Stripe status (poll process logs) ────────────────────────────────────────

async function stripeStatus(
  sandbox: ReturnType<typeof getSandbox>,
  processId: string
): Promise<Response> {
  const logs = await sandbox.getProcessLogs(processId);
  const output = (logs.stdout || "") + (logs.stderr || "");
  const done = /done|configured|success/i.test(output);
  return Response.json({ done, output });
}

// ── Claude Code login ────────────────────────────────────────────────────────

async function claudeLogin(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sandboxId: string,
  apiKey: string
): Promise<Response> {
  const envVars = {
    ...DEFAULT_SANDBOX_ENV,
    ANTHROPIC_API_KEY: apiKey
  };
  await syncEnvVars(sandbox, envVars);
  await env.CREDS_BUCKET.put(
    `${sandboxId}/creds/env.json`,
    JSON.stringify(envVars)
  );
  const check = await sandbox.exec("claude --version 2>&1");
  return Response.json({
    ok: check.success,
    output: check.stdout.trim() || check.stderr.trim()
  });
}

// ── CLI status ─────────────────────────────────────────────────────────────

async function cliStatus(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  const claudeStatus = await getTerminalSession(sandbox)
    .then((session) =>
      session.exec(
        'test -n "$ANTHROPIC_API_KEY" && echo configured || echo not configured'
      )
    )
    .then((r) => r.stdout.trim() || "not configured")
    .catch(() => "not configured");

  const [gh, wrangler, stripe] = await Promise.all([
    sandbox
      .exec("gh auth status 2>&1")
      .then((r) => (r.success ? "authenticated" : "not logged in")),
    sandbox
      .exec("wrangler whoami 2>&1")
      .then((r) =>
        r.success ? r.stdout.trim().split("\n")[0] : "not logged in"
      ),
    sandbox
      .exec("test -s /root/.config/stripe/config.toml && echo ok || echo no")
      .then((r) =>
        r.stdout.trim() === "ok" ? "authenticated" : "not logged in"
      )
  ]);
  return Response.json({ gh, wrangler, stripe, claude: claudeStatus });
}

async function chatWithSandboxAssistant(
  sandbox: ReturnType<typeof getSandbox>,
  request: Request
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
  } | null;

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json(
      { error: "No chat messages provided." },
      { status: 400 }
    );
  }

  const messages = body.messages
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } =>
        Boolean(
          message &&
          (message.role === "user" || message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim()
        )
    )
    .map(
      (message) =>
        ({
          role: message.role,
          content: message.content
        }) satisfies ModelMessage
    );

  if (messages.length === 0) {
    return Response.json(
      { error: "No valid chat messages provided." },
      { status: 400 }
    );
  }

  const apiKey = await readAnthropicApiKey(sandbox);
  if (!apiKey) {
    return Response.json(
      {
        error:
          "ANTHROPIC_API_KEY is not configured in this sandbox. Use 'claude login' first."
      },
      { status: 400 }
    );
  }

  const anthropic = createAnthropic({ apiKey });
  const assistantSession = await getAssistantSession(sandbox);

  const result = streamText({
    model: anthropic(CHAT_MODEL),
    system: CHAT_SYSTEM_PROMPT,
    messages,
    temperature: 0.2,
    stopWhen: stepCountIs(30),
    tools: {
      run_terminal_command: tool({
        description:
          'Run a non-interactive shell command inside the sandbox assistant session and return stdout/stderr. The main CLIs available here are git, gh, wrangler, stripe, and claude. Do not use this for login flows, browser auth, prompts, or other interactive commands. If authentication is required, tell the user to log in via the UI buttons or the terminal. Use this to inspect those CLIs and to run one-off Claude Code prompts with the exact pattern claude --dangerously-skip-permissions -p "...".',
        inputSchema: z.object({
          command: z.string().min(1).max(10000)
        }),
        execute: async ({ command }) => {
          const output = await runAssistantCommand(assistantSession, command);

          return {
            command,
            success: output.success,
            stdout: truncateForModel(output.stdout),
            stderr: truncateForModel(output.stderr)
          };
        }
      })
    },
    abortSignal: request.signal
  });

  return result.toUIMessageStreamResponse();
}

// ── Utilities ──────────────────────────────────────────────────────────────

async function getTerminalSession(sandbox: ReturnType<typeof getSandbox>) {
  return sandbox.getSession(TERMINAL_SESSION_ID);
}

async function getAssistantSession(sandbox: ReturnType<typeof getSandbox>) {
  return sandbox.getSession(ASSISTANT_SESSION_ID);
}

async function runAssistantCommand(
  assistantSession: Awaited<ReturnType<typeof getAssistantSession>>,
  command: string
) {
  const wrappedCommand = [
    `STATE_FILE=${shellQuote(ASSISTANT_CWD_FILE)}`,
    `DEFAULT_DIR='/root'`,
    `CURRENT_DIR="$DEFAULT_DIR"`,
    `if [ -f "$STATE_FILE" ]; then CURRENT_DIR=$(cat "$STATE_FILE"); fi`,
    `if ! cd "$CURRENT_DIR" 2>/dev/null; then cd "$DEFAULT_DIR"; fi`,
    command,
    `STATUS=$?`,
    `pwd > "$STATE_FILE"`,
    `exit "$STATUS"`
  ].join("\n");

  return assistantSession.exec(`bash -lc ${shellQuote(wrappedCommand)}`);
}

async function syncEnvVars(
  sandbox: ReturnType<typeof getSandbox>,
  envVars: Record<string, string>
): Promise<void> {
  const fullEnvVars = {
    ...DEFAULT_SANDBOX_ENV,
    ...envVars
  };
  const exportCommand = buildExportCommand(fullEnvVars);
  const terminalSession = await getTerminalSession(sandbox);
  const assistantSession = await getAssistantSession(sandbox);

  await Promise.all([
    sandbox.setEnvVars(fullEnvVars),
    terminalSession.setEnvVars(fullEnvVars),
    assistantSession.setEnvVars(fullEnvVars)
  ]);

  if (!exportCommand) return;

  await Promise.all([
    sandbox.exec(exportCommand),
    terminalSession.exec(exportCommand),
    assistantSession.exec(exportCommand)
  ]);
}

async function readAnthropicApiKey(
  sandbox: ReturnType<typeof getSandbox>
): Promise<string> {
  const terminalSession = await getTerminalSession(sandbox);
  const assistantSession = await getAssistantSession(sandbox);
  const [terminalEnv, assistantEnv, defaultEnv] = await Promise.all([
    terminalSession
      .exec(`echo -n "$ANTHROPIC_API_KEY"`)
      .then((r) => r.stdout.trim())
      .catch(() => ""),
    assistantSession
      .exec(`echo -n "$ANTHROPIC_API_KEY"`)
      .then((r) => r.stdout.trim())
      .catch(() => ""),
    sandbox.exec(`echo -n "$ANTHROPIC_API_KEY"`).then((r) => r.stdout.trim())
  ]);

  return terminalEnv || assistantEnv || defaultEnv;
}

async function pathHasContents(
  sandbox: ReturnType<typeof getSandbox>,
  path: string
): Promise<boolean> {
  const check = await sandbox.exec(
    `test -d ${shellQuote(path)} && find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -print -quit`
  );

  return check.success && Boolean(check.stdout.trim());
}

function buildExportCommand(envVars: Record<string, string>): string {
  const assignments = Object.entries(envVars)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);

  return assignments.join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function truncateForModel(text: string, maxChars = 12000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// ── Login page HTML ────────────────────────────────────────────────────────

function loginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox - Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
  }
  .card {
    background: #141414; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 48px; max-width: 420px; width: 100%;
  }
  h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
  p { font-size: 14px; color: #888; margin-bottom: 32px; line-height: 1.5; }
  label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 14px; border-radius: 8px;
    border: 1px solid #333; background: #1a1a1a; color: #fff;
    font-size: 15px; outline: none; margin-bottom: 24px;
  }
  input:focus { border-color: #4a9eff; }
  button {
    width: 100%; padding: 12px; border-radius: 8px; border: none;
    background: #4a9eff; color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: background 0.2s;
  }
  button:hover { background: #3a8eef; }
  .or { text-align: center; color: #555; font-size: 13px; margin-bottom: 16px; }
  .generate {
    background: transparent; border: 1px solid #333; color: #aaa;
    margin-bottom: 16px;
  }
  .generate:hover { border-color: #4a9eff; color: #fff; }
</style>
</head>
<body>
<div class="card">
  <h1>Sandbox</h1>
  <p>Enter your sandbox ID to connect, or generate a new one. Each ID gets its own isolated container with persistent CLI credentials.</p>
  <label for="sid">Sandbox ID</label>
  <input type="text" id="sid" placeholder="e.g. my-workspace" autofocus>
  <button class="generate" onclick="generate()">Generate random ID</button>
  <div class="or">or enter your own above</div>
  <button onclick="go()">Launch Sandbox</button>
</div>
<script>
function generate() {
  const id = 'sb-' + crypto.randomUUID().slice(0, 8);
  document.getElementById('sid').value = id;
}
function go() {
  const id = document.getElementById('sid').value.trim();
  if (!id) { document.getElementById('sid').focus(); return; }
  window.location.href = '/terminal?id=' + encodeURIComponent(id);
}
document.getElementById('sid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go();
});
</script>
</body>
</html>`;
}

// ── Terminal page HTML ─────────────────────────────────────────────────────

function terminalHtml(sandboxId: string, _hostname: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox: ${sandboxId}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0a;
    --panel: #141414;
    --panel-2: #111111;
    --panel-3: #1a1a1a;
    --border: #2a2a2a;
    --border-soft: #222222;
    --text: #e0e0e0;
    --muted: #8a8a8a;
    --accent: #4a9eff;
    --accent-2: #7dd3fc;
    --ok: #4ade80;
    --bad: #f87171;
  }
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    background:
      radial-gradient(circle at top right, rgba(74,158,255,0.16), transparent 26%),
      radial-gradient(circle at bottom left, rgba(125,211,252,0.08), transparent 28%),
      var(--bg);
    color: var(--text);
    display: flex; flex-direction: column; height: 100vh;
  }
  #toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: rgba(20,20,20,0.92);
    border-bottom: 1px solid var(--border); flex-wrap: wrap;
    backdrop-filter: blur(12px);
  }
  #toolbar .id-label {
    font-size: 13px; color: var(--accent); font-weight: 600;
    margin-right: auto;
  }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #333;
    background: var(--panel-3); color: #ccc; font-size: 12px; cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { border-color: var(--accent); color: #fff; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: #3a8eef; }
  .btn.danger { border-color: #ff4a4a; color: #ff4a4a; }
  .btn.danger:hover { background: #ff4a4a; color: #fff; }

  #status-bar {
    display: flex; gap: 8px; padding: 6px 12px;
    background: rgba(17,17,17,0.92); border-bottom: 1px solid var(--border-soft);
    flex-wrap: wrap; align-items: center;
    backdrop-filter: blur(12px);
  }
  .cli-chip {
    font-size: 11px; padding: 3px 10px; border-radius: 12px;
    font-weight: 500;
  }
  .cli-chip.ok { background: #0a2e1a; color: var(--ok); }
  .cli-chip.bad { background: #2e0a0a; color: var(--bad); }
  .cli-chip.unknown { background: var(--panel-3); color: #888; }
  #status-msg {
    margin-left: auto; font-size: 11px; color: #666;
  }

  #workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.7fr) minmax(340px, 0.95fr);
  }
  #terminal-pane {
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border-soft);
    padding: 4px;
  }
  #term-wrap {
    height: 100%;
    overflow: hidden;
    border: 1px solid #171717;
    border-radius: 14px;
    background: rgba(5,5,5,0.78);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
  }
  #terminal { height: 100%; }

  #chat-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background:
      linear-gradient(180deg, rgba(20,20,20,0.98), rgba(13,13,13,0.98));
  }
  #chat-header {
    padding: 18px 18px 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  #chat-header h2 {
    font-size: 16px;
    color: #fff;
    margin-bottom: 4px;
  }
  #chat-header p {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
  #chat-header code {
    font-family: 'JetBrains Mono','Fira Code',monospace;
    color: var(--accent-2);
  }
  #chat-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 14px 18px 0;
  }
  .chat-chip {
    border: 1px solid #2f3740;
    background: rgba(27,31,36,0.9);
    color: #b5c4d6;
    padding: 8px 10px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
  }
  .chat-chip:hover {
    border-color: var(--accent);
    color: #fff;
  }
  #chat-messages {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .chat-bubble {
    max-width: 92%;
    border-radius: 16px;
    padding: 12px 14px;
    white-space: pre-wrap;
    line-height: 1.55;
    font-size: 13px;
  }
  .chat-bubble.user {
    align-self: flex-end;
    background: linear-gradient(135deg, rgba(74,158,255,0.95), rgba(43,104,194,0.95));
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .chat-bubble.assistant {
    align-self: flex-start;
    background: #171717;
    border: 1px solid #272727;
    color: #e7e7e7;
    border-bottom-left-radius: 4px;
  }
  .chat-assistant-content {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .chat-text-block {
    white-space: pre-wrap;
  }
  .chat-tool {
    border: 1px solid #2a3340;
    background: rgba(15, 24, 33, 0.78);
    border-radius: 12px;
    padding: 10px 12px;
  }
  .chat-tool.running {
    border-color: #35506d;
  }
  .chat-tool.done {
    border-color: #1f4d35;
  }
  .chat-tool.error {
    border-color: #5b2626;
    background: rgba(39, 16, 16, 0.82);
  }
  .chat-tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9fb8d1;
  }
  .chat-tool-state {
    margin-left: auto;
    color: #7f95aa;
  }
  .chat-tool-name {
    color: #d8ecff;
    font-weight: 600;
  }
  .chat-tool pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font: 12px/1.5 'JetBrains Mono','Fira Code',monospace;
    color: #d7e4f1;
  }
  .chat-bubble.error {
    border-color: #4c1d1d;
    color: #fecaca;
    background: #1f1010;
  }
  .chat-bubble.hint {
    align-self: stretch;
    max-width: 100%;
    background: rgba(17,25,36,0.76);
    border: 1px solid #243342;
    color: #b7c9dc;
  }
  #chat-form {
    border-top: 1px solid var(--border-soft);
    padding: 14px 18px 18px;
    background: rgba(16,16,16,0.96);
  }
  #chat-input {
    width: 100%;
    min-height: 108px;
    resize: vertical;
    border-radius: 14px;
    border: 1px solid #2d2d2d;
    background: #0f0f0f;
    color: #fff;
    padding: 14px;
    font: inherit;
    outline: none;
  }
  #chat-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px rgba(74,158,255,0.35);
  }
  #chat-actions {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  #chat-status {
    font-size: 12px;
    color: var(--muted);
    margin-right: auto;
  }
  #chat-send {
    min-width: 104px;
  }

  /* Modal */
  #modal {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.7); z-index: 100;
    align-items: center; justify-content: center;
  }
  #modal.open { display: flex; }
  .mbox {
    background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
    padding: 32px; max-width: 480px; width: 90%; text-align: center;
  }
  .mbox h2 { margin-bottom: 12px; color: #fff; font-size: 18px; }
  .mbox p { color: #aaa; font-size: 14px; margin-bottom: 8px; line-height: 1.5; }
  .mbox .code {
    font-family: monospace; font-size: 28px; letter-spacing: 4px;
    color: #4a9eff; margin: 16px 0; font-weight: 700;
  }
  .mbox a {
    color: #4a9eff; text-decoration: none; font-size: 14px;
  }
  .mbox a:hover { text-decoration: underline; }
  .mbox .close-btn {
    margin-top: 20px; padding: 8px 20px; border-radius: 6px;
    border: 1px solid #333; background: transparent; color: #aaa;
    cursor: pointer; font-size: 13px;
  }
  .mbox .close-btn:hover { color: #fff; border-color: var(--accent); }

  @media (max-width: 1100px) {
    #workspace {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(360px, 1fr) minmax(320px, 42vh);
    }
    #terminal-pane {
      border-right: none;
      border-bottom: 1px solid var(--border-soft);
    }
    #chat-pane {
      min-height: 320px;
    }
  }
</style>
</head>
<body>

<div id="toolbar">
  <span class="id-label">${sandboxId}</span>
  <button class="btn primary" id="btn-boot">Boot</button>
  <button class="btn" id="btn-gh">gh login</button>
  <button class="btn" id="btn-wrangler">wrangler login</button>
  <button class="btn" id="btn-stripe">stripe login</button>
  <button class="btn" id="btn-claude">claude login</button>
  <button class="btn" id="btn-status">Refresh Status</button>
  <button class="btn" id="btn-save">Save Creds</button>
  <button class="btn danger" id="btn-destroy">Save & Destroy</button>
</div>

<div id="status-bar">
  <span class="cli-chip unknown" id="chip-gh">gh: ?</span>
  <span class="cli-chip unknown" id="chip-wrangler">wrangler: ?</span>
  <span class="cli-chip unknown" id="chip-stripe">stripe: ?</span>
  <span class="cli-chip unknown" id="chip-claude">claude: ?</span>
  <span id="status-msg"></span>
</div>

<div id="workspace">
  <section id="terminal-pane">
    <div id="term-wrap"><div id="terminal"></div></div>
  </section>

  <aside id="chat-pane">
    <div id="chat-header">
      <h2>CLI Copilot</h2>
      <p>Uses the sandbox's <code>ANTHROPIC_API_KEY</code>. Ask what commands exist here, how to run a CLI, or have it execute a one-off <code>claude --dangerously-skip-permissions -p "..."</code> prompt.</p>
    </div>
    <div id="chat-suggestions">
      <button class="chat-chip" data-prompt="What CLI commands are available in this sandbox?">Available commands</button>
      <button class="chat-chip" data-prompt="How do I run Claude Code in one-shot mode with claude --dangerously-skip-permissions -p? Show me the exact syntax.">How to use claude -p</button>
      <button class="chat-chip" data-prompt="Run claude --dangerously-skip-permissions -p &quot;Summarize what tools are installed in this sandbox.&quot;">Run a claude -p example</button>
    </div>
    <div id="chat-messages"></div>
    <form id="chat-form">
      <textarea id="chat-input" placeholder="Ask about the sandbox CLI or request a one-off claude --dangerously-skip-permissions -p command..."></textarea>
      <div id="chat-actions">
        <span id="chat-status">Ready.</span>
        <button class="btn primary" id="chat-send" type="submit">Send</button>
      </div>
    </form>
  </aside>
</div>

<div id="modal"><div class="mbox" id="mbox-inner"></div></div>

<script type="module">
import { Terminal }      from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm';
import { FitAddon }      from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10/+esm';
import { WebLinksAddon } from 'https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11/+esm';

const ID  = ${JSON.stringify(sandboxId)};
const qs  = () => '?id=' + encodeURIComponent(ID);
const msg = (t) => { document.getElementById('status-msg').textContent = t; };
const modal = document.getElementById('modal');
const mbox  = document.getElementById('mbox-inner');
const chatMessagesEl = document.getElementById('chat-messages');
const chatStatusEl = document.getElementById('chat-status');
const chatInputEl = document.getElementById('chat-input');
const chatFormEl = document.getElementById('chat-form');
const chatHistory = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let termSocket = null;
let chatPending = false;

// ── Terminal ───────────────────────────────────────────────────────────────
const term = new Terminal({
  cursorBlink: true, fontSize: 14,
  fontFamily: "'JetBrains Mono','Fira Code',monospace",
  theme: { background: '#0a0a0a', foreground: '#e0e0e0', cursor: '#4a9eff' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(document.getElementById('terminal'));
fit.fit();
window.addEventListener('resize', () => fit.fit());
term.onData((data) => {
  if (termSocket && termSocket.readyState === 1) {
    termSocket.send(encoder.encode(data));
  }
});

function connectTerm() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws/terminal' + qs());
  ws.binaryType = 'arraybuffer';
  termSocket = ws;

  ws.onopen = () => {
    term.writeln('\\r\\n\\x1b[32mConnected to sandbox: ' + ID + '\\x1b[0m\\r\\n');
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      // Control/status messages are JSON text frames
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'error') {
          term.writeln('\\r\\n\\x1b[31mError: ' + msg.message + '\\x1b[0m');
        }
        // Ignore 'ready', 'exit', etc. silently
      } catch {
        term.write(e.data);
      }
    } else {
      term.write(new Uint8Array(e.data));
    }
  };
  ws.onclose = () => {
    term.writeln('\\r\\n\\x1b[31mDisconnected.\\x1b[0m');
    if (termSocket === ws) termSocket = null;
    setTimeout(connectTerm, 2000);
  };
}
// Auto-boot on page load, then connect terminal
(async () => {
  term.writeln('\\x1b[36mBooting sandbox...\\x1b[0m\\r\\n');
  try {
    const r = await fetch('/api/boot' + qs(), { method: 'POST' });
    const d = await r.json();
    term.writeln('\\x1b[36m=== Boot report ===\\x1b[0m');
    for (const [k, v] of Object.entries(d))
      term.writeln('  ' + k + ': ' + v);
    term.writeln('');
  } catch (e) {
    term.writeln('\\x1b[31mBoot failed: ' + e + '\\x1b[0m\\r\\n');
  }
  connectTerm();
  refreshStatus();
})();

// ── Chat ───────────────────────────────────────────────────────────────────
function setChatStatus(text) {
  chatStatusEl.textContent = text;
}

function scrollChat() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function renderChatBubble(role, content, extraClass = '') {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + role + (extraClass ? ' ' + extraClass : '');
  if (role === 'assistant' && !extraClass) {
    const contentEl = document.createElement('div');
    contentEl.className = 'chat-assistant-content';
    bubble.append(contentEl);
  } else {
    bubble.textContent = content;
  }
  chatMessagesEl.appendChild(bubble);
  scrollChat();
  return bubble;
}

function addChatMessage(role, content) {
  chatHistory.push({ role, content });
  return renderChatBubble(role, content);
}

async function readError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return data.error || text || ('Request failed with ' + response.status);
  } catch {
    return text || ('Request failed with ' + response.status);
  }
}

function createAssistantMessageUI() {
  const bubble = renderChatBubble('assistant', '');
  return {
    bubble,
    contentEl: bubble.querySelector('.chat-assistant-content'),
    toolNodes: new Map(),
    activeTextNode: null
  };
}

function upsertToolNode(ui, toolCallId, toolName) {
  let node = ui.toolNodes.get(toolCallId);
  if (node) return node;

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-tool running';
  wrapper.dataset.toolCallId = toolCallId;

  const head = document.createElement('div');
  head.className = 'chat-tool-head';

  const label = document.createElement('span');
  label.textContent = 'Tool';

  const name = document.createElement('span');
  name.className = 'chat-tool-name';
  name.textContent = toolName || 'command';

  const state = document.createElement('span');
  state.className = 'chat-tool-state';
  state.textContent = 'running';

  head.append(label, name, state);

  const body = document.createElement('pre');
  body.textContent = '';

  wrapper.append(head, body);
  ui.contentEl.appendChild(wrapper);
  ui.toolNodes.set(toolCallId, { wrapper, name, state, body, inputText: '' });
  scrollChat();
  return ui.toolNodes.get(toolCallId);
}

function formatToolPayload(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appendAssistantText(ui, delta) {
  if (!ui.activeTextNode) {
    const textNode = document.createElement('div');
    textNode.className = 'chat-text-block';
    textNode.textContent = '';
    ui.contentEl.appendChild(textNode);
    ui.activeTextNode = textNode;
  }

  ui.activeTextNode.textContent += delta;
  scrollChat();
}

function applyUiMessageChunk(ui, chunk, assistantState) {
  switch (chunk.type) {
    case 'text-delta':
      assistantState.text += chunk.delta || '';
      appendAssistantText(ui, chunk.delta || '');
      break;
    case 'tool-input-start': {
      ui.activeTextNode = null;
      const tool = upsertToolNode(ui, chunk.toolCallId, chunk.toolName);
      tool.state.textContent = 'preparing';
      break;
    }
    case 'tool-input-delta': {
      ui.activeTextNode = null;
      const tool = upsertToolNode(ui, chunk.toolCallId, 'command');
      tool.inputText += chunk.inputTextDelta || '';
      tool.body.textContent = tool.inputText;
      tool.state.textContent = 'building';
      scrollChat();
      break;
    }
    case 'tool-input-available': {
      ui.activeTextNode = null;
      const tool = upsertToolNode(ui, chunk.toolCallId, chunk.toolName);
      tool.name.textContent = chunk.toolName || tool.name.textContent;
      tool.body.textContent = formatToolPayload(chunk.input);
      tool.state.textContent = 'running';
      scrollChat();
      break;
    }
    case 'tool-output-available': {
      ui.activeTextNode = null;
      const tool = upsertToolNode(ui, chunk.toolCallId, 'command');
      tool.wrapper.classList.remove('running');
      tool.wrapper.classList.add('done');
      tool.state.textContent = 'done';
      tool.body.textContent = formatToolPayload(chunk.output);
      scrollChat();
      break;
    }
    case 'tool-output-error': {
      ui.activeTextNode = null;
      const tool = upsertToolNode(ui, chunk.toolCallId, 'command');
      tool.wrapper.classList.remove('running');
      tool.wrapper.classList.add('error');
      tool.state.textContent = 'error';
      tool.body.textContent = chunk.errorText || 'Tool execution failed.';
      scrollChat();
      break;
    }
    case 'error':
      ui.activeTextNode = null;
      assistantState.errorText = chunk.errorText || 'Streaming error.';
      break;
    default:
      break;
  }
}

function parseUiMessageChunks(buffer) {
  const chunks = [];
  let cursor = 0;

  while (true) {
    const delimiter = buffer.indexOf('\\n\\n', cursor);
    if (delimiter === -1) break;

    const rawEvent = buffer.slice(cursor, delimiter);
    cursor = delimiter + 2;

    const dataLines = rawEvent
      .split('\\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) continue;

    const data = dataLines.join('\\n');
    if (!data || data === '[DONE]') continue;

    try {
      chunks.push(JSON.parse(data));
    } catch {
      // Ignore malformed partial events and continue.
    }
  }

  return {
    chunks,
    rest: buffer.slice(cursor),
  };
}

async function sendChatMessage(text) {
  const message = text.trim();
  if (!message || chatPending) return;

  addChatMessage('user', message);
  chatInputEl.value = '';
  chatPending = true;
  chatInputEl.disabled = true;
  document.getElementById('chat-send').disabled = true;
  setChatStatus('Thinking...');

  const assistantUI = createAssistantMessageUI();
  const assistantState = { text: '', errorText: '' };

  try {
    const response = await fetch('/api/chat' + qs(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await readError(response));
    }

    const reader = response.body.getReader();
    let sseBuffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const parsed = parseUiMessageChunks(sseBuffer);
      sseBuffer = parsed.rest;
      for (const chunk of parsed.chunks) {
        applyUiMessageChunk(assistantUI, chunk, assistantState);
      }
    }
    sseBuffer += decoder.decode();
    const parsed = parseUiMessageChunks(sseBuffer + '\\n\\n');
    for (const chunk of parsed.chunks) {
      applyUiMessageChunk(assistantUI, chunk, assistantState);
    }

    let assistantText = assistantState.text.trim();
    if (!assistantText) {
      assistantText = assistantState.errorText || 'No response returned.';
      appendAssistantText(assistantUI, assistantText);
    }

    chatHistory.push({ role: 'assistant', content: assistantText });
    setChatStatus('Ready.');
  } catch (error) {
    assistantUI.bubble.classList.add('error');
    appendAssistantText(
      assistantUI,
      error instanceof Error ? error.message : String(error),
    );
    setChatStatus('Chat request failed.');
  } finally {
    chatPending = false;
    chatInputEl.disabled = false;
    document.getElementById('chat-send').disabled = false;
    chatInputEl.focus();
    scrollChat();
  }
}

chatFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendChatMessage(chatInputEl.value);
});

chatInputEl.addEventListener('keydown', async (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await sendChatMessage(chatInputEl.value);
  }
});

document.querySelectorAll('.chat-chip').forEach((button) => {
  button.addEventListener('click', async () => {
    const prompt = button.getAttribute('data-prompt') || '';
    chatInputEl.value = prompt;
    await sendChatMessage(prompt);
  });
});

renderChatBubble(
  'assistant',
  'Ask what CLI tools are available, request a command explanation, or ask me to run a one-off claude --dangerously-skip-permissions -p prompt for you.',
  'hint',
);

// ── Status ─────────────────────────────────────────────────────────────────
async function refreshStatus() {
  msg('Checking CLI status...');
  try {
    const r = await fetch('/api/status' + qs());
    const d = await r.json();
    for (const [key, val] of Object.entries(d)) {
      const chip = document.getElementById('chip-' + key);
      if (!chip) continue;
      const ok = val !== 'not logged in' && val !== 'not configured';
      chip.textContent = key + ': ' + (ok ? 'ok' : 'no');
      chip.className = 'cli-chip ' + (ok ? 'ok' : 'bad');
      chip.title = val;
    }
    msg('Status updated.');
  } catch (e) {
    msg('Error checking status.');
  }
}

// ── Device flow modal ──────────────────────────────────────────────────────
function showDeviceFlow({ code, authUrl, pollPath, pollCheck, onSuccess }) {
  mbox.innerHTML = '<h2>Authenticate</h2>'
    + (code
      ? '<p>Enter this code:</p><div class="code" style="cursor:pointer;user-select:all;" title="Click to copy">' + code + '</div>'
        + '<p id="copy-hint" style="color:#666;font-size:11px;margin-bottom:12px;">Click the code to copy</p>'
      : '')
    + '<p><a href="' + authUrl + '" target="_blank" rel="noopener">Open auth page</a></p>'
    + '<p style="color:#666;font-size:12px;margin-top:12px;" id="poll-status">Waiting for authentication...</p>'
    + '<button class="close-btn" onclick="this.closest(\\'#modal\\').classList.remove(\\'open\\')">Close</button>';
  modal.classList.add('open');

  // Click-to-copy for device code
  if (code) {
    const codeEl = mbox.querySelector('.code');
    codeEl.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => {
        document.getElementById('copy-hint').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('copy-hint').textContent = 'Click the code to copy'; }, 2000);
      });
    });
  }

  const poll = setInterval(async () => {
    try {
      const r = await fetch(pollPath + (pollPath.includes('?') ? '' : qs()));
      const d = await r.json();
      if (pollCheck(d)) {
        clearInterval(poll);
        const statusEl = document.getElementById('poll-status');
        if (statusEl) { statusEl.style.color = '#4ade80'; statusEl.textContent = 'Authenticated!'; }
        setTimeout(() => { modal.classList.remove('open'); onSuccess(d); refreshStatus(); }, 1500);
      }
    } catch {}
  }, 3000);

  // Stop polling after 5 min
  setTimeout(() => clearInterval(poll), 300000);
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.getElementById('btn-boot').onclick = async () => {
  msg('Booting & restoring credentials...');
  const r = await fetch('/api/boot' + qs(), { method: 'POST' });
  const d = await r.json();
  term.writeln('\\r\\n\\x1b[36m=== Boot report ===\\x1b[0m');
  for (const [k, v] of Object.entries(d))
    term.writeln('  ' + k + ': ' + v);
  term.writeln('');
  await refreshStatus();
  msg('Boot complete.');
};

// ── Save ───────────────────────────────────────────────────────────────────
async function doSave(destroy) {
  msg(destroy ? 'Saving & destroying...' : 'Saving credentials...');
  const r = await fetch('/api/save' + qs(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destroy }),
  });
  const d = await r.json();
  term.writeln('\\r\\n\\x1b[36m=== Save report ===\\x1b[0m');
  for (const [k, v] of Object.entries(d.saved || {}))
    term.writeln('  ' + k + ': ' + v);
  if (d.destroyed) term.writeln('\\x1b[33mContainer destroyed.\\x1b[0m');
  term.writeln('');
  msg(destroy ? 'Saved & destroyed.' : 'Credentials saved.');
}

document.getElementById('btn-save').onclick = () => doSave(false);
document.getElementById('btn-destroy').onclick = () => doSave(true);

// ── gh login ───────────────────────────────────────────────────────────────
document.getElementById('btn-gh').onclick = async () => {
  msg('Starting GitHub device flow...');
  const r = await fetch('/api/gh-login' + qs(), { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { msg('Error: ' + d.error); return; }
  showDeviceFlow({
    code: d.code, authUrl: d.authUrl,
    pollPath: '/api/gh-status',
    pollCheck: (d) => d.ok === true,
    onSuccess: () => { msg('GitHub authenticated!'); },
  });
};

// ── Wrangler login ─────────────────────────────────────────────────────────
document.getElementById('btn-wrangler').onclick = async () => {
  msg('Starting Wrangler OAuth...');
  const r = await fetch('/api/wrangler-login' + qs(), { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { msg('Error: ' + d.error); return; }

  mbox.innerHTML = '<h2>Wrangler Login</h2>'
    + '<p><a href="' + d.authUrl + '" target="_blank" rel="noopener">1. Click here to authenticate with Cloudflare</a></p>'
    + '<p style="margin-top:12px;color:#aaa;font-size:13px;">2. After approving, your browser will redirect to a <code>localhost</code> URL that won\\'t load. Copy the full URL from your browser\\'s address bar and paste it below:</p>'
    + '<input id="wrangler-cb-url" type="text" placeholder="http://localhost:8976/oauth/callback?code=..." style="width:100%;margin:12px 0;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:13px;">'
    + '<button class="btn primary" id="wrangler-cb-submit" style="width:100%;padding:10px;margin-bottom:8px;">Submit</button>'
    + '<p id="wrangler-cb-status" style="color:#666;font-size:12px;min-height:18px;"></p>'
    + '<button class="close-btn" onclick="this.closest(\\'#modal\\').classList.remove(\\'open\\')">Close</button>';
  modal.classList.add('open');

  document.getElementById('wrangler-cb-submit').onclick = async () => {
    const cbUrl = document.getElementById('wrangler-cb-url').value.trim();
    if (!cbUrl) return;
    const statusEl = document.getElementById('wrangler-cb-status');
    statusEl.textContent = 'Forwarding callback to sandbox...';
    try {
      const res = await fetch('/api/wrangler-callback' + qs(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl: cbUrl }),
      });
      const result = await res.json();
      if (result.ok) {
        statusEl.style.color = '#4ade80';
        statusEl.textContent = 'Wrangler authenticated!';
        setTimeout(() => { modal.classList.remove('open'); refreshStatus(); }, 1500);
      } else {
        statusEl.style.color = '#f87171';
        statusEl.textContent = 'Failed: ' + (result.output || 'unknown error');
      }
    } catch (e) {
      statusEl.style.color = '#f87171';
      statusEl.textContent = 'Error: ' + e;
    }
  };
};

// ── Stripe login ───────────────────────────────────────────────────────────
document.getElementById('btn-stripe').onclick = async () => {
  msg('Starting Stripe OAuth...');
  const r = await fetch('/api/stripe-login' + qs(), { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { msg('Error: ' + d.error); return; }
  showDeviceFlow({
    code: d.pairingCode, authUrl: d.authUrl,
    pollPath: '/api/stripe-status' + qs() + '&processId=' + encodeURIComponent(d.processId),
    pollCheck: (s) => s.done === true,
    onSuccess: () => { msg('Stripe authenticated!'); },
  });
};

// ── Claude login ────────────────────────────────────────────────────────────
document.getElementById('btn-claude').onclick = () => {
  mbox.innerHTML = '<h2>Claude Code Login</h2>'
    + '<p style="color:#aaa;font-size:13px;margin-bottom:12px;">Enter your Anthropic API key. It will be stored in the sandbox and persisted across sessions.</p>'
    + '<input id="claude-api-key" type="password" placeholder="sk-ant-..." style="width:100%;margin:12px 0;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:13px;font-family:monospace;">'
    + '<button class="btn primary" id="claude-submit" style="width:100%;padding:10px;margin-bottom:8px;">Save API Key</button>'
    + '<p id="claude-status" style="color:#666;font-size:12px;min-height:18px;"></p>'
    + '<button class="close-btn" onclick="this.closest(\\'#modal\\').classList.remove(\\'open\\')">Close</button>';
  modal.classList.add('open');

  document.getElementById('claude-submit').onclick = async () => {
    const apiKey = document.getElementById('claude-api-key').value.trim();
    if (!apiKey) return;
    const statusEl = document.getElementById('claude-status');
    statusEl.style.color = '#666';
    statusEl.textContent = 'Saving...';
    try {
      const res = await fetch('/api/claude-login' + qs(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const result = await res.json();
      if (result.ok) {
        statusEl.style.color = '#4ade80';
        statusEl.textContent = 'Saved! ' + result.output;
        setTimeout(() => { modal.classList.remove('open'); refreshStatus(); }, 1500);
      } else {
        statusEl.style.color = '#f87171';
        statusEl.textContent = 'Saved key, but claude check failed: ' + result.output;
        refreshStatus();
      }
    } catch (e) {
      statusEl.style.color = '#f87171';
      statusEl.textContent = 'Error: ' + e;
    }
  };
};

// ── Refresh status ─────────────────────────────────────────────────────────
document.getElementById('btn-status').onclick = refreshStatus;
</script>
</body>
</html>`;
}
