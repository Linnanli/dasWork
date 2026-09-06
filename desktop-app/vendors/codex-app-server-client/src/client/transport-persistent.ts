import type { CodexToolCallResult } from "../protocol/types";
import { stripUndefined } from "../utils/object";
import type {
    BrokerLogicalChannel,
    CodexAppServerConnectionBroker,
} from "./connection-broker";
import type {
    CodexTransport,
    CodexTransportEventMap,
    JsonRpcMessage,
} from "./transport";
import type { PendingToolCall } from "./worker";
import type { CodexWorker } from "./worker";
import type { CodexWorkerPool } from "./worker-pool";

export interface PersistentTransportSettings
{
    /** Legacy per-provider worker pool. Shared desktop hosts use `broker`. */
    pool?: CodexWorkerPool;
    /** Host-scoped physical connection; each PersistentTransport is a logical channel. */
    broker?: CodexAppServerConnectionBroker;
    signal?: AbortSignal;
    threadId?: string;
    onLeaseRequested?: () => void;
    onLeaseReleased?: () => void;
}

let nextLogicalChannelId = 1;

export class PersistentTransport implements CodexTransport, BrokerLogicalChannel
{
    readonly channelId = `channel-${nextLogicalChannelId++}`;
    private readonly pool: CodexWorkerPool | undefined;
    private readonly broker: CodexAppServerConnectionBroker | undefined;
    private readonly signal: AbortSignal | undefined;
    private readonly configuredThreadId: string | undefined;
    private boundThreadId: string | undefined;
    private readonly onLeaseRequested: (() => void) | undefined;
    private readonly onLeaseReleased: (() => void) | undefined;
    private worker: CodexWorker | null = null;
    private leaseActive = false;
    private brokerConnected = false;
    private pendingInitializeId: string | number | null = null;
    private initializeIntercepted = false;

    private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
    private readonly errorListeners = new Set<(error: unknown) => void>();
    private readonly closeListeners = new Set<
        (code: number | null, signal: NodeJS.Signals | null) => void
    >();

    constructor(settings: PersistentTransportSettings)
    {
        this.pool = settings.pool;
        this.broker = settings.broker;
        if (!this.pool && !this.broker)
        {
            throw new Error("PersistentTransport requires a worker pool or connection broker.");
        }
        if (this.pool && this.broker)
        {
            throw new Error("PersistentTransport cannot use a worker pool and connection broker together.");
        }
        this.signal = settings.signal;
        this.configuredThreadId = settings.threadId;
        this.boundThreadId = settings.threadId;
        this.onLeaseRequested = settings.onLeaseRequested;
        this.onLeaseReleased = settings.onLeaseReleased;
    }

    async connect(): Promise<void>
    {
        if (this.broker)
        {
            if (this.brokerConnected)
            {
                return;
            }
            this.onLeaseRequested?.();
            this.leaseActive = true;
            try
            {
                await this.broker.attach(this);
                this.brokerConnected = true;
            }
            catch (error)
            {
                this.releaseLease();
                throw error;
            }
            return;
        }

        this.onLeaseRequested?.();
        this.leaseActive = true;
        try
        {
            this.worker = await this.pool!.acquire(
                stripUndefined({ signal: this.signal, threadId: this.boundThreadId }),
            );
            await this.worker.ensureConnected();
        }
        catch (error)
        {
            await this.disconnect();
            throw error;
        }
    }

    disconnect(): Promise<void>
    {
        if (this.broker)
        {
            if (this.brokerConnected)
            {
                this.brokerConnected = false;
                this.broker.detach(this);
            }
            this.messageListeners.clear();
            this.errorListeners.clear();
            this.closeListeners.clear();
            this.releaseLease();
            return Promise.resolve();
        }

        if (this.worker)
        {
            const w = this.worker;
            this.worker = null;
            this.messageListeners.clear();
            this.errorListeners.clear();
            this.closeListeners.clear();
            this.pool!.release(w);
        }
        this.releaseLease();
        return Promise.resolve();
    }

    async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        if (this.broker)
        {
            await this.broker.sendMessage(this, message);
            return;
        }

        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (isInitializeRequest(message))
        {
            if (this.worker.initialized)
            {
                this.initializeIntercepted = true;
                const requestId = message.id;
                const cachedResult = this.worker.initializeResult;

                queueMicrotask(() =>
                {
                    for (const listener of this.messageListeners)
                    {
                        listener({ id: requestId, result: cachedResult });
                    }
                });
                return;
            }

            this.initializeIntercepted = false;
            this.pendingInitializeId = message.id;
        }

