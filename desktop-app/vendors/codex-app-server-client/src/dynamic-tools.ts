import type { AppServerClient } from "./client/app-server-client";
import { CodexProviderError } from "./errors";
import type { JsonValue } from "./protocol/app-server-protocol/serde_json/JsonValue";
import type { DynamicToolSpec } from "./protocol/app-server-protocol/v2/DynamicToolSpec";
import type {
    CodexToolCallRequestParams,
    CodexToolCallResult,
    CodexToolResultContentItem,
} from "./protocol/types";
import { stripUndefined } from "./utils/object";

export interface DynamicToolExecutionContext
{
    threadId?: string;
    turnId?: string;
    callId?: string;
    namespace?: string | null;
    toolName: string;
    signal?: AbortSignal;
}

export type DynamicToolHandler = (
    args: unknown,
    context: DynamicToolExecutionContext,
) => Promise<CodexToolCallResult>;

/** Full tool definition: schema advertised to Codex + local execution handler. */
export interface DynamicToolDefinition
{
    description: string;
    inputSchema: Record<string, unknown>;
    deferLoading?: boolean;
    namespaceDescription?: string;
    execute: DynamicToolHandler;
}

export interface DynamicToolRegistrationOptions
{
    namespace?: string | null;
}

export interface DynamicToolDispatchOptions
{
    signal?: AbortSignal;
}

export interface DynamicToolSnapshotEntry
{
    namespace: string | null;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    deferLoading?: boolean;
    namespaceDescription?: string;
}

export interface DynamicToolsDispatcherSettings
{
    /** Tools with full schema advertised to Codex. Handlers are registered automatically. */
    tools?: Record<string, DynamicToolDefinition>;
    /** Legacy handler-only registration (no schema). Tools are not advertised to Codex. */
    handlers?: Record<string, DynamicToolHandler>;
    timeoutMs?: number;
    onDebugEvent?: (event: {
        event: string;
        data?: unknown;
    }) => void;
}

function toTextResult(message: string, success: boolean): CodexToolCallResult 
{
    const contentItems: CodexToolResultContentItem[] = [{ type: "inputText", text: message }];
    return { success, contentItems };
}

function dynamicToolKey(namespace: string | null | undefined, name: string): string
{
    return `${namespace ?? ""}\u0000${name}`;
}

function hasOwnProperty(value: object, property: string): boolean
{
    return Object.prototype.hasOwnProperty.call(value, property);
}

function abortMessage(signal: AbortSignal): string
{
    const reason: unknown = signal.reason;

    if (reason instanceof Error)
    {
        return reason.message;
    }

    if (typeof reason === "string" && reason.length > 0)
    {
        return reason;
    }

    return "Dynamic tool execution was aborted.";
}

function paramsSignal(params: CodexToolCallRequestParams): AbortSignal | undefined
{
    const signal = (params as { signal?: unknown }).signal;
    return signal instanceof AbortSignal ? signal : undefined;
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
    externalSignal?: AbortSignal,
): Promise<T>
{
    return new Promise<T>((resolve, reject) =>
    {
        if (externalSignal?.aborted)
        {
            controller.abort(externalSignal.reason);
            reject(new CodexProviderError(abortMessage(externalSignal)));
            return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const onExternalAbort = (): void =>
        {
            controller.abort(externalSignal?.reason);
            rejectOnce(new CodexProviderError(abortMessage(controller.signal)));
        };

        const cleanup = (): void =>
        {
            if (timer)
            {
                clearTimeout(timer);
            }
            externalSignal?.removeEventListener("abort", onExternalAbort);
        };

        const resolveOnce = (value: T): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };

        const rejectOnce = (error: Error): void =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        timer = setTimeout(() =>
        {
            const error = new CodexProviderError(
                `Dynamic tool execution timed out after ${timeoutMs}ms.`,
            );
            controller.abort(error);
            rejectOnce(error);
        }, timeoutMs);
        externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

        promise
            .then(resolveOnce)
            .catch((error) =>
            {
                rejectOnce(error instanceof Error ? error : new Error(String(error)));
            });
    });
}

interface DynamicToolRegistration
{
    namespace: string | null;
    name: string;
    handler: DynamicToolHandler;
    definition?: DynamicToolDefinition | undefined;
}

export class DynamicToolsDispatcher 
{
    private readonly registrations = new Map<string, DynamicToolRegistration>();
    private readonly timeoutMs: number;
    private readonly onDebugEvent?: DynamicToolsDispatcherSettings["onDebugEvent"];

    constructor(settings: DynamicToolsDispatcherSettings = {})
    {
        this.timeoutMs = settings.timeoutMs ?? 30_000;
        this.onDebugEvent = settings.onDebugEvent;

        if (settings.tools)
        {
            for (const [name, def] of Object.entries(settings.tools))
            {
                this.registerTool(name, def, { namespace: null });
                this.onDebugEvent?.({
                    event: "dynamic-tool-registered",
                    data: { name, source: "tools" },
                });
            }
        }

        if (settings.handlers)
        {
            for (const [name, handler] of Object.entries(settings.handlers))
            {
                this.register(name, handler);
                this.onDebugEvent?.({
                    event: "dynamic-tool-registered",
                    data: { name, source: "handlers" },
                });
            }
        }
    }

    register(
        name: string,
        handler: DynamicToolHandler,
        options: DynamicToolRegistrationOptions = {},
    ): void
    {
        this.registerInternal(name, handler, options);
    }

