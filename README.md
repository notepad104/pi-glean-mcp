# pi-glean-mcp

Pi extension that bridges a Glean MCP server into Pi tools.

## Install

```bash
pi install npm:pi-glean-mcp
```

## Configure

Get your Glean MCP URL from:

- https://app.glean.com/settings/connected-apps

Then in Pi:

```text
/glean-setup https://<your-glean-host>/mcp/default
```

You can also choose scope:

```text
/glean-setup https://<your-glean-host>/mcp/default global
/glean-setup https://<your-glean-host>/mcp/default project
```

## Commands

- `/glean-setup <serverUrl> [global|project]` — save URL and enable auto-connect
- `/glean-connect` — connect now and register tools
- `/glean-reconnect` — reconnect and refresh tools
- `/glean-off` — disable `glean_*` tools for this session
- `/glean-autoconnect <on|off> [global|project]` — toggle auto-connect
- `/glean-config` — show effective config

## Behavior

- Auto-connects on session start when `autoConnect=true`
- Global config: `~/.pi/agent/glean-mcp.json`
- Project override: `.pi/glean-mcp.json`
- Registered tools are prefixed as `glean_<toolName>`