        await this.worker.sendMessage(message);
    }

    async sendNotification(method: string, params?: unknown): Promise<void>
    {
        if (this.broker)
        {
            await this.broker.sendNotification(this, method, params);
            return;
        }

        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (method === "initialized" && this.initializeIntercepted)
        {
            return;
        }

        await this.worker.sendNotification(method, params);
    }

    cancelRequest(id: string | number): void
    {
        this.broker?.cancelRequest(this, id);
    }

    on<K extends keyof CodexTransportEventMap>(
        event: K,
        listener: CodexTransportEventMap[K],
    ): () => void
    {
        if (this.broker)
        {
            if (event === "message")
            {
                const msgListener = listener as (message: JsonRpcMessage) => void;
                this.messageListeners.add(msgListener);
                return () => this.messageListeners.delete(msgListener);
            }
            if (event === "error")
            {
                const errListener = listener as (error: unknown) => void;
                this.errorListeners.add(errListener);
                return () => this.errorListeners.delete(errListener);
            }
            const closeListener = listener as (
                code: number | null,
                signal: NodeJS.Signals | null,
            ) => void;
            this.closeListeners.add(closeListener);
            return () => this.closeListeners.delete(closeListener);
        }

        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (event === "message")
        {
            const msgListener = listener as (message: JsonRpcMessage) => void;

            const wrappedListener = ((incoming: JsonRpcMessage) =>
            {
                if (
                    this.pendingInitializeId !== null &&
                    "id" in incoming &&
                    incoming.id === this.pendingInitializeId &&
                    "result" in incoming
                )
                {
                    this.worker?.markInitialized(incoming.result);
                    this.pendingInitializeId = null;
                }
                msgListener(incoming);
            }) as CodexTransportEventMap[K];

            const workerUnsub = this.worker.onSession(event, wrappedListener);
            this.messageListeners.add(msgListener);

            return () =>
            {
                workerUnsub();
                this.messageListeners.delete(msgListener);
            };
        }

        if (event === "error")
        {
            const errListener = listener as (error: unknown) => void;
            const workerUnsub = this.worker.onSession(event, listener);
            this.errorListeners.add(errListener);

            return () =>
            {
                workerUnsub();
                this.errorListeners.delete(errListener);
            };
        }

        if (event === "close")
        {
            const closeListener = listener as (
                code: number | null,
                signal: NodeJS.Signals | null,
            ) => void;
            const workerUnsub = this.worker.onSession(event, listener);
            this.closeListeners.add(closeListener);

            return () =>
            {
                workerUnsub();
                this.closeListeners.delete(closeListener);
            };
        }

        return this.worker.onSession(event, listener);
    }

    getPendingToolCall(): PendingToolCall | null
    {
        if (this.broker)
        {
            return this.broker.getPendingToolCall(this);
        }
        return this.worker?.pendingToolCall ?? null;
    }

    /** Returns and clears messages buffered on the worker while the tool call was parked between steps. */
    drainBufferedMessages(): JsonRpcMessage[]
    {
        if (this.broker)
        {
            return this.broker.drainBufferedMessages(this);
        }
        return this.worker?.drainBufferedMessages() ?? [];
    }

    async respondToToolCall(result: CodexToolCallResult): Promise<void>
    {
        if (this.broker)
        {
            await this.broker.respondToToolCall(this, result);
            return;
        }

        if (!this.worker?.pendingToolCall)
        {
            throw new Error("No pending tool call to respond to.");
        }

        const { requestId } = this.worker.pendingToolCall;
        this.worker.pendingToolCall = null;

        await this.worker.sendMessage({
            id: requestId,
            result,
        });
    }

    parkToolCall(pending: PendingToolCall): boolean
    {
        if (this.broker)
        {
            return this.broker.parkToolCall(this, pending);
        }

        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }
        const existing = this.worker.pendingToolCall;
        if (existing)
        {
            if (existing.requestId === pending.requestId || existing.callId === pending.callId)
            {
                return false;
            }
            throw new Error(`Thread ${pending.threadId} already has a pending cross-call tool request.`);
        }
        this.worker.pendingToolCall = pending;
        return true;
    }

    get threadId(): string | undefined
    {
        return this.boundThreadId;
    }

    bindThread(threadId: string): void
    {
        this.boundThreadId = threadId;
    }

    receiveMessage(message: JsonRpcMessage): void
    {
        for (const listener of this.messageListeners)
        {
            listener(message);
        }
    }

    receiveError(error: unknown): void
    {
        // A fatal physical failure invalidates this logical channel as well.
        // Release its host lease here so application shutdown never waits for a
        // caller to observe the propagated client error and disconnect later.
        if (this.broker && this.brokerConnected)
        {
            this.brokerConnected = false;
            this.broker.detach(this);
            this.releaseLease();
        }
        for (const listener of this.errorListeners)
        {
            listener(error);
        }
    }

    receiveClose(code: number | null, signal: NodeJS.Signals | null): void
    {
        for (const listener of this.closeListeners)
        {
            listener(code, signal);
        }
    }

    private releaseLease(): void
    {
        if (!this.leaseActive)
        {
            return;
        }
        this.leaseActive = false;
        this.onLeaseReleased?.();
    }
}

function isInitializeRequest(
    message: JsonRpcMessage,
): message is { id: string | number; method: "initialize"; params?: unknown }
{
    return "id" in message && "method" in message && message.method === "initialize";
}
