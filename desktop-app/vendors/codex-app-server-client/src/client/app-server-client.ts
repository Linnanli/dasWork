import { CodexProviderError } from "../errors";
import type {
    CodexToolCallRequestParams,
    CodexToolCallResult,
} from "../protocol/types";
import { stripUndefined } from "../utils/object";
import type {
    CodexTransport,
    JsonRpcErrorResponse,
    JsonRpcId,
    JsonRpcMessage,
    JsonRpcRequest,
    JsonRpcResponse,
} from "./transport";

export class JsonRpcError extends CodexProviderError 
{
    override readonly code: number;
    readonly data?: unknown;

    constructor(error: { code: number; message: string; data?: unknown }) 
    {
        super(error.message);
        this.name = "JsonRpcError";
        this.code = error.code;
        this.data = error.data;
    }
}

export interface AppServerClientSettings
{
    requestTimeoutMs?: number;
    onPacket?: (packet: {
        direction: "inbound" | "outbound";
        message: JsonRpcMessage;
    }) => void;
}

type NotificationHandler = (params: unknown) => void | Promise<void>;
type AnyNotificationHandler = (
    method: string,
    params: unknown,
) => void | Promise<void>;
type RequestHandler = (
    params: unknown,
    request: JsonRpcRequest,
) => unknown;
type ToolCallRequestHandler = (
    params: CodexToolCallRequestParams,
    request: JsonRpcRequest,
) => CodexToolCallResult | Promise<CodexToolCallResult>;
type TransportTerminationHandler = (error: CodexProviderError) => void;

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse 
{
    return (
        "id" in message &&
        message.id !== undefined &&
        ("result" in message || "error" in message) &&
        !("method" in message)
    );
}

function isRequestOrNotification(
    message: JsonRpcMessage,
): message is JsonRpcRequest | { method: string; params?: unknown } 
{
    return "method" in message && typeof message.method === "string";
}

export class AppServerClient 
{
    private readonly transport: CodexTransport;
    private readonly requestTimeoutMs: number;
    private readonly onPacket?: AppServerClientSettings["onPacket"];
    private nextId = 1;

    private readonly pendingRequests = new Map<
        JsonRpcId,
        {
            resolve: (value: unknown) => void;
            reject: (reason?: unknown) => void;
            timer: NodeJS.Timeout;
        }
    >();

    private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
    private readonly anyNotificationHandlers = new Set<AnyNotificationHandler>();
    private readonly requestHandlers = new Map<string, RequestHandler>();
    private readonly inFlightInboundRequestIds = new Set<JsonRpcId>();
    private readonly transportTerminationHandlers = new Set<TransportTerminationHandler>();
    private readonly pendingRequestDrainWaiters = new Set<() => void>();
    /**
     * App-server notifications form an ordered state stream. The stdio
     * transport may deliver several lines in one tick, while notification
     * handlers can await main-process persistence or UI work. Keep those
     * handlers ordered so item deltas never overtake their item/start event.
     * Responses and server requests intentionally bypass this queue.
     */
    private notificationDispatch = Promise.resolve();

    private removeMessageListener: (() => void) | null = null;
    private removeErrorListener: (() => void) | null = null;
    private removeCloseListener: (() => void) | null = null;
    private transportTerminated = false;

    constructor(transport: CodexTransport, settings: AppServerClientSettings = {}) 
    {
        this.transport = transport;
        this.requestTimeoutMs = settings.requestTimeoutMs ?? 30_000;
        this.onPacket = settings.onPacket;
    }

    async connect(): Promise<void> 
    {
        await this.transport.connect();

        this.removeMessageListener = this.transport.on("message", (message) => 
        {
            void this.handleMessage(message).catch(() => 
            {
                // Inbound requests can race with disconnect; ignore transport write failures.
            });
        });

        this.removeErrorListener = this.transport.on("error", (error) =>
        {
            this.handleTransportTermination(error);
        });

        this.removeCloseListener = this.transport.on("close", (code, signal) =>
        {
            const detail = code === null
                ? signal === null
                    ? ""
                    : ` (signal ${signal})`
                : ` (code ${code})`;
            this.handleTransportTermination(
                new CodexProviderError(`App Server transport closed unexpectedly${detail}.`, {
                    code: "app_server_transport_closed",
                }),
            );
        });
    }

