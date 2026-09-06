import type { TransportContext } from "../client-settings";
import {
    CodexAppServerConnectionBroker,
    type CodexAppServerConnectionDiagnostics,
} from "./connection-broker";
import type { CodexTransport } from "./transport";
import { PersistentTransport } from "./transport-persistent";

export interface CodexAppServerConnectionSettings {
    transportFactory: () => CodexTransport;
    idleTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    scheduleTimeout?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
    clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Owns one physical Codex app-server transport for a desktop host.
 *
 * Callers receive short-lived logical transports.  They multiplex a single
 * physical JSON-RPC connection, so history, catalog, control and chat requests
 * can safely progress concurrently against the same app-server state directory.
 */
export class CodexAppServerConnection
{
    private readonly broker: CodexAppServerConnectionBroker;
    private activeLeaseCount = 0;
    private readonly idleResolvers = new Set<() => void>();
    private readonly shutdownTimeoutMs: number;
    private readonly scheduleTimeout: (
        callback: () => void,
        timeoutMs: number,
    ) => ReturnType<typeof setTimeout>;
    private readonly clearScheduledTimeout: (timer: ReturnType<typeof setTimeout>) => void;
    private shutdownStarted = false;
    private shutdownPromise: Promise<void> | undefined;

    constructor(settings: CodexAppServerConnectionSettings)
    {
        this.broker = new CodexAppServerConnectionBroker({
            transportFactory: settings.transportFactory,
        });
        this.shutdownTimeoutMs = Math.max(0, settings.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
        this.scheduleTimeout = settings.scheduleTimeout ?? setTimeout;
        this.clearScheduledTimeout = settings.clearScheduledTimeout ?? clearTimeout;
    }

    createTransport(context: TransportContext = {}): PersistentTransport
    {
        return new PersistentTransport({
            broker: this.broker,
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.threadId ? { threadId: context.threadId } : {}),
            onLeaseRequested: () =>
            {
                if (this.shutdownStarted)
                {
                    throw new Error("Codex app-server connection is shutting down.");
                }
                this.activeLeaseCount += 1;
            },
            onLeaseReleased: () =>
            {
                this.activeLeaseCount -= 1;
                if (this.activeLeaseCount !== 0)
                {
                    return;
                }
                for (const resolve of this.idleResolvers)
                {
                    resolve();
                }
                this.idleResolvers.clear();
            },
        });
    }

    shutdown(): Promise<void>
    {
        if (!this.shutdownPromise)
        {
            this.shutdownStarted = true;
            this.shutdownPromise = this.waitForIdleOrDeadline().then(() => this.broker.shutdown());
        }
        return this.shutdownPromise;
    }

    getDiagnostics(): CodexAppServerConnectionDiagnostics
    {
        return {
            ...this.broker.getDiagnostics(),
            activeLeaseCount: this.activeLeaseCount,
        };
    }

    private waitForIdleOrDeadline(): Promise<void>
    {
        if (this.activeLeaseCount === 0)
        {
            return Promise.resolve();
        }
        return new Promise((resolve) =>
        {
            let settled = false;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const settle = (): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                this.idleResolvers.delete(settle);
                if (deadline !== undefined)
                {
                    this.clearScheduledTimeout(deadline);
                }
                resolve();
            };
            this.idleResolvers.add(settle);
            deadline = this.scheduleTimeout(settle, this.shutdownTimeoutMs);
        });
    }
}
