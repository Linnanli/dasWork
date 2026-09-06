import { CodexProviderError } from "../errors";
import type { CodexToolCallResult } from "../protocol/types";
import type {
    CodexTransport,
    JsonRpcId,
    JsonRpcMessage,
    JsonRpcRequest,
    JsonRpcResponse,
} from "./transport";
import type { PendingToolCall } from "./worker";

export interface BrokerLogicalChannel
{
    readonly channelId: string;
    readonly threadId: string | undefined;
    receiveMessage(message: JsonRpcMessage): void;
    receiveError(error: unknown): void;
    receiveClose(code: number | null, signal: NodeJS.Signals | null): void;
    bindThread(threadId: string): void;
}

type PendingRequest = {
    channel: BrokerLogicalChannel;
    localId: JsonRpcId;
    method: string;
    target: RequestTarget;
};

type InitializeWaiter = {
    channel: BrokerLogicalChannel;
    localId: JsonRpcId;
};

type PendingContinuation = {
    pending: PendingToolCall;
    bufferedMessages: JsonRpcMessage[];
};

type RequestTarget = {
    threadId?: string;
    turnId?: string;
};

/**
 * Sanitized host-connection counters for diagnostics and test assertions.
 * They deliberately exclude JSON-RPC payloads, request identifiers, and
 * thread identifiers.
 */
export type CodexAppServerConnectionDiagnostics = {
    generation: number;
    physicalConnectionActive: boolean;
    logicalChannelCount: number;
    pendingRequestCount: number;
    threadOwnerCount: number;
    turnOwnerCount: number;
    continuationCount: number;
    activeLeaseCount: number;
};

type InitializeRequest = JsonRpcRequest & { method: "initialize" };

const NO_OWNER_ERROR = {
    code: -32001,
    message: "No active logical channel owns this app-server request.",
};

/**
 * One physical JSON-RPC connection shared by all desktop host consumers.
 *
 * AppServerClient deliberately owns local request ids.  This broker therefore
 * allocates a different wire id for every outbound request and restores the
 * local id only when delivering the response back to the originating channel.
 */
export class CodexAppServerConnectionBroker
{
    private readonly transportFactory: () => CodexTransport;
    private transport: CodexTransport | null = null;
    private connectPromise: Promise<void> | null = null;
    private readonly channels = new Set<BrokerLogicalChannel>();
    private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
    private readonly initializeWaiters: InitializeWaiter[] = [];
    private readonly channelThreadIds = new Map<BrokerLogicalChannel, string>();
    private readonly threadOwners = new Map<string, BrokerLogicalChannel>();
    private readonly turnOwners = new Map<string, BrokerLogicalChannel>();
    private readonly continuations = new Map<string, PendingContinuation>();
    private nextWireId = 1;
    private initializeState: "idle" | "pending" | "initialized" = "idle";
    private initializeResult: unknown;
    private initializeWireId: JsonRpcId | undefined;
    private initializedNotificationSent = false;
    private shutdownStarted = false;
    private terminated = false;
    private generation = 0;

    constructor(settings: { transportFactory: () => CodexTransport })
    {
        this.transportFactory = settings.transportFactory;
    }

    async attach(channel: BrokerLogicalChannel): Promise<void>
    {
        if (this.shutdownStarted)
        {
            throw new CodexProviderError("Codex app-server connection is shutting down.");
        }

        this.channels.add(channel);
        if (channel.threadId)
        {
            this.bindChannelThread(channel, channel.threadId);
        }

        try
        {
            await this.ensureConnected();
        }
        catch (error)
        {
            this.detach(channel);
            throw error;
        }
    }

    detach(channel: BrokerLogicalChannel): void
    {
        const ownedThreadId = this.threadIdFor(channel);
        this.channels.delete(channel);
        this.releasePendingRequests(channel);
        this.releaseInitializeWaiters(channel);
        if (ownedThreadId)
        {
            this.continuations.delete(ownedThreadId);
        }
        this.channelThreadIds.delete(channel);
        this.removeOwnershipFor(channel);
    }