    async disconnect(): Promise<void> 
    {
        if (this.removeMessageListener) 
        {
            this.removeMessageListener();
            this.removeMessageListener = null;
        }

        if (this.removeErrorListener) 
        {
            this.removeErrorListener();
            this.removeErrorListener = null;
        }

        if (this.removeCloseListener)
        {
            this.removeCloseListener();
            this.removeCloseListener = null;
        }

        const pendingRequestIds = [...this.pendingRequests.keys()];
        for (const pending of this.pendingRequests.values()) 
        {
            clearTimeout(pending.timer);
            pending.reject(new CodexProviderError("Client disconnected."));
        }
        this.pendingRequests.clear();
        this.inFlightInboundRequestIds.clear();
        this.resolvePendingRequestDrainWaiters();

        for (const id of pendingRequestIds)
        {
            this.transport.cancelRequest?.(id);
        }

        await this.transport.disconnect();
    }

    async request<TResult>(
        method: string,
        params?: unknown,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<TResult> 
    {
        const id = this.nextId++;

        const message: JsonRpcRequest =
            params === undefined ? { id, method } : { id, method, params };

        const promise = new Promise<TResult>((resolve, reject) => 
        {
            const timer = setTimeout(() => 
            {
                this.pendingRequests.delete(id);
                this.resolvePendingRequestDrainWaiters();
                this.transport.cancelRequest?.(id);
                reject(new CodexProviderError(`Request timed out: ${method}`));
            }, timeoutMs);

            this.pendingRequests.set(id, {
                resolve: (value) => resolve(value as TResult),
                reject,
                timer,
            });
        });

        this.onPacket?.({ direction: "outbound", message });
        try
        {
            await this.transport.sendMessage(message);
        }
        catch (error)
        {
            const pending = this.pendingRequests.get(id);
            if (pending)
            {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(id);
                this.resolvePendingRequestDrainWaiters();
                this.transport.cancelRequest?.(id);
                pending.reject(error);
                await promise.catch(() => undefined);
            }
            throw error;
        }
        return promise;
    }

    async notification(method: string, params?: unknown): Promise<void> 
    {
        const message = stripUndefined({ method, params });
        this.onPacket?.({ direction: "outbound", message });
        await this.transport.sendNotification(method, params);
    }

    onNotification(method: string, handler: NotificationHandler): () => void 
    {
        const handlers = this.notificationHandlers.get(method) ?? new Set();
        handlers.add(handler);
        this.notificationHandlers.set(method, handlers);

        return () => 
        {
            handlers.delete(handler);
            if (handlers.size === 0) 
            {
                this.notificationHandlers.delete(method);
            }
        };
    }

    onAnyNotification(handler: AnyNotificationHandler): () => void 
    {
        this.anyNotificationHandlers.add(handler);
        return () => 
        {
            this.anyNotificationHandlers.delete(handler);
        };
    }

    onRequest(method: string, handler: RequestHandler): () => void 
    {
        this.requestHandlers.set(method, handler);

        return () => 
        {
            this.requestHandlers.delete(method);
        };
    }

    onToolCallRequest(handler: ToolCallRequestHandler): () => void 
    {
        return this.onRequest("item/tool/call", async (params, request) =>
            handler((params ?? {}), request),
        );
    }

    /**
     * Receives the first unexpected transport error or close for this client.
     * Explicit disconnect removes the underlying listeners before closing, so it
     * never calls these handlers.
     */
    onTransportTermination(handler: TransportTerminationHandler): () => void
    {
        this.transportTerminationHandlers.add(handler);
        return () =>
        {
            this.transportTerminationHandlers.delete(handler);
        };
    }

    /**
     * Waits briefly for in-flight client RPCs before a successful stream
     * teardown.  A terminal lifecycle notification may race a turn/steer
     * response, but a non-responsive peer must not pin a logical channel
     * forever.
     */
    waitForPendingRequests(timeoutMs = this.requestTimeoutMs): Promise<boolean>
    {
        if (this.pendingRequests.size === 0)
        {
            return Promise.resolve(true);
        }

        if (timeoutMs <= 0)
        {
            return Promise.resolve(false);
        }

        return new Promise((resolve) =>
        {
            let settled = false;
            let timer: ReturnType<typeof setTimeout>;
            let onDrained: () => void;
            const finish = (drained: boolean): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                this.pendingRequestDrainWaiters.delete(onDrained);
                resolve(drained);
            };
            onDrained = (): void => finish(true);
            timer = setTimeout(() => finish(false), timeoutMs);
            this.pendingRequestDrainWaiters.add(onDrained);
        });
    }

