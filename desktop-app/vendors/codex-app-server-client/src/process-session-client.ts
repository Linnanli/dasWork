import { StringDecoder } from "node:string_decoder";

import { AppServerClient } from "./client/app-server-client";
import type { CodexTransport } from "./client/transport";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import type { CodexAppServerClientSettings, TransportContext } from "./client-settings";
import type { CodexCommandJsonRpcClientLike } from "./command-client";
import { CodexProviderError } from "./errors";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type { ProcessExitedNotification } from "./protocol/app-server-protocol/v2/ProcessExitedNotification";
import type { ProcessOutputDeltaNotification } from "./protocol/app-server-protocol/v2/ProcessOutputDeltaNotification";
import type { ProcessResizePtyParams } from "./protocol/app-server-protocol/v2/ProcessResizePtyParams";
import type { ProcessSpawnParams } from "./protocol/app-server-protocol/v2/ProcessSpawnParams";
import type { ProcessWriteStdinParams } from "./protocol/app-server-protocol/v2/ProcessWriteStdinParams";
import type { CodexInitializeParams, CodexInitializeResult } from "./protocol/types";
import { stripUndefined } from "./utils/object";

const MAX_PENDING_INPUT_BYTES = 64 * 1024;
let nextProcessHandle = 1;

export type CodexProcessSessionExit = {
    exitCode: number | null;
};