    cancelRequest(channel: BrokerLogicalChannel, localId: JsonRpcId): void
    {
        for (const [wireId, pending] of this.pendingRequests)
        {
            if (pending.channel === channel && pending.localId === localId)
            {
                this.pendingRequests.delete(wireId);
                return;
            }
        }
        const waiterIndex = this.initializeWaiters.findIndex(
            (waiter) => waiter.channel === channel && waiter.localId === localId,
        );
        if (waiterIndex >= 0)
        {
            this.initializeWaiters.splice(waiterIndex, 1);
        }
    }

    async sendMessage(channel: BrokerLogicalChannel, message: JsonRpcMessage): Promise<void>
    {
        this.assertAttached(channel);

        if (isInitializeRequest(message))
        {
            await this.sendInitialize(channel, message);
            return;
        }

        const transport = await this.connectedTransport();
        if (isRequest(message))
        {
            const wireId = this.allocateWireId();
            this.pendingRequests.set(wireId, {
                channel,
                localId: message.id,
                method: message.method,
                target: requestTarget(message.params),
            });
            try
            {
                await transport.sendMessage({ ...message, id: wireId });
            }
            catch (error)
            {
                this.pendingRequests.delete(wireId);
                throw error;
            }
            return;
        }

        // A response to a server request retains the app-server's wire id.
        await transport.sendMessage(message);
    }

    async sendNotification(
        channel: BrokerLogicalChannel,
        method: string,
        params?: unknown,
    ): Promise<void>
    {
        this.assertAttached(channel);
        if (method === "initialized")
        {
            if (this.initializedNotificationSent)
            {
                return;
            }
            this.initializedNotificationSent = true;
        }
        const transport = await this.connectedTransport();
        await transport.sendNotification(method, params);
    }

    bindChannelThread(channel: BrokerLogicalChannel, threadId: string): void
    {
        if (!threadId)
        {
            return;
        }
        channel.bindThread(threadId);
        this.channelThreadIds.set(channel, threadId);
        this.threadOwners.set(threadId, channel);
    }

    getPendingToolCall(channel: BrokerLogicalChannel): PendingToolCall | null
    {
        const threadId = this.threadIdFor(channel);
        return threadId ? this.continuations.get(threadId)?.pending ?? null : null;
    }

    drainBufferedMessages(channel: BrokerLogicalChannel): JsonRpcMessage[]
    {
        const threadId = this.threadIdFor(channel);
        if (!threadId)
        {
            return [];
        }
        const continuation = this.continuations.get(threadId);
        return continuation?.bufferedMessages.splice(0) ?? [];
    }

    parkToolCall(channel: BrokerLogicalChannel, pending: PendingToolCall): boolean
    {
        this.bindChannelThread(channel, pending.threadId);
        const existing = this.continuations.get(pending.threadId)?.pending;
        if (existing)
        {
            if (existing.requestId === pending.requestId || existing.callId === pending.callId)
            {
                return false;
            }
            throw new Error(`Thread ${pending.threadId} already has a pending cross-call tool request.`);
        }
        this.continuations.set(pending.threadId, {
            pending,
            bufferedMessages: [],
        });
        return true;
    }

    async respondToToolCall(
        channel: BrokerLogicalChannel,
        result: CodexToolCallResult,
    ): Promise<void>
    {
        const threadId = this.threadIdFor(channel);
        const continuation = threadId ? this.continuations.get(threadId) : undefined;
        if (!continuation)
        {
            throw new Error("No pending tool call to respond to.");
        }
        this.continuations.delete(continuation.pending.threadId);
        const transport = await this.connectedTransport();
        await transport.sendMessage({ id: continuation.pending.requestId, result });
    }