    /** Feeds an externally buffered message through the normal dispatch path (e.g. replay after a cross-call gap). */
    dispatchMessage(message: JsonRpcMessage): Promise<void>
    {
        return this.handleMessage(message);
    }

    private async handleMessage(message: JsonRpcMessage): Promise<void>
    {
        this.onPacket?.({ direction: "inbound", message });

        if (isResponse(message)) 
        {
            this.handleResponse(message);
            return;
        }

        if (!isRequestOrNotification(message)) 
        {
            return;
        }

        const hasRequestId = "id" in message && message.id !== undefined;

        if (hasRequestId) 
        {
            await this.handleInboundRequest(message);
            return;
        }

        await this.enqueueNotification(message.method, message.params);
    }

    private handleTransportTermination(cause: unknown): void
    {
        if (this.transportTerminated)
        {
            return;
        }
        this.transportTerminated = true;

        const error = cause instanceof CodexProviderError && typeof cause.code === "string"
            ? cause
            : new CodexProviderError("App Server transport terminated unexpectedly.", {
                cause,
                code: "app_server_transport_terminated",
            });

        for (const pending of this.pendingRequests.values())
        {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();
        this.inFlightInboundRequestIds.clear();
        this.resolvePendingRequestDrainWaiters();

        for (const handler of this.transportTerminationHandlers)
        {
            try
            {
                handler(error);
            }
            catch
            {
                // A consumer callback must not destabilize transport shutdown.
            }
        }
    }

    private handleResponse(message: JsonRpcResponse): void 
    {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) 
        {
            return;
        }

        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        this.resolvePendingRequestDrainWaiters();

        if ("error" in message) 
        {
            pending.reject(new JsonRpcError(message.error));
            return;
        }

        pending.resolve((message).result);
    }

    private async handleNotification(method: string, params: unknown): Promise<void>
    {
        const handlers = this.notificationHandlers.get(method);
        if (handlers) 
        {
            for (const handler of handlers) 
            {
                const result = handler(params);
                if (isPromiseLike(result))
                {
                    await result;
                }
            }
        }

        for (const handler of this.anyNotificationHandlers)
        {
            const result = handler(method, params);
            if (isPromiseLike(result))
            {
                await result;
            }
        }
    }

    private enqueueNotification(method: string, params: unknown): Promise<void>
    {
        const dispatch = this.notificationDispatch.then(() => this.handleNotification(method, params));
        // Keep later wire notifications dispatchable after a consumer handler
        // fails. The current message still reports that failure to explicit
        // callers of dispatchMessage().
        this.notificationDispatch = dispatch.catch(() => undefined);
        return dispatch;
    }

    private resolvePendingRequestDrainWaiters(): void
    {
        if (this.pendingRequests.size !== 0) {return;}
        for (const resolve of this.pendingRequestDrainWaiters)
        {
            resolve();
        }
        this.pendingRequestDrainWaiters.clear();
    }

    private async handleInboundRequest(request: JsonRpcRequest): Promise<void> 
    {
        // An app-server retry of an outstanding JSON-RPC request has the same
        // request id.  Its original handler may deliberately remain pending
        // across a cross-call step, so invoking it again would create a second
        // UI tool call and overwrite the parked continuation.
        if (this.inFlightInboundRequestIds.has(request.id))
        {
            return;
        }
        const handler = this.requestHandlers.get(request.method);

        if (!handler) 
        {
            const notFoundResponse = {
                id: request.id,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`,
                },
            } as JsonRpcErrorResponse;
            this.onPacket?.({ direction: "outbound", message: notFoundResponse });
            await this.transport.sendMessage(notFoundResponse);
            return;
        }

        this.inFlightInboundRequestIds.add(request.id);
        try 
        {
            const result = await handler(request.params, request);
            const response = {
                id: request.id,
                result,
            };
            this.onPacket?.({ direction: "outbound", message: response });
            await this.transport.sendMessage(response);
        }
        catch (error) 
        {
            try 
            {
                const errorResponse = {
                    id: request.id,
                    error: {
                        code: -32000,
                        message: error instanceof Error ? error.message : "Request handler failed",
                    },
                } as JsonRpcErrorResponse;
                this.onPacket?.({ direction: "outbound", message: errorResponse });
                await this.transport.sendMessage(errorResponse);
            }
            catch 
            {
                // Ignore transport errors while replying to inbound requests during shutdown.
            }
        }
        finally
        {
            this.inFlightInboundRequestIds.delete(request.id);
        }
    }
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void>
{
    return typeof value === "object" && value !== null && typeof value.then === "function";
}
