# Mia Chat MCP

Mia Cloud exposes a stateless Streamable HTTP MCP endpoint at:

```text
https://<mia-cloud-host>/mcp
```

Use a normal Mia session token in the HTTP header:

```text
Authorization: Bearer <mia-session-token>
```

The token stays in the MCP client's HTTP configuration. Do not put it in the URL, prompts, or logs. Use HTTPS outside local development.

## Scope

The endpoint deliberately exposes exactly six tools:

- `list_bots`
- `create_bot`
- `list_conversations`
- `create_conversation`
- `send_message`
- `get_messages`

It does not expose tasks, schedules, files, shell commands, or desktop-control tools.

All operations use the authenticated account's existing Mia bot, conversation, runtime-binding, event, and message stores. Owner and conversation-membership checks apply to every read or write.

## Message path

`send_message` appends a normal Mia user message and invokes the bot through the existing runtime:

- `cloud-claude-code` runs through Mia Cloud's agent dispatcher.
- `desktop-local` sends the invocation through the existing Cloud Bridge to the selected Mia desktop device.

The tool waits for the bot reply saved against the triggering user message. Its default wait is 120 seconds and its maximum is 300 seconds. If it returns `timed_out: true`, the invocation continues and the caller can use `get_messages` to retrieve the eventual reply.

## Transport behavior

- JSON-RPC requests use `POST /mcp`.
- The server returns JSON responses and does not open a server-sent-event stream.
- `GET` and `DELETE` return `405 Method Not Allowed`.
- No MCP session id is created; any Mia Cloud instance can serve each request.
- Supported protocol versions are `2025-11-25`, `2025-06-18`, and `2025-03-26`.

Example initialization request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {},
    "clientInfo": {
      "name": "remote-agent",
      "version": "1.0.0"
    }
  }
}
```
