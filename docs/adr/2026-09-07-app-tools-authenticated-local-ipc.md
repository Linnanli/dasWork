# ADR: Codex App Tools authenticated local IPC

Status: proposed; public-release blocker

## Context

The App Tools MCP bridge is a separate process that connects to a local
Native Pipe endpoint owned by Electron main. A Unix socket path under a
`0700` directory and mode `0600` restricts ordinary filesystem access, but
does not authenticate the peer process. Windows named pipes require an
explicit owner-only DACL at creation time and must reject remote clients.

Neither a random endpoint name nor a bridge-local challenge can prove that a
connection belongs to the current Codex app-server generation or its MCP child
process. Node private handles are not a supported cross-platform identity API.

## Decision

Use a narrow, signed native IPC authorizer/broker when supported Node APIs
cannot provide all required identity attributes:

1. The broker owns the Unix socket or Windows named pipe. It accepts a
   connection only after obtaining OS-level peer identity before reading a
   business frame.
2. On macOS and Linux it obtains peer UID/PID from a supported OS API. On
   Windows it creates the named pipe with an owner-only DACL, disables remote
   clients, and obtains the client PID and token SID.
3. Electron main registers an authorization lease for each current
   app-server generation. The lease contains the expected process ancestry
   and permitted MCP child process tree. The broker verifies UID/SID, PID,
   ancestry, generation and executable identity against that lease.
4. Main receives only frames from an authenticated session. It continues to
   own Native Pipe JSON-RPC decoding, context checks, cancellation and the
   dynamic tool registry.
5. Generation shutdown revokes the lease, closes authenticated clients,
   aborts pending tool calls and removes the endpoint. A per-generation
   challenge is a second factor only after OS identity validation.

## Rejected alternatives

- Treating Unix path permissions as peer authentication.
- Reading a Node private `_handle` to obtain credentials.
- Applying a Windows ACL after listening.
- Authorizing any process of the same user.
- Using a challenge token as the sole identity check.

## Consequences

The existing TypeScript Native Pipe remains an internal/development transport
and Windows continues to fail closed until the broker is built, packaged and
signed. Public-release gates `AT-PIPE-MAC-01` and `AT-PIPE-WIN-01` remain
pending until negative tests prove rejection of wrong ancestry, old
generations, replayed challenges, wrong SID/UID and preemptive connections.