    registerTool(
        name: string,
        definition: DynamicToolDefinition,
        options: DynamicToolRegistrationOptions = {},
    ): void
    {
        this.registerInternal(name, definition.execute, options, definition);
    }

    unregister(name: string, options: DynamicToolRegistrationOptions = {}): boolean
    {
        return this.registrations.delete(dynamicToolKey(options.namespace, name));
    }

    snapshot(): DynamicToolSnapshotEntry[]
    {
        return Array.from(this.registrations.values()).map((registration) => stripUndefined({
            namespace: registration.namespace,
            name: registration.name,
            description: registration.definition?.description,
            inputSchema: registration.definition?.inputSchema,
            deferLoading: registration.definition?.deferLoading,
            namespaceDescription: registration.definition?.namespaceDescription,
        }));
    }

    snapshotDynamicToolSpecs(): DynamicToolSpec[]
    {
        const rootTools: DynamicToolSpec[] = [];
        const namespacedTools = new Map<
            string,
            {
                description: string;
                tools: Extract<DynamicToolSpec, { type: "namespace" }>["tools"];
            }
        >();

        for (const registration of this.registrations.values())
        {
            if (!registration.definition)
            {
                continue;
            }

            const toolSpec: Extract<DynamicToolSpec, { type: "function" }> = {
                type: "function" as const,
                name: registration.name,
                description: registration.definition.description,
                inputSchema: registration.definition.inputSchema as JsonValue,
            };

            if (registration.definition.deferLoading !== undefined)
            {
                toolSpec.deferLoading = registration.definition.deferLoading;
            }

            if (registration.namespace === null)
            {
                rootTools.push(toolSpec);
                continue;
            }

            const group = namespacedTools.get(registration.namespace) ?? {
                description:
                    registration.definition.namespaceDescription ??
                    `${registration.namespace} dynamic tools`,
                tools: [],
            };
            group.tools.push(toolSpec);
            namespacedTools.set(registration.namespace, group);
        }

        for (const [name, group] of namespacedTools)
        {
            rootTools.push({
                type: "namespace",
                name,
                description: group.description,
                tools: group.tools,
            });
        }

        return rootTools;
    }

    attach(client: AppServerClient): () => void 
    {
        return client.onToolCallRequest(async (params) => this.dispatch(params));
    }

    async dispatch(
        params: CodexToolCallRequestParams,
        options: DynamicToolDispatchOptions = {},
    ): Promise<CodexToolCallResult>
    {
        const toolName = params.tool ?? params.toolName;

        if (!toolName) 
        {
            this.onDebugEvent?.({
                event: "dynamic-tool-missing-name",
                data: {
                    callId: params.callId,
                    threadId: params.threadId,
                    turnId: params.turnId,
                },
            });
            return toTextResult("Dynamic tool call is missing the tool name.", false);
        }

        const namespace = params.namespace ?? null;
        const args = hasOwnProperty(params, "arguments") ? params.arguments : params.input;

        const registration = this.registrations.get(dynamicToolKey(namespace, toolName));

        if (!registration)
        {
            this.onDebugEvent?.({
                event: "dynamic-tool-missing-handler",
                data: {
                    namespace,
                    toolName,
                    callId: params.callId,
                    threadId: params.threadId,
                    turnId: params.turnId,
                },
            });
            return toTextResult(`No dynamic tool handler registered for "${toolName}".`, false);
        }

        const controller = new AbortController();
        const context: DynamicToolExecutionContext = stripUndefined({
            toolName,
            namespace,
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
            signal: controller.signal,
        });

        const startedAt = Date.now();

        this.onDebugEvent?.({
            event: "dynamic-tool-dispatch-start",
            data: {
                namespace,
                toolName,
                callId: params.callId,
                threadId: params.threadId,
                turnId: params.turnId,
                hasArguments: args !== undefined,
            },
        });

        try 
        {
            const externalSignal = options.signal ?? paramsSignal(params);

            if (externalSignal?.aborted)
            {
                throw new CodexProviderError(abortMessage(externalSignal));
            }

            const result = await withTimeout(
                registration.handler(args, context),
                this.timeoutMs,
                controller,
                externalSignal,
            );

            this.onDebugEvent?.({
                event: "dynamic-tool-dispatch-success",
                data: {
                    namespace,
                    toolName,
                    callId: params.callId,
                    durationMs: Date.now() - startedAt,
                    success: result.success,
                    contentItemsCount: result.contentItems.length,
                },
            });

            return result;
        }
        catch (error) 
        {
            const message = error instanceof Error ? error.message : "Dynamic tool execution failed.";

            this.onDebugEvent?.({
                event: "dynamic-tool-dispatch-error",
                data: {
                    namespace,
                    toolName,
                    callId: params.callId,
                    durationMs: Date.now() - startedAt,
                    message,
                },
            });

            const result = toTextResult(message, false);
            return result;
        }
    }

    private registerInternal(
        name: string,
        handler: DynamicToolHandler,
        options: DynamicToolRegistrationOptions,
        definition?: DynamicToolDefinition,
    ): void
    {
        const namespace = options.namespace ?? null;
        const key = dynamicToolKey(namespace, name);

        if (this.registrations.has(key))
        {
            throw new CodexProviderError(
                namespace === null
                    ? `Dynamic tool "${name}" is already registered.`
                    : `Dynamic tool "${namespace}.${name}" is already registered.`,
            );
        }

        this.registrations.set(key, { namespace, name, handler, definition });
    }
}
