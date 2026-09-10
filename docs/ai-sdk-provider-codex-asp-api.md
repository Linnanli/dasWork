# Codex App Server Client API

This document records the request lifecycle contract for the AI-free
`@dascowork/codex-app-server-client` package used by the desktop host.

## Request Deadlines

`AppServerClientSettings.requestTimeoutMs` is an explicit caller-owned deadline.
When it is `undefined` or `0`, the client does not install a request timer. In
that mode the app-server, an explicit cancellation, a JSON-RPC server error, or
transport termination owns the request outcome.

Do not use `requestTimeoutMs` as a general safety timeout for catalog reads such
as `plugin/installed`, `app/installed`, or `app/read`. Those calls can complete
after long app-server work and must not be failed by a fixed desktop-side timer.

`waitForPendingRequests(timeoutMs?)` is a shutdown drain guard, not a normal RPC
deadline. Its default is the independent
`DEFAULT_PENDING_REQUEST_DRAIN_TIMEOUT_MS`, and callers may pass a different
drain bound for their teardown path.

## Error Classification

Outbound request failures are classified so callers can distinguish user intent,
deadline expiry, transport state, and real app-server failures:

- `CodexRequestCancelledError` with code `app_server_request_cancelled` means the
  local caller intentionally stopped waiting, such as during client disconnect.
- `CodexRequestDeadlineExceededError` with code
  `app_server_request_deadline_exceeded` means an explicit
  `requestTimeoutMs > 0` expired.
- `CodexProviderError` with code `app_server_transport_closed` or
  `app_server_transport_terminated` means the transport ended before the request
  completed.
- `JsonRpcError` means the app-server returned a JSON-RPC error response. It
  preserves the numeric server error code and optional server data.

Callers must not treat cancellation, explicit deadlines, or transport
termination as "method unsupported" fallback signals.

## Lifecycle Observation

`AppServerClientSettings.onRequestLifecycle(event)` is optional and defaults to
no-op. It is for local diagnostics only and does not change request behavior.

Events contain only safe metadata:

- `method`
- `phase`: `started`, `sent`, or `settled`
- `durationMs` when available
- `outcome`: `completed`, `cancelled`, `explicit-deadline`, `server-error`, or
  `transport-terminated`
- `pendingCount`

Events never include JSON-RPC params, cwd, thread content, plugin config,
account data, provider credentials, access tokens, or app-server response data.
