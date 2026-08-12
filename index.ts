import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const TOOL_PREFIX = "glean_";
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIG_FILE_NAME = "glean-mcp.json";
const CHAT_TOOL_NAME = "glean_chat";
const CHAT_MCP_TOOL_CANDIDATES = ["chat", "glean_chat"];

const GLOBAL_CONFIG_DIR = join(homedir(), CONFIG_DIR_NAME, "agent");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, CONFIG_FILE_NAME);

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface Config {
  serverUrl?: string;
  autoConnect: boolean;
}

type ConfigScope = "global" | "project";

const DEFAULT_CONFIG: Config = {
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

  const rawServerUrl = typeof parsed.serverUrl === "string" ? parsed.serverUrl.trim() : "";
  return {
    serverUrl: isValidServerUrl(rawServerUrl) ? rawServerUrl : undefined,
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

function extractToolText(result: { content?: unknown; [key: string]: unknown }): string {
  return Array.isArray(result.content)
    ? result.content
        .filter((part): part is { type: "text"; text: string } => {
          return (
            !!part &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
          );
        })
        .map((part) => part.text)
        .join("\n")
    : JSON.stringify(result);
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
      if (name === CHAT_TOOL_NAME) continue;
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

          const text = extractToolText(result as { content?: unknown; [key: string]: unknown });

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

  async function getConfiguredServerUrl(cwd: string, trusted: boolean): Promise<string> {
    const { config } = await loadEffectiveConfig(cwd, trusted);
    if (!config.serverUrl) {
      throw new Error("Glean MCP not configured. Run /glean-setup <serverUrl>");
    }
    return config.serverUrl;
  }

  async function resolveChatMcpToolName(c: Client): Promise<string> {
    const { tools } = await c.listTools();
    for (const candidate of CHAT_MCP_TOOL_CANDIDATES) {
      if ((tools as McpToolDef[]).some((tool) => tool.name === candidate)) {
        return candidate;
      }
    }

    const available = (tools as McpToolDef[]).map((tool) => tool.name).join(", ");
    throw new Error(
      `No chat tool exposed by Glean MCP server. Expected one of: ${CHAT_MCP_TOOL_CANDIDATES.join(", ")}. Available: ${available || "none"}`,
    );
  }

  async function callGleanChat(
    message: string,
    context: string[],
    ctx: { cwd: string; isProjectTrusted: () => boolean; ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } },
  ): Promise<string> {
    const serverUrl = await getConfiguredServerUrl(ctx.cwd, ctx.isProjectTrusted());
    const c = await connect(serverUrl, ctx);
    const chatTool = await resolveChatMcpToolName(c);

    const argCandidates: Record<string, unknown>[] = [
      { message, context },
      { query: message, context },
      { prompt: message, context },
      { message },
      { query: message },
      { prompt: message },
    ];

    let lastError: Error | undefined;
    for (const args of argCandidates) {
      try {
        const result = await c.callTool({ name: chatTool, arguments: args });
        const text = extractToolText(result as { content?: unknown; [key: string]: unknown });
        if ((result as { isError?: boolean }).isError) {
          throw new Error(text || "Glean chat returned an error response");
        }
        return text || "(no output)";
      } catch (err) {
        lastError = err as Error;
      }
    }

    throw new Error(lastError?.message ?? "Glean chat call failed");
  }

  pi.registerTool({
    name: CHAT_TOOL_NAME,
    label: "Glean Chat",
    description: "AI-powered tool for company knowledge. Synthesizes information from multiple sources with intelligent analysis.",
    parameters: {
      type: "object",
      required: ["message"],
      properties: {
        message: {
          type: "string",
          description: "The user question or message to send to Glean Assistant",
        },
        context: {
          type: "array",
          items: { type: "string" },
          description: "Optional previous messages for context",
        },
      },
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      const context = Array.isArray(params.context)
        ? params.context.filter((item): item is string => typeof item === "string")
        : [];

      if (!message) {
        throw new Error("message must not be empty");
      }

      const output = await callGleanChat(message, context, {
        cwd: process.cwd(),
        isProjectTrusted: () => true,
        ui: {
          notify: () => {
            // no-op in tool execution path
          },
        },
      });

      return {
        content: [{ type: "text" as const, text: output || "(no output)" }],
      };
    },
  });

  registered.add(CHAT_TOOL_NAME);

  pi.on("session_start", async (_event, ctx) => {
    try {
      const trusted = ctx.isProjectTrusted();
      const { config, scope } = await loadEffectiveConfig(ctx.cwd, trusted);

      if (!config.serverUrl) {
        if (ctx.hasUI) {
          const entered = await ctx.ui.input(
            "Glean MCP server URL",
            "Paste URL from https://app.glean.com/settings/connected-apps",
          );
          const serverUrl = entered?.trim() ?? "";
          if (isValidServerUrl(serverUrl)) {
            const initialized: Config = {
              serverUrl,
              autoConnect: config.autoConnect,
            };
            await saveConfig(scope, ctx.cwd, initialized);
            ctx.ui.notify(`Saved Glean MCP config (${scope}).`, "info");
            if (initialized.autoConnect) {
              await discoverAndRegister(serverUrl, ctx);
            }
          } else {
            ctx.ui.notify(
              "Glean MCP not configured. Run /glean-setup <serverUrl> after you get the URL from https://app.glean.com/settings/connected-apps",
              "warning",
            );
          }
        } else {
          ctx.ui.notify(
            "Glean MCP not configured. Run /glean-setup <serverUrl> in TUI using URL from https://app.glean.com/settings/connected-apps",
            "warning",
          );
        }
        return;
      }

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
        if (!config.serverUrl) {
          ctx.ui.notify("Glean MCP not configured. Run /glean-setup <serverUrl>", "warning");
          return;
        }
        await discoverAndRegister(config.serverUrl, ctx);
      } catch (err) {
        ctx.ui.notify(`Glean MCP connect failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("glean", {
    description: "Send a prompt to Glean chat through MCP",
    handler: async (args, ctx) => {
      const message = (args ?? "").trim();
      if (!message) {
        ctx.ui.notify("Usage: /glean <message>", "warning");
        return;
      }

      try {
        ctx.ui.notify("Querying Glean MCP chat...", "info");
        const output = await callGleanChat(message, [], ctx);
        pi.sendMessage({
          customType: "glean-chat-result",
          content: output,
          display: true,
        });
      } catch (err) {
        ctx.ui.notify(`Glean chat failed: ${(err as Error).message}`, "error");
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
        if (!config.serverUrl) {
          ctx.ui.notify("Glean MCP not configured. Run /glean-setup <serverUrl>", "warning");
          return;
        }
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
        const url = config.serverUrl ?? "<not configured>";
        ctx.ui.notify(`Glean config (${scope}): autoConnect=${String(config.autoConnect)}, url=${url}`, "info");
      } catch (err) {
        ctx.ui.notify(`Failed to read Glean config: ${(err as Error).message}`, "error");
      }
    },
  });
}