    async shutdown(): Promise<void>
    {
        this.shutdownStarted = true;
        const transport = this.transport;
        const channels = [...this.channels];
        this.resetPhysicalState();
        const shutdownError = new CodexProviderError("Codex app-server connection is shutting down.");
        for (const channel of channels)
        {
            channel.receiveError(shutdownError);
            channel.receiveClose(null, null);
        }
        if (transport)
        {
            await transport.disconnect().catch(() => undefined);
        }
    }

    getGeneration(): number
    {
        return this.generation;
    }

    getDiagnostics(): CodexAppServerConnectionDiagnostics
    {
        return {
            generation: this.generation,
            physicalConnectionActive: this.transport !== null,
            logicalChannelCount: this.channels.size,
            pendingRequestCount: this.pendingRequests.size + this.initializeWaiters.length,
            threadOwnerCount: this.threadOwners.size,
            turnOwnerCount: this.turnOwners.size,
            continuationCount: this.continuations.size,
            activeLeaseCount: 0,
        };
    }

    private async sendInitialize(
        channel: BrokerLogicalChannel,
        message: InitializeRequest,
    ): Promise<void>
    {
        if (this.initializeState === "initialized")
        {
            queueMicrotask(() => channel.receiveMessage({ id: message.id, result: this.initializeResult }));
            return;
        }

        this.initializeWaiters.push({ channel, localId: message.id });
        if (this.initializeState === "pending")
        {
            return;
        }

        this.initializeState = "pending";
        const transport = await this.connectedTransport();
        const wireId = this.allocateWireId();
        this.initializeWireId = wireId;
        try
        {
            await transport.sendMessage({ ...message, id: wireId });
        }
        catch (error)
        {
            this.failInitialize(error);
            throw error;
        }
    }

    private async ensureConnected(): Promise<void>
    {
        if (this.transport)
        {
            return;
        }
        if (this.connectPromise)
        {
            return this.connectPromise;
        }

        const transport = this.transportFactory();
        this.transport = transport;
        this.terminated = false;
        transport.on("message", (message) => this.handlePhysicalMessage(transport, message));
        transport.on("error", (error) => this.handlePhysicalTermination(transport, error));
        transport.on("close", (code, signal) =>
        {
            const suffix = code === null
                ? signal === null ? "" : ` (signal ${signal})`
                : ` (code ${code})`;
            this.handlePhysicalTermination(
                transport,
                new CodexProviderError(`App Server transport closed unexpectedly${suffix}.`, {
                    code: "app_server_transport_closed",
                }),
                code,
                signal,
            );
        });

        this.connectPromise = transport.connect()
            .catch((error) =>
            {
                this.handlePhysicalTermination(transport, error);
                throw error;
            })
            .finally(() =>
            {
                this.connectPromise = null;
            });
        return this.connectPromise;
    }

    private async connectedTransport(): Promise<CodexTransport>
    {
        await this.ensureConnected();
        if (!this.transport)
        {
            throw new CodexProviderError("App Server transport is unavailable.");
        }
        return this.transport;
    }

    private handlePhysicalMessage(transport: CodexTransport, message: JsonRpcMessage): void
    {
        if (transport !== this.transport)
        {
            return;
        }

        if (isResponse(message))
        {
            if (message.id === this.initializeWireId)
            {
                this.handleInitializeResponse(message);
                return;
            }

            const pending = this.pendingRequests.get(message.id);
            if (!pending)
            {
                return;
            }
            this.pendingRequests.delete(message.id);
            this.observeResponseBinding(pending, message);
            if (this.channels.has(pending.channel))
            {
                pending.channel.receiveMessage({ ...message, id: pending.localId });
            }
            return;
        }

        if (isServerRequest(message))
        {
            this.routeServerRequest(message);
            return;
        }

        if (isNotification(message))
        {
            this.observeNotificationBinding(message);
            this.fanOutNotification(message);
        }
    }

