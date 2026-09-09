# Codex App Tools MCP Bridge Protocol

Status: implementation specification  
Owner: DasCowork desktop application  
Version: 1

## Scope and source boundary

This document specifies the repository-owned stdio bridge used by the
`codex-app-tools` bundled plugin. Its protocol contract is defined from:

- DasCowork's `nativePipeProtocol.ts` and `nativePipeServer.ts`;
- the public MCP JSON-RPC tools protocol; and
- black-box compatibility tests that exercise the desktop-owned registry.

The bridge does not own, duplicate, or call a second tool registry. It
translates MCP stdio messages to the authenticated Native Pipe endpoint whose
path is supplied by the Electron main process. The Pipe remains the authority
for tool availability, context validation, dispatch, cancellation, and output.

Compatibility tests verify the public contract against the project-owned Pipe
and registry only. An independent clean-room and legal provenance review is
still required before public release; this specification is an engineering
contract, not a legal approval.

## Transport limits

- Stdio uses one UTF-8 JSON-RPC 2.0 message per line. The bridge writes
  protocol responses to stdout only; diagnostics go to stderr.
- The Native Pipe uses a four-byte little-endian length prefix followed by a
  UTF-8 JSON-RPC 2.0 message.
- Native Pipe frames must be non-empty and no larger than 8 MiB. A malformed
  or oversized frame terminates the Pipe session.
- `CODEX_APP_TOOLS_PIPE_PATH` is mandatory. The bridge must fail closed when
  it is missing or the endpoint disconnects.

## MCP lifecycle

| MCP request or notification | Bridge behaviour |
| --- | --- |
| `initialize` | Returns protocol version `2025-03-26`, a tools capability, and the bridge server identity. |
| `notifications/initialized` | Accepted as a notification; no response is written. |
| `tools/list` | Projects the MCP metadata context to `tools/list` on the Native Pipe and projects each result to the public MCP `name`, optional `description`, and `inputSchema` fields. |
| `tools/call` | Calls `tools/call` on the Native Pipe with namespace `codex_app`, tool name, arguments, and normalized OpenAI metadata context. |
| `notifications/cancelled` | If its `requestId` maps to an active MCP tool call, sends `tools/cancel` for that Native Pipe request. No response is written. |
| `shutdown` | Returns an empty result, closes the Pipe, and exits after stdout is flushed. |

Unknown MCP requests receive JSON-RPC error `-32601`. Malformed requests
receive `-32600`; invalid JSON receives `-32700`.

## Context and call mapping

The bridge reads optional MCP `_meta` keys:

| MCP metadata key | Native Pipe field |
| --- | --- |
| `openai/threadId` | `threadId` |
| `openai/turnId` | `turnId` |
| `openai/toolCallId` | `callId` |

For `tools/call`, the bridge sends:

```json
{
  "jsonrpc": "2.0",
  "id": "<bridge-generated-request-id>",
  "method": "tools/call",
  "params": {
    "namespace": "codex_app",
    "name": "<MCP tool name>",
    "arguments": {},
    "threadId": "<optional>",
    "turnId": "<optional>",
    "callId": "<optional>"
  }
}
```

The bridge never accepts a caller-selected namespace. The Pipe's context and
registry remain authoritative.

## Result and error mapping

Native Pipe tool results use the desktop registry result shape:

```json
{
  "success": true,
  "contentItems": [
    { "type": "inputText", "text": "..." }
  ]
}
```

Each `inputText` item becomes MCP `{ "type": "text", "text": "..." }`.
An image item is preserved as MCP image content only when its URL is a
`data:image/*;base64,...` URL; all other image URLs fail the call with a
text error rather than exposing a local path or inventing image bytes. The
MCP result sets `isError` to the inverse of `success`.

Native Pipe JSON-RPC errors retain their code and message in the MCP JSON-RPC
error response. Connection failures and invalid registry result shapes use
`-32000` without leaking the Pipe path or environment.

## Security and release boundary

The bridge is not an authentication mechanism. It depends on the Native Pipe
authorizer for peer identity and generation checks. If that authorizer is
unavailable, the MCP bridge must fail closed; a path permission or a
bridge-local challenge cannot substitute for peer authentication.

Every file distributed in this plugin is listed with SHA-256 in
`bundle-lock.json`. The lock records repository-owned provenance, a license
file, and its independent-review status. The public bundle verifier rejects
unknown files, source paths under `reference-projects/`, the known
pre-replacement server digest, and any provenance that has not been approved
by the independent review.
