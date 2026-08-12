# pi-glean-mcp

Pi extension that bridges a Glean MCP server into Pi tools.

## Install

```bash
pi install npm:pi-glean-mcp
```

## Configure

Get your Glean MCP URL from:

- https://app.glean.com/settings/connected-apps

On first session start, the extension will ask for the server URL if it is not configured yet.

You can also configure it manually:

```text
/glean-setup https://<your-glean-host>/mcp/default
```

You can also choose scope:

```text
/glean-setup https://<your-glean-host>/mcp/default global
/glean-setup https://<your-glean-host>/mcp/default project
```

## Commands

- `/glean <message>` — explicitly call the Glean MCP chat tool (`glean_chat`) and return the raw response in-session
- `/glean-setup <serverUrl> [global|project]` — save URL and enable auto-connect
- `/glean-connect` — connect now and register tools
- `/glean-reconnect` — reconnect and refresh tools
- `/glean-off` — disable `glean_*` tools for this session
- `/glean-autoconnect <on|off> [global|project]` — toggle auto-connect
- `/glean-config` — show effective config

## Behavior

- No default server URL is baked in.
- On first initialization (when URL is missing), it prompts for server URL in TUI.
- Auto-connects on session start when `autoConnect=true` and URL is configured.
- Global config: `~/.pi/agent/glean-mcp.json`
- Project override: `.pi/glean-mcp.json`
- Registered tools are prefixed as `glean_<toolName>`
- `glean_chat` is always registered as the canonical chat entry point

### /glean usage

```text
/glean summarize the latest Android TV playback incidents from the last week
```

This hook directly invokes the MCP chat tool and prints the tool output back to the session.
