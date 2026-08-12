import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const DEFAULT_SERVER_URL = "https://crunchyroll-be.glean.com/mcp/default";
const TOOL_PREFIX = "glean_";
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIG_FILE_NAME = "glean-mcp.json";

const GLOBAL_CONFIG_DIR = join(homedir(), CONFIG_DIR_NAME, "agent");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, CONFIG_FILE_NAME);

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Config {
  serverUrl: string;
  autoConnect: boolean;
}

type ConfigScope = "global" | "project";

const DEFAULT_CONFIG: Config = {
  serverUrl: DEFAULT_SERVER_URL,
  autoConnect: true,
};

function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function readConfig(path: string): Promise<Config | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}: ${(err as Error).message}`);
  }

  let parsed: { serverUrl?: unknown; autoConnect?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  const serverUrl = typeof parsed.serverUrl === "string" ? parsed.serverUrl.trim() : DEFAULT_SERVER_URL;
  return {
    serverUrl: isValidServerUrl(serverUrl) ? serverUrl : DEFAULT_SERVER_URL,
    autoConnect: parsed.autoConnect !== false,
  };
}

async function loadEffectiveConfig(cwd: string, trusted: boolean): Promise<{ config: Config; scope: ConfigScope }> {
  if (trusted) {
    const project = await readConfig(projectConfigPath(cwd));
    if (project) return { config: project, scope: "project" };
  }

  return {
    config: (await readConfig(GLOBAL_CONFIG_PATH)) ?? { ...DEFAULT_CONFIG },
    scope: "global",
  };
}

async function saveConfig(scope: ConfigScope, cwd: string, config: Config): Promise<void> {
  const path = scope === "project" ? projectConfigPath(cwd) : GLOBAL_CONFIG_PATH;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
}

function resolveMcpRemoteBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("mcp-remote/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: Record<string, string> };
  const rel = pkg.bin?.["mcp-remote"];
  if (!rel) {
    throw new Error("Installed mcp-remote package exposes no 'mcp-remote' binary");
  }
  return join(dirname(pkgPath), rel);
}

function toolNameFor(mcpName: string): string {
  return `${TOOL_PREFIX}${mcpName}`;
}

function sanitizeDescription(value: string | undefined): string {
  if (!value) return "Glean MCP tool";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 400) || "Glean MCP tool";
}

function schemaOrFallback(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

function parseScope(input: string | undefined, trusted: boolean): ConfigScope | undefined {
  if (!input) return undefined;
  if (input === "global") return "global";
  if (input === "project") return trusted ? "project" : undefined;
  return undefined;
}

export default function gleanMcpExtension(pi: ExtensionAPI) {
  let client: Client | undefined;
  let clientUrl: string | undefined;
  let connecting: Promise<Client> | undefined;
  const registered = new Set<string>();

  async function closeClient() {
    if (!client) return;
    const current = client;
    client = undefined;
    clientUrl = undefined;
    try {
      await current.close();
    } catch {
      // no-op
    }
  }

  async function connect(
    serverUrl: string,
    ctx: { ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } },
  ) {
    if (client && clientUrl === serverUrl) return client;
    if (connecting) return connecting;

    if (client && clientUrl !== serverUrl) {
      await closeClient();
    }

    connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolveMcpRemoteBin(), serverUrl],
        stderr: "pipe",
      });

      const c = new Client({ name: "pi-glean-mcp", version: "0.2.0" }, { capabilities: {} });
      ctx.ui.notify(`Connecting to Glean MCP: ${serverUrl}`, "info");
      await c.connect(transport);

      c.onclose = () => {
        if (client === c) {
          client = undefined;
          clientUrl = undefined;
        }
      };
      c.onerror = () => {
        if (client === c) {
          client = undefined;
          clientUrl = undefined;
        }
      };

      client = c;
      clientUrl = serverUrl;
      return c;
    })();

    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }

  async function discoverAndRegister(
    serverUrl: string,
    ctx: { ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } },
  ) {
    const c = await connect(serverUrl, ctx);
    const { tools } = await c.listTools();

    let added = 0;
    for (const tool of tools as McpToolDef[]) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) continue;

      const name = toolNameFor(tool.name);
      if (registered.has(name) || pi.getAllTools().some((t) => t.name === name)) continue;

      pi.registerTool({
        name,
        label: `Glean: ${tool.name}`,
        description: sanitizeDescription(tool.description),
        parameters: schemaOrFallback(tool.inputSchema),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal) {
          const active = client ?? c;
          const result = await active.callTool(
            { name: tool.name, arguments: params as Record<string, unknown> },
            undefined,
            { signal },
          );

          const text = Array.isArray(result.content)
            ? result.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join("\n")
            : JSON.stringify(result);

          if (result.isError) {
            throw new Error(text || "Glean MCP tool call failed");
          }

          return {
            content: [{ type: "text" as const, text: text || "(no output)" }],
            details: { raw: result },
          };
        },
      });

      registered.add(name);
      added += 1;
    }

    const all = pi.getAllTools().map((t) => t.name);
    const gleanTools = Array.from(registered).filter((n) => all.includes(n));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...gleanTools])]);

    ctx.ui.notify(`Glean MCP ready (${added} new tools, ${gleanTools.length} active).`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { config } = await loadEffectiveConfig(ctx.cwd, ctx.isProjectTrusted());
      if (!config.autoConnect) return;
      await discoverAndRegister(config.serverUrl, ctx);
    } catch (err) {
      ctx.ui.notify(`Glean MCP auto-connect skipped: ${(err as Error).message}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await closeClient();
  });

  pi.registerCommand("glean-setup", {
    description: "Configure Glean MCP server URL and auto-connect (scope: global/project)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const trusted = ctx.isProjectTrusted();
      const scope = parseScope(parts[1], trusted) ?? "global";

      let serverUrl = parts[0];
      if (!serverUrl && ctx.hasUI) {
        const entered = await ctx.ui.input(
          "Glean MCP server URL",
          "Paste URL from https://app.glean.com/settings/connected-apps",
        );
        serverUrl = entered?.trim() ?? "";
      }

      if (!serverUrl) {
        ctx.ui.notify("Usage: /glean-setup <serverUrl> [global|project]", "warning");
        return;
      }

      if (!isValidServerUrl(serverUrl)) {
        ctx.ui.notify("Invalid URL. Expected https://...", "error");
        return;
      }

      const config: Config = { serverUrl, autoConnect: true };
      await saveConfig(scope, ctx.cwd, config);

      ctx.ui.notify(`Saved Glean MCP config (${scope}).`, "info");
      try {
        await discoverAndRegister(config.serverUrl, ctx);
      } catch (err) {
        ctx.ui.notify(`Config saved, but connect failed: ${(err as Error).message}`, "warning");
      }
    },
  });

  pi.registerCommand("glean-connect", {
    description: "Connect to configured Glean MCP server and register tools",
    handler: async (_args, ctx) => {
      try {
        const { config } = await loadEffectiveConfig(ctx.cwd, ctx.isProjectTrusted());
        await discoverAndRegister(config.serverUrl, ctx);
      } catch (err) {
        ctx.ui.notify(`Glean MCP connect failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("glean-autoconnect", {
    description: "Toggle auto-connect on session start: /glean-autoconnect <on|off> [global|project]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || (parts[0] !== "on" && parts[0] !== "off")) {
        ctx.ui.notify("Usage: /glean-autoconnect <on|off> [global|project]", "warning");
        return;
      }

      const trusted = ctx.isProjectTrusted();
      const scope = parseScope(parts[1], trusted) ?? "global";
      const existing =
        (scope === "project" ? await readConfig(projectConfigPath(ctx.cwd)) : await readConfig(GLOBAL_CONFIG_PATH)) ??
        { ...DEFAULT_CONFIG };

      const next: Config = {
        serverUrl: existing.serverUrl,
        autoConnect: parts[0] === "on",
      };

      await saveConfig(scope, ctx.cwd, next);
      ctx.ui.notify(`Auto-connect set to ${next.autoConnect ? "on" : "off"} (${scope}).`, "info");
    },
  });

  pi.registerCommand("glean-off", {
    description: "Disable all Glean MCP tools for this session",
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      const next = active.filter((n) => !n.startsWith(TOOL_PREFIX));
      pi.setActiveTools(next);
      ctx.ui.notify("Disabled Glean MCP tools for this session.", "info");
    },
  });

  pi.registerCommand("glean-reconnect", {
    description: "Reconnect Glean MCP and refresh tool registration",
    handler: async (_args, ctx) => {
      try {
        const { config } = await loadEffectiveConfig(ctx.cwd, ctx.isProjectTrusted());
        await closeClient();
        await discoverAndRegister(config.serverUrl, ctx);
      } catch (err) {
        ctx.ui.notify(`Glean MCP reconnect failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("glean-config", {
    description: "Show effective Glean MCP config",
    handler: async (_args, ctx) => {
      try {
        const { config, scope } = await loadEffectiveConfig(ctx.cwd, ctx.isProjectTrusted());
        ctx.ui.notify(`Glean config (${scope}): autoConnect=${String(config.autoConnect)}, url=${config.serverUrl}`, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to read Glean config: ${(err as Error).message}`, "error");
      }
    },
  });
}