    private handleInitializeResponse(message: JsonRpcResponse): void
    {
        this.initializeWireId = undefined;
        if ("error" in message)
        {
            this.initializeState = "idle";
            for (const waiter of this.initializeWaiters.splice(0))
            {
                if (this.channels.has(waiter.channel))
                {
                    waiter.channel.receiveMessage({ id: waiter.localId, error: message.error });
                }
            }
            return;
        }

        this.initializeState = "initialized";
        this.initializeResult = message.result;
        for (const waiter of this.initializeWaiters.splice(0))
        {
            if (this.channels.has(waiter.channel))
            {
                waiter.channel.receiveMessage({ id: waiter.localId, result: message.result });
            }
        }
    }

    private failInitialize(error: unknown): void
    {
        this.initializeState = "idle";
        this.initializeWireId = undefined;
        for (const waiter of this.initializeWaiters.splice(0))
        {
            if (this.channels.has(waiter.channel))
            {
                waiter.channel.receiveError(error);
            }
        }
    }

    private routeServerRequest(request: JsonRpcRequest): void
    {
        const target = requestTarget(request.params);
        const owner = target.turnId && target.threadId
            ? this.turnOwners.get(turnOwnerKey(target.threadId, target.turnId))
            : undefined;
        const channel = owner ?? (target.threadId ? this.threadOwners.get(target.threadId) : undefined);
        if (channel && this.channels.has(channel))
        {
            channel.receiveMessage(request);
            return;
        }

        void this.transport?.sendMessage({ id: request.id, error: NO_OWNER_ERROR }).catch(() => undefined);
    }

    private fanOutNotification(message: Extract<JsonRpcMessage, { method: string }>): void
    {
        const target = requestTarget(message.params);
        const recipients = target.threadId
            ? [...this.channels].filter((channel) => this.threadIdFor(channel) === target.threadId)
            : [...this.channels];

        if (recipients.length > 0)
        {
            for (const channel of recipients)
            {
                channel.receiveMessage(message);
            }
            return;
        }

        if (target.threadId && this.continuations.has(target.threadId))
        {
            this.continuations.get(target.threadId)?.bufferedMessages.push(message);
        }
    }

    private observeResponseBinding(pending: PendingRequest, message: JsonRpcResponse): void
    {
        if ("error" in message)
        {
            return;
        }
        if (pending.method === "thread/start" || pending.method === "thread/resume")
        {
            const threadId = threadIdFromResult(message.result);
            if (threadId)
            {
                this.bindChannelThread(pending.channel, threadId);
            }
            return;
        }
        if (pending.method === "turn/start")
        {
            const threadId = pending.target.threadId ?? this.threadIdFor(pending.channel);
            const turnId = turnIdFromResult(message.result);
            if (threadId)
            {
                this.bindChannelThread(pending.channel, threadId);
                if (turnId)
                {
                    this.turnOwners.set(turnOwnerKey(threadId, turnId), pending.channel);
                }
            }
        }
    }

    private observeNotificationBinding(message: Extract<JsonRpcMessage, { method: string }>): void
    {
        if (message.method !== "turn/started")
        {
            return;
        }
        const target = requestTarget(message.params);
        if (!target.threadId || !target.turnId)
        {
            return;
        }
        const owner = this.threadOwners.get(target.threadId);
        if (owner)
        {
            this.turnOwners.set(turnOwnerKey(target.threadId, target.turnId), owner);
        }
    }

    private handlePhysicalTermination(
        transport: CodexTransport,
        cause: unknown,
        code: number | null = null,
        signal: NodeJS.Signals | null = null,
    ): void
    {
        if (transport !== this.transport || this.terminated)
        {
            return;
        }
        this.terminated = true;
        const error = cause instanceof CodexProviderError && typeof cause.code === "string"
            ? cause
            : new CodexProviderError("App Server transport terminated unexpectedly.", {
                cause,
                code: "app_server_transport_terminated",
            });
        const channels = [...this.channels];
        this.resetPhysicalState();
        for (const channel of channels)
        {
            channel.receiveError(error);
            channel.receiveClose(code, signal);
        }
    }

