Use the `kernel` MCP server to perform this read-only connection check:

1. Call `get_connection_context`.
2. Call `manage_browsers` with `action: "list"`, `status: "active"`, and `limit: 1`.
3. Write `/logs/artifacts/agent-report.json` with this exact shape, using values from the tool results:

```json
{
  "get_connection_context_succeeded": true,
  "manage_browsers_list_succeeded": true,
  "connection_scope_kind": "project",
  "project_id": "the project ID returned by get_connection_context",
  "active_browser_count": 0
}
```

Set `active_browser_count` to the number of returned browser items, even if it is not zero. Do not create, update, or delete any Kernel resource. Make both calls through the configured `kernel` MCP tools. Do not use shell commands, HTTP clients, custom MCP clients, or inspect credentials and MCP configuration as a fallback. If the `kernel` tools are unavailable, stop without a workaround.
