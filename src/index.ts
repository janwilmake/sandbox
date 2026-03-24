import { getSandbox, proxyToSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace;
  CREDS_BUCKET: R2Bucket;
}

// Credential directories to backup/restore
const CREDENTIAL_DIRS: Record<string, string> = {
  "gh": "/root/.config/gh",
  "stripe": "/root/.config/stripe",
  "wrangler": "/root/.wrangler/config",
  "gitconfig": "/root/.gitconfig.d",
  "claude": "/root/.claude",
};

const CREDENTIAL_FILES: Record<string, string> = {
  ".gitconfig": "/root/.gitconfig",
  ".env.sandbox": "/root/.env.sandbox",
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
        headers: { "Content-Type": "text/html" },
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
      return sandbox.terminal(request, { cols: 220, rows: 50 });
    }

    // Favicon
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Terminal page (no sandbox interaction needed)
    if (url.pathname === "/terminal") {
      return new Response(terminalHtml(sandboxId, url.hostname), {
        headers: { "Content-Type": "text/html" },
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
            return Response.json(
              { error: "No callback URL" },
              { status: 400 },
            );
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
            return Response.json(
              { error: "No processId" },
              { status: 400 },
            );
          }
          return stripeStatus(sandbox, processId);
        }

        case "/api/claude-login": {
          if (request.method !== "POST") break;
          const { apiKey } = (await request.json()) as { apiKey: string };
          if (!apiKey) {
            return Response.json({ error: "No API key" }, { status: 400 });
          }
          return claudeLogin(sandbox, apiKey);
        }

        case "/api/status": {
          return cliStatus(sandbox);
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
            stderr: r.stderr,
          });
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Boot: restore credentials from R2 ──────────────────────────────────────

async function bootSandbox(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sandboxId: string,
): Promise<Record<string, string>> {
  const report: Record<string, string> = {};

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
      `tar -xzf /tmp/creds.tar.gz -C / 2>&1 && rm /tmp/creds.tar.gz`,
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

  // Ensure container is started even if no credentials were restored
  await sandbox.exec("echo ready");

  return report;
}

// ── Save credentials to R2 ────────────────────────────────────────────────

async function saveCredentials(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sandboxId: string,
): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};

  for (const [name, containerPath] of Object.entries(CREDENTIAL_DIRS)) {
    const check = await sandbox.exec(`test -d ${containerPath} && ls ${containerPath}`);
    if (!check.success || !check.stdout.trim()) {
      saved[name] = "skipped (empty)";
      continue;
    }

    await sandbox.exec(
      `tar -czf /tmp/creds_save.tar.gz -C / ${containerPath.slice(1)} 2>&1`,
    );
    const tarFile = await sandbox.readFile("/tmp/creds_save.tar.gz");
    const tarBytes = base64ToBuffer(tarFile.content);
    await env.CREDS_BUCKET.put(`${sandboxId}/creds/${name}.tar.gz`, tarBytes, {
      httpMetadata: { contentType: "application/gzip" },
    });
    saved[name] = `saved (${Math.round(tarBytes.byteLength / 1024)} KB)`;
  }

  for (const [name, containerPath] of Object.entries(CREDENTIAL_FILES)) {
    try {
      const f = await sandbox.readFile(containerPath);
      await env.CREDS_BUCKET.put(
        `${sandboxId}/creds/files/${name}`,
        f.content,
      );
      saved[name] = "saved";
    } catch {
      saved[name] = "skipped (not found)";
    }
  }

  return saved;
}

// ── gh device-flow login ───────────────────────────────────────────────────

async function ghLogin(
  sandbox: ReturnType<typeof getSandbox>,
): Promise<Response> {
  const proc = await sandbox.startProcess(
    "gh auth login --hostname github.com --git-protocol https --web",
    { env: { GH_NO_UPDATE_NOTIFIER: "1" } },
  );

  let code: string | null = null;
  let authUrl: string | null = null;

  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const logs = await sandbox.getProcessLogs(proc.id);
    const output = (logs.stdout || "") + (logs.stderr || "");
    const codeMatch = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
    const urlMatch = output.match(/(https:\/\/github\.com\/login\/device[^\s]*)/);
    if (codeMatch) code = codeMatch[1];
    if (urlMatch) authUrl = urlMatch[1];
    if (code && authUrl) break;
  }

  if (!code || !authUrl) {
    return Response.json(
      { error: "Could not capture gh device code - try terminal" },
      { status: 500 },
    );
  }
  return Response.json({ code, authUrl, processId: proc.id });
}

// ── Wrangler login ─────────────────────────────────────────────────────────

async function wranglerLogin(
  sandbox: ReturnType<typeof getSandbox>,
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
      { status: 500 },
    );
  }
  return Response.json({ authUrl, processId: proc.id });
}

// ── Wrangler OAuth callback relay ────────────────────────────────────────────

async function wranglerCallback(
  sandbox: ReturnType<typeof getSandbox>,
  callbackUrl: string,
): Promise<Response> {
  const parsed = new URL(callbackUrl);
  const localUrl = `http://localhost:8976${parsed.pathname}${parsed.search}`;
  const result = await sandbox.exec(
    `curl -s -L -o /dev/null -w '%{http_code}' '${localUrl}'`,
  );
  const status = result.stdout.trim();
  const ok = result.success && (status.startsWith("2") || status.startsWith("3"));
  return Response.json({ ok, output: result.stdout + result.stderr });
}

// ── Stripe login ───────────────────────────────────────────────────────────

