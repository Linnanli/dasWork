import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { Thread } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/Thread";

import { AppServerClient } from "./client/app-server-client";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type {
    CodexDynamicToolDefinition,
    CodexInitializeParams,
    CodexInitializeResult,
    CodexThreadStartParams,
    CodexThreadStartResult as CodexThreadStartRpcResult,
} from "./protocol/types";
import type {
    CodexCallOptions,
    CodexCustomModelProviderSettings,
    CodexProviderSettings,
    TransportContext,
} from "./provider-settings";
import { mergeThreadConfig, resolveCustomModelProviderSettings } from "./thread-start-config";
import { stripUndefined } from "./utils/object";
import { mapSystemPrompt } from "./utils/prompt-file-resolver";

interface ThreadStartResultLike extends CodexThreadStartRpcResult
{
    thread?: Partial<Thread>;
}

export interface CodexThreadStartOptions
{
    modelId?: string;
    modelSettings?: CodexCustomModelProviderSettings;
    callOptions?: CodexCallOptions;
    system?: string;
    prompt?: LanguageModelV3Prompt;
    signal?: AbortSignal;
}

export interface CodexStartedThread
{
    threadId: string;
    threadPath?: string;
}

export class CodexThreadClient
{
    constructor(private readonly settings: Readonly<CodexProviderSettings> = {}) {}

    async startThread(options: CodexThreadStartOptions = {}): Promise<CodexStartedThread>
    {
        const client = this.createClient(stripUndefined({ signal: options.signal }));
        await client.connect();

        try
        {
            const params = this.createThreadStartParams(options);

            await client.request<CodexInitializeResult>("initialize", this.initializeParams(params));
            await client.notification("initialized");

            const result = await client.request<ThreadStartResultLike>("thread/start", params);
            return toThreadStartResult(result);
        }
        finally
        {
            await client.disconnect();
        }
    }

    private createClient(context: TransportContext): AppServerClient
    {
        const transport = this.settings.transportFactory
            ? this.settings.transportFactory(context)
            : this.settings.transport?.type === "websocket"
                ? new WebSocketTransport(this.settings.transport.websocket)
                : new StdioTransport(this.settings.transport?.stdio);

        return new AppServerClient(transport, stripUndefined({
            onPacket: this.settings.debug?.logPackets === true ? this.settings.debug.logger : undefined,
        }));
    }

    private initializeParams(threadStartParams: CodexThreadStartParams): CodexInitializeParams
    {
        return stripUndefined({
            clientInfo: this.settings.clientInfo ?? {
                name: PACKAGE_NAME,
                version: PACKAGE_VERSION,
            },
            capabilities: needsExperimentalApi(this.settings, threadStartParams)
                ? { experimentalApi: true }
                : undefined,
        });
    }

    private createThreadStartParams(options: CodexThreadStartOptions): CodexThreadStartParams
    {
        const modelSettings = options.modelSettings ?? {};
        const callOptions = options.callOptions;
        const customModelProviderSettings = resolveCustomModelProviderSettings(
            this.settings,
            modelSettings,
        );
        const mcpServers = this.settings.mcpServers;
        const mcpConfig = mcpServers
            ? { mcp_servers: mcpServers } as CodexThreadStartParams["config"]
            : undefined;
        const config = mergeThreadConfig(mcpConfig, customModelProviderSettings.config);
        const dynamicTools = providerDynamicTools(this.settings);

        return stripUndefined({
            model: options.modelId ?? this.settings.defaultModel,
            modelProvider: customModelProviderSettings.modelProvider,
            dynamicTools,
            developerInstructions: developerInstructions(options),
            config,
            cwd: callOptions?.cwd ?? this.settings.defaultThreadSettings?.cwd,
            runtimeWorkspaceRoots: callOptions?.runtimeWorkspaceRoots
                ?? this.settings.defaultThreadSettings?.runtimeWorkspaceRoots,
            approvalPolicy: callOptions?.approvalPolicy
                ?? this.settings.defaultThreadSettings?.approvalPolicy,
            approvalsReviewer: callOptions?.approvalsReviewer
                ?? this.settings.defaultThreadSettings?.approvalsReviewer,
            sandbox: callOptions?.sandbox ?? this.settings.defaultThreadSettings?.sandbox,
            ephemeral: callOptions?.ephemeral ?? this.settings.defaultThreadSettings?.ephemeral,
        });
    }
}

export function createCodexThreadClient(settings: CodexProviderSettings = {}): CodexThreadClient
{
    return new CodexThreadClient(settings);
}

function developerInstructions(options: Pick<CodexThreadStartOptions, "prompt" | "system">): string | undefined
{
    if (options.prompt)
    {
        return mapSystemPrompt(options.prompt);
    }

    const system = options.system?.trim();
    return system ? system : undefined;
}

function providerDynamicTools(
    settings: Readonly<CodexProviderSettings>,
): CodexDynamicToolDefinition[] | undefined
{
    const tools = settings.tools
        ? Object.entries(settings.tools).map(([name, definition]) => ({
            name,
            description: definition.description,
            inputSchema: definition.inputSchema,
        }))
        : [];

    return tools.length > 0 ? tools : undefined;
}

function needsExperimentalApi(
    settings: Readonly<CodexProviderSettings>,
    threadStartParams: CodexThreadStartParams,
): boolean
{
    return settings.experimentalApi === true
        || (Array.isArray(threadStartParams.dynamicTools) && threadStartParams.dynamicTools.length > 0);
}

function toThreadStartResult(result: ThreadStartResultLike): CodexStartedThread
{
    const threadId = result.threadId ?? result.thread?.id;
    if (!threadId)
    {
        throw new Error("thread/start response does not include a thread id.");
    }

    return stripUndefined({
        threadId,
        threadPath: typeof result.thread?.path === "string" ? result.thread.path : undefined,
    });
}