    private resetPhysicalState(): void
    {
        this.transport = null;
        this.connectPromise = null;
        this.pendingRequests.clear();
        this.initializeWaiters.splice(0);
        this.initializeState = "idle";
        this.initializeResult = undefined;
        this.initializeWireId = undefined;
        this.initializedNotificationSent = false;
        this.threadOwners.clear();
        this.turnOwners.clear();
        this.continuations.clear();
        this.generation += 1;
    }

    private releasePendingRequests(channel: BrokerLogicalChannel): void
    {
        for (const [wireId, pending] of this.pendingRequests)
        {
            if (pending.channel === channel)
            {
                this.pendingRequests.delete(wireId);
            }
        }
    }

    private releaseInitializeWaiters(channel: BrokerLogicalChannel): void
    {
        for (let index = this.initializeWaiters.length - 1; index >= 0; index -= 1)
        {
            if (this.initializeWaiters[index]?.channel === channel)
            {
                this.initializeWaiters.splice(index, 1);
            }
        }
    }

    private threadIdFor(channel: BrokerLogicalChannel): string | undefined
    {
        return this.channelThreadIds.get(channel) ?? channel.threadId;
    }

    private removeOwnershipFor(channel: BrokerLogicalChannel): void
    {
        for (const [threadId, owner] of this.threadOwners)
        {
            if (owner === channel)
            {
                this.threadOwners.delete(threadId);
            }
        }
        for (const [key, owner] of this.turnOwners)
        {
            if (owner === channel)
            {
                this.turnOwners.delete(key);
            }
        }
    }

    private assertAttached(channel: BrokerLogicalChannel): void
    {
        if (!this.channels.has(channel))
        {
            throw new Error("PersistentTransport is not connected.");
        }
    }

    private allocateWireId(): number
    {
        return this.nextWireId++;
    }
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest
{
    return "id" in message && "method" in message && typeof message.method === "string";
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcRequest
{
    return isRequest(message);
}

function isNotification(message: JsonRpcMessage): message is Extract<JsonRpcMessage, { method: string }>
{
    return "method" in message && !("id" in message);
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse
{
    return "id" in message && !("method" in message)
        && ("result" in message || "error" in message);
}

function isInitializeRequest(
    message: JsonRpcMessage,
): message is InitializeRequest
{
    return isRequest(message) && message.method === "initialize";
}

function requestTarget(value: unknown): RequestTarget
{
    if (!value || typeof value !== "object")
    {
        return {};
    }
    const record = value as Record<string, unknown>;
    const turn = record.turn;
    const turnId = typeof record.turnId === "string"
        ? record.turnId
        : turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
            ? (turn as Record<string, unknown>).id as string
            : undefined;
    const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
    return {
        ...(threadId ? { threadId } : {}),
        ...(turnId ? { turnId } : {}),
    };
}

function threadIdFromResult(result: unknown): string | undefined
{
    if (!result || typeof result !== "object")
    {
        return undefined;
    }
    const record = result as Record<string, unknown>;
    if (typeof record.threadId === "string")
    {
        return record.threadId;
    }
    const thread = record.thread;
    return thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string"
        ? (thread as Record<string, unknown>).id as string
        : undefined;
}

function turnIdFromResult(result: unknown): string | undefined
{
    if (!result || typeof result !== "object")
    {
        return undefined;
    }
    const record = result as Record<string, unknown>;
    if (typeof record.turnId === "string")
    {
        return record.turnId;
    }
    const turn = record.turn;
    return turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
        ? (turn as Record<string, unknown>).id as string
        : undefined;
}

function turnOwnerKey(threadId: string, turnId: string): string
{
    return `${threadId}\u0000${turnId}`;
}