async function stripeLogin(
  sandbox: ReturnType<typeof getSandbox>,
): Promise<Response> {
  const proc = await sandbox.startProcess("stripe login 2>&1", {
    env: { NO_COLOR: "1" },
  });

  let authUrl: string | null = null;
  let pairingCode: string | null = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const logs = await sandbox.getProcessLogs(proc.id);
    const output = (logs.stdout || "") + (logs.stderr || "");
    const urlMatch = output.match(
      /(https:\/\/dashboard\.stripe\.com\/stripecli\/[^\s]+)/,
    );
    const codeMatch = output.match(
      /pairing code[:\s]+([a-z]+-[a-z]+-[a-z]+-[a-z]+)/i,
    );
    if (urlMatch) authUrl = urlMatch[1];
    if (codeMatch) pairingCode = codeMatch[1];
    if (authUrl) break;
  }

  if (!authUrl) {
    return Response.json(
      { error: "Could not capture Stripe auth URL - try terminal" },
      { status: 500 },
    );
  }
  return Response.json({ authUrl, pairingCode, processId: proc.id });
}

// ── Stripe status (poll process logs) ────────────────────────────────────────

async function stripeStatus(
  sandbox: ReturnType<typeof getSandbox>,
  processId: string,
): Promise<Response> {
  const logs = await sandbox.getProcessLogs(processId);
  const output = (logs.stdout || "") + (logs.stderr || "");
  const done = /done|configured|success/i.test(output);
  return Response.json({ done, output });
}

// ── Claude Code login ────────────────────────────────────────────────────────

async function claudeLogin(
  sandbox: ReturnType<typeof getSandbox>,
  apiKey: string,
): Promise<Response> {
  // Write/update the env file with the API key
  const envLine = `export ANTHROPIC_API_KEY="${apiKey}"\n`;
  await sandbox.writeFile("/root/.env.sandbox", envLine);
  // Source it from .bashrc so it's available in all shells
  await sandbox.exec(
    `grep -q '.env.sandbox' /root/.bashrc || echo '. /root/.env.sandbox' >> /root/.bashrc`,
  );
  // Also export it in the current sandbox environment for immediate use
  const check = await sandbox.exec(
    `. /root/.env.sandbox && claude --version 2>&1`,
  );
  return Response.json({
    ok: check.success,
    output: check.stdout.trim() || check.stderr.trim(),
  });
}

// ── CLI status ─────────────────────────────────────────────────────────────

async function cliStatus(
  sandbox: ReturnType<typeof getSandbox>,
): Promise<Response> {
  const [gh, wrangler, stripe, claude] = await Promise.all([
    sandbox
      .exec("gh auth status 2>&1")
      .then((r) => (r.success ? "authenticated" : "not logged in")),
    sandbox
      .exec("wrangler whoami 2>&1")
      .then((r) =>
        r.success ? r.stdout.trim().split("\n")[0] : "not logged in",
      ),
    sandbox
      .exec("test -s /root/.config/stripe/config.toml && echo ok || echo no")
      .then((r) => (r.stdout.trim() === "ok" ? "authenticated" : "not logged in")),
    sandbox
      .exec(". /root/.env.sandbox 2>/dev/null; test -n \"$ANTHROPIC_API_KEY\" && echo configured || echo not configured")
      .then((r) => r.stdout.trim() || "not configured"),
  ]);
  return Response.json({ gh, wrangler, stripe, claude });
}

// ── Utilities ──────────────────────────────────────────────────────────────

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
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; flex-direction: column; height: 100vh;
  }
  #toolbar {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; background: #141414;
    border-bottom: 1px solid #2a2a2a; flex-wrap: wrap;
  }
  #toolbar .id-label {
    font-size: 13px; color: #4a9eff; font-weight: 600;
    margin-right: auto;
  }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #333;
    background: #1a1a1a; color: #ccc; font-size: 12px; cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { border-color: #4a9eff; color: #fff; }
  .btn.primary { background: #4a9eff; border-color: #4a9eff; color: #fff; }
  .btn.primary:hover { background: #3a8eef; }
  .btn.danger { border-color: #ff4a4a; color: #ff4a4a; }
  .btn.danger:hover { background: #ff4a4a; color: #fff; }

  #status-bar {
    display: flex; gap: 8px; padding: 6px 12px;
    background: #111; border-bottom: 1px solid #222;
    flex-wrap: wrap; align-items: center;
  }
  .cli-chip {
    font-size: 11px; padding: 3px 10px; border-radius: 12px;
    font-weight: 500;
  }
  .cli-chip.ok { background: #0a2e1a; color: #4ade80; }
  .cli-chip.bad { background: #2e0a0a; color: #f87171; }
  .cli-chip.unknown { background: #1a1a1a; color: #888; }
  #status-msg {
    margin-left: auto; font-size: 11px; color: #666;
  }

  #term-wrap {
    flex: 1; padding: 4px; overflow: hidden;
  }
  #terminal { height: 100%; }

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
  .mbox .close-btn:hover { color: #fff; border-color: #4a9eff; }
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

<div id="term-wrap"><div id="terminal"></div></div>

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

function connectTerm() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws/terminal' + qs());
  ws.binaryType = 'arraybuffer';

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
    setTimeout(connectTerm, 2000);
  };

  // Send keystrokes as binary frames
  term.onData((data) => {
    if (ws.readyState === 1) {
      ws.send(new TextEncoder().encode(data));
    }
  });
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