export type CodexProcessSession = {
    processHandle: string;
    write(data: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    kill(): Promise<void>;
    onData(listener: (data: string) => void): () => void;
    onExit(listener: (event: CodexProcessSessionExit) => void): () => void;
    onConnectionLost(listener: (error: Error) => void): () => void;
};

export type CodexProcessSessionSpawnOptions = {
    command: string[];
    cwd: string;
    cols: number;
    rows: number;
    env?: Record<string, string | null | undefined>;
};

export interface CodexProcessSessionClientSettings extends CodexAppServerClientSettings {
    createClient?: () => CodexCommandJsonRpcClientLike;
    requestTimeoutMs?: number;
}

export class CodexProcessSessionClient
{
    private readonly createClient: () => CodexCommandJsonRpcClientLike;
    private client: CodexCommandJsonRpcClientLike | undefined;
    private connectPromise: Promise<void> | undefined;
    private connected = false;
    private shuttingDown = false;
    private readonly sessions = new Map<string, ProcessSession>();
    private removeOutputListener: (() => void) | undefined;
    private removeExitListener: (() => void) | undefined;
    private removeTransportTerminationListener: (() => void) | undefined;

    constructor(private readonly settings: CodexProcessSessionClientSettings = {})
    {
        this.createClient = settings.createClient ?? (() => createDefaultClient(settings));
    }

    async connect(): Promise<void>
    {
        if (this.shuttingDown)
        {
            throw new CodexProviderError("Process session client is shut down.");
        }
        if (this.connected)
        {
            return;
        }
        this.connectPromise ??= this.initializeConnection();
        await this.connectPromise;
    }

    async spawn(options: CodexProcessSessionSpawnOptions): Promise<CodexProcessSession>
    {
        if (options.command.length === 0)
        {
            throw new CodexProviderError("Process argv vector cannot be empty.");
        }
        if (!options.cwd.startsWith("/"))
        {
            throw new CodexProviderError("Remote process cwd must be an absolute POSIX path.");
        }
        await this.connect();
        const processHandle = createProcessHandle();
        const session = new ProcessSession(processHandle, this.requireClient(), this.settings.requestTimeoutMs);
        this.sessions.set(processHandle, session);
        try
        {
            const params: ProcessSpawnParams = stripUndefined({
                command: options.command,
                processHandle,
                cwd: options.cwd,
                tty: true,
                streamStdin: true,
                streamStdoutStderr: true,
                outputBytesCap: null,
                timeoutMs: null,
                env: options.env
                    ? Object.fromEntries(
                        Object.entries(options.env).filter((entry): entry is [string, string | null] => entry[1] !== undefined),
                    )
                    : undefined,
                size: { cols: options.cols, rows: options.rows },
            });
            await this.requireClient().request("process/spawn", params, this.settings.requestTimeoutMs);
            return session;
        }
        catch (error)
        {
            this.sessions.delete(processHandle);
            session.connectionLost(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    async shutdown(): Promise<void>
    {
        this.shuttingDown = true;
        await Promise.all([...this.sessions.values()].map((session) => session.kill().catch(() => undefined)));
        this.sessions.clear();
        await this.disconnectCurrentClient();
        this.connected = false;
        this.connectPromise = undefined;
    }

    private async initializeConnection(): Promise<void>
    {
        const client = this.createClient();
        this.client = client;
        this.removeOutputListener = client.onNotification("process/outputDelta", (params) => this.routeOutput(params));
        this.removeExitListener = client.onNotification("process/exited", (params) => this.routeExit(params));
        this.removeTransportTerminationListener = client.onTransportTermination?.((error) =>
        {
            void this.handleTransportTermination(client, error);
        });
        try
        {
            await client.connect();
            await client.request<CodexInitializeResult>("initialize", initializeParams(this.settings), this.settings.requestTimeoutMs);
            await client.notification("initialized");
            this.connected = true;
        }
        catch (error)
        {
            await this.disconnectCurrentClient(client);
            this.connected = false;
            this.connectPromise = undefined;
            throw error;
        }
    }

    private routeOutput(params: unknown): void
    {
        const output = asOutputDelta(params);
        if (!output)
        {
            return;
        }
        this.sessions.get(output.processHandle)?.output(output);
    }

    private routeExit(params: unknown): void
    {
        const exited = asExited(params);
        if (!exited)
        {
            return;
        }
        const session = this.sessions.get(exited.processHandle);
        if (!session)
        {
            return;
        }
        this.sessions.delete(exited.processHandle);
        session.exited(exited);
    }

    private async handleTransportTermination(client: CodexCommandJsonRpcClientLike, error: Error): Promise<void>
    {
        if (this.client !== client)
        {
            return;
        }
        this.connected = false;
        this.connectPromise = undefined;
        this.client = undefined;
        for (const session of this.sessions.values())
        {
            session.connectionLost(error);
        }
        this.sessions.clear();
        await this.disconnectCurrentClient(client);
    }

    private requireClient(): CodexCommandJsonRpcClientLike
    {
        if (!this.client)
        {
            throw new CodexProviderError("Process session client is not connected.");
        }
        return this.client;
    }

    private async disconnectCurrentClient(client = this.client): Promise<void>
    {
        this.removeOutputListener?.();
        this.removeOutputListener = undefined;
        this.removeExitListener?.();
        this.removeExitListener = undefined;
        this.removeTransportTerminationListener?.();
        this.removeTransportTerminationListener = undefined;
        if (!client)
        {
            return;
        }
        if (this.client === client)
        {
            this.client = undefined;
        }
        await client.disconnect().catch(() => undefined);
    }
}

class ProcessSession implements CodexProcessSession
{
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(event: CodexProcessSessionExit) => void>();
    private readonly connectionLostListeners = new Set<(error: Error) => void>();
    private readonly stdoutDecoder = new StringDecoder("utf8");
    private readonly stderrDecoder = new StringDecoder("utf8");
    private pendingInput = "";
    private flushPromise: Promise<void> | undefined;
    private closed = false;

    constructor(
        readonly processHandle: string,
        private readonly client: CodexCommandJsonRpcClientLike,
        private readonly requestTimeoutMs: number | undefined,
    ) {}

    write(data: string): Promise<void>
    {
        this.assertOpen();
        if (Buffer.byteLength(this.pendingInput) + Buffer.byteLength(data) > MAX_PENDING_INPUT_BYTES)
        {
            throw new CodexProviderError("Remote terminal input queue is full.");
        }
        this.pendingInput += data;
        this.flushPromise ??= Promise.resolve().then(async () =>
        {
            while (this.pendingInput.length > 0)
            {
                const pending = this.pendingInput;
                this.pendingInput = "";
                const params: ProcessWriteStdinParams = {
                    processHandle: this.processHandle,
                    deltaBase64: Buffer.from(pending).toString("base64"),
                };
                await this.client.request("process/writeStdin", params, this.requestTimeoutMs);
            }
        }).catch((error: unknown) =>
        {
            this.pendingInput = "";
            throw error;
        }).finally(() =>
        {
            this.flushPromise = undefined;
        });
        return this.flushPromise;
    }

    resize(cols: number, rows: number): Promise<void>
    {
        this.assertOpen();
        const params: ProcessResizePtyParams = {
            processHandle: this.processHandle,
            size: { cols, rows },
        };
        return this.client.request("process/resizePty", params, this.requestTimeoutMs).then(() => undefined);
    }

    kill(): Promise<void>
    {
        if (this.closed)
        {
            return Promise.resolve();
        }
        return this.client.request("process/kill", { processHandle: this.processHandle }, this.requestTimeoutMs).then(() => undefined);
    }

    onData(listener: (data: string) => void): () => void
    {
        this.dataListeners.add(listener);
        return () => this.dataListeners.delete(listener);
    }

    onExit(listener: (event: CodexProcessSessionExit) => void): () => void
    {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }

    onConnectionLost(listener: (error: Error) => void): () => void
    {
        this.connectionLostListeners.add(listener);
        return () => this.connectionLostListeners.delete(listener);
    }

    output(notification: ProcessOutputDeltaNotification): void
    {
        if (this.closed)
        {
            return;
        }
        const decoder = notification.stream === "stderr" ? this.stderrDecoder : this.stdoutDecoder;
        const text = decoder.write(Buffer.from(notification.deltaBase64, "base64"));
        if (text)
        {
            this.emitData(text);
        }
    }

    exited(notification: ProcessExitedNotification): void
    {
        if (this.closed)
        {
            return;
        }
        this.closed = true;
        this.pendingInput = "";
        this.emitData(this.stdoutDecoder.end());
        this.emitData(this.stderrDecoder.end());
        this.emitData(notification.stdout);
        this.emitData(notification.stderr);
        for (const listener of this.exitListeners)
        {
            listener({ exitCode: notification.exitCode });
        }
    }

    connectionLost(error: Error): void
    {
        if (this.closed)
        {
            return;
        }
        this.closed = true;
        this.pendingInput = "";
        for (const listener of this.connectionLostListeners)
        {
            listener(error);
        }
    }

    private emitData(data: string): void
    {
        if (!data)
        {
            return;
        }
        for (const listener of this.dataListeners)
        {
            listener(data);
        }
    }

    private assertOpen(): void
    {
        if (this.closed)
        {
            throw new CodexProviderError("Remote terminal session is unavailable.");
        }
    }
}

export function createCodexProcessSessionClient(
    settings: CodexProcessSessionClientSettings = {},
): CodexProcessSessionClient
{
    return new CodexProcessSessionClient(settings);
}

function createDefaultClient(settings: CodexProcessSessionClientSettings): CodexCommandJsonRpcClientLike
{
    let transport: CodexTransport;
    if (settings.transportFactory)
    {
        transport = settings.transportFactory({} satisfies TransportContext);
    }
    else if (settings.transport?.type === "websocket")
    {
        transport = new WebSocketTransport(settings.transport.websocket);
    }
    else
    {
        transport = new StdioTransport(settings.transport?.stdio);
    }
    return new AppServerClient(transport, stripUndefined({ requestTimeoutMs: settings.requestTimeoutMs }));
}

function initializeParams(settings: CodexProcessSessionClientSettings): CodexInitializeParams
{
    return {
        clientInfo: settings.clientInfo ?? { name: PACKAGE_NAME, version: PACKAGE_VERSION },
        capabilities: { experimentalApi: settings.experimentalApi ?? true },
    };
}

function asOutputDelta(params: unknown): ProcessOutputDeltaNotification | undefined
{
    if (!params || typeof params !== "object")
    {
        return undefined;
    }
    const candidate = params as Partial<ProcessOutputDeltaNotification>;
    if (
        typeof candidate.processHandle !== "string"
        || (candidate.stream !== "stdout" && candidate.stream !== "stderr")
        || typeof candidate.deltaBase64 !== "string"
        || typeof candidate.capReached !== "boolean"
    )
    {
        return undefined;
    }
    return candidate as ProcessOutputDeltaNotification;
}

function asExited(params: unknown): ProcessExitedNotification | undefined
{
    if (!params || typeof params !== "object")
    {
        return undefined;
    }
    const candidate = params as Partial<ProcessExitedNotification>;
    if (
        typeof candidate.processHandle !== "string"
        || typeof candidate.exitCode !== "number"
        || typeof candidate.stdout !== "string"
        || typeof candidate.stderr !== "string"
    )
    {
        return undefined;
    }
    return {
        processHandle: candidate.processHandle,
        exitCode: candidate.exitCode,
        stdout: candidate.stdout,
        stderr: candidate.stderr,
        stdoutCapReached: candidate.stdoutCapReached === true,
        stderrCapReached: candidate.stderrCapReached === true,
    };
}

function createProcessHandle(): string
{
    const id = nextProcessHandle;
    nextProcessHandle += 1;
    return `dascowork-terminal-${Date.now().toString(36)}-${id.toString(36)}`;
}
