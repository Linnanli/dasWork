import { restoreComposerContextInputs } from "../utils/context-codec";
import { restoreFilesMentionedContext } from "../utils/local-context-directives";
import { stripUndefined } from "../utils/object";
import type { ThreadItem } from "./app-server-protocol/v2/ThreadItem";
import type { CodexTurnInputItem } from "./types";

type CollabAgentThreadItem = Extract<ThreadItem, { type: "collabAgentToolCall" }>;

export type LegacyCollabToolCallItem =
    Omit<CollabAgentThreadItem, "type"> & { type: "collabToolCall" };

export type LoadedToolThreadItem = {
    type: "loadedTool" | "loaded-tool";
    id: string;
    name?: string | null;
    toolName?: string | null;
    title?: string | null;
    status?: string | null;
};

export type CodexRenderableThreadItem =
    | ThreadItem
    | LegacyCollabToolCallItem
    | LoadedToolThreadItem;

export type ThreadItemClassification =
    | "user-message"
    | "assistant-text"
    | "reasoning"
    | "tool"
    | "file"
    | "ignored";

export interface CodexThreadItemToolInvocation
{
    toolCallId: string;
    toolName: string;
    input: unknown;
    result: { item: CodexRenderableThreadItem };
}

export const THREAD_ITEM_TYPE_COVERAGE: Record<ThreadItem["type"], true> = {
    userMessage: true,
    hookPrompt: true,
    agentMessage: true,
    plan: true,
    reasoning: true,
    commandExecution: true,
    fileChange: true,
    mcpToolCall: true,
    dynamicToolCall: true,
    collabAgentToolCall: true,
    subAgentActivity: true,
    webSearch: true,
    imageView: true,
    sleep: true,
    imageGeneration: true,
    enteredReviewMode: true,
    exitedReviewMode: true,
    contextCompaction: true,
};

export function classifyThreadItem(item: CodexRenderableThreadItem): ThreadItemClassification
{
    if (item.type === "collabToolCall")
    {
        return "tool";
    }

    switch (item.type)
    {
        case "userMessage":
            return "user-message";
        case "agentMessage":
            return "assistant-text";
        case "plan":
        case "reasoning":
            return "reasoning";
        case "commandExecution":
        case "fileChange":
        case "mcpToolCall":
        case "dynamicToolCall":
        case "collabAgentToolCall":
        case "subAgentActivity":
        case "webSearch":
        case "imageView":
        case "sleep":
        case "enteredReviewMode":
        case "exitedReviewMode":
        case "contextCompaction":
        case "hookPrompt":
        case "loadedTool":
        case "loaded-tool":
            return "tool";
        case "imageGeneration":
            return "file";
        default:
            return assertNever(item);
    }
}

export function toolNameForItem(item: CodexRenderableThreadItem): string | null
{
    switch (item.type)
    {
        case "commandExecution":
            return "codex_command_execution";
        case "fileChange":
            return "codex_file_change";
        case "mcpToolCall":
            return `mcp:${item.server}/${item.tool}`;
        case "dynamicToolCall":
            return item.tool;
        case "webSearch":
            return webSearchHasContent(item.query, item.action) ? "codex_web_search" : null;
        case "collabAgentToolCall":
        case "collabToolCall":
            return "codex_collab_agent";
        case "imageView":
            return "codex_image_view";
        case "sleep":
            return "codex_sleep";
        case "contextCompaction":
            return "codex_context_compaction";
        case "hookPrompt":
            return "codex_hook_prompt";
        case "subAgentActivity":
            return "codex_sub_agent_activity";
        case "loadedTool":
        case "loaded-tool":
            return "codex_loaded_tool";
        case "enteredReviewMode":
            return "codex_review_mode_entered";
        case "exitedReviewMode":
            return "codex_review_mode_exited";
        case "userMessage":
        case "agentMessage":
        case "plan":
        case "reasoning":
        case "imageGeneration":
            return null;
        default:
            return assertNever(item);
    }
}

export function toolInputForItem(item: CodexRenderableThreadItem): unknown
{
    switch (item.type)
    {
        case "commandExecution":
            return stripUndefined({
                command: item.command,
                cwd: item.cwd,
                commandActions: Array.isArray(item.commandActions) && item.commandActions.length > 0
                    ? item.commandActions
                    : undefined,
            });
        case "fileChange":
            return { changes: item.changes, status: item.status };
        case "mcpToolCall":
            return item.arguments ?? {};
        case "dynamicToolCall":
            return item.arguments ?? {};
        case "webSearch":
            return stripUndefined({ query: item.query, action: item.action ?? undefined });
        case "collabAgentToolCall":
        case "collabToolCall":
            return stripUndefined({
                tool: item.tool,
                status: item.status,
                senderThreadId: item.senderThreadId,
                receiverThreadIds: item.receiverThreadIds,
                prompt: item.prompt ?? undefined,
                model: item.model ?? undefined,
                reasoningEffort: item.reasoningEffort ?? undefined,
            });
        case "imageView":
            return { path: item.path };
        case "sleep":
            return { durationMs: item.durationMs };
        case "contextCompaction":
            return {};
        case "hookPrompt":
            return { fragments: item.fragments };
        case "subAgentActivity":
            return { kind: item.kind, agentThreadId: item.agentThreadId, agentPath: item.agentPath };
        case "loadedTool":
        case "loaded-tool":
            return stripUndefined({
                name: item.name ?? item.toolName ?? item.title ?? undefined,
                status: item.status ?? undefined,
            });
        case "enteredReviewMode":
        case "exitedReviewMode":
            return { review: item.review };
        case "userMessage":
        case "agentMessage":
        case "plan":
        case "reasoning":
        case "imageGeneration":
            return {};
        default:
            return assertNever(item);
    }
}

export function toolResultForItem(item: CodexRenderableThreadItem): CodexThreadItemToolInvocation["result"]
{
    return { item };
}

export function toolInvocationForItem(item: CodexRenderableThreadItem): CodexThreadItemToolInvocation | null
{
    const toolName = toolNameForItem(item);
    if (!toolName)
    {
        return null;
    }

    return {
        toolCallId: item.id,
        toolName,
        input: toolInputForItem(item),
        result: toolResultForItem(item),
    };
}

export function stringifyToolInput(input: unknown): string
{
    return JSON.stringify(input ?? {}) ?? "{}";
}

/**
 * True when a webSearch item carries something worth surfacing — a non-empty
 * query or a concrete action (search/openPage/findInPage). Codex emits
 * webSearch item/started as a contentless placeholder and fills it on
 * item/completed, so both realtime and history mapping use this gate.
 */
export function webSearchHasContent(query: string | null | undefined, action: { type: string } | null | undefined): boolean
{
    if (typeof query === "string" && query.trim().length > 0)
    {
        return true;
    }
    if (!action)
    {
        return false;
    }
    return action.type !== "other";
}

export function userInputText(value: readonly CodexTurnInputItem[]): string
{
    const text = restoreComposerContextInputs(value);
    return restoreFilesMentionedContext(text).text;
}

export function userMessageCompareKey(
    item: Extract<CodexRenderableThreadItem, { type: "userMessage" }>,
): string
{
    const text = userInputText(item.content).trim();
    const attachments = item.content.flatMap<{
        type: "image";
        url: string;
        detail?: string;
    } | {
        type: "localImage";
        path: string;
        detail?: string;
    }>((input) =>
    {
        switch (input.type)
        {
            case "image":
                return [{
                    type: input.type,
                    url: input.url,
                    ...(input.detail ? { detail: input.detail } : {}),
                }];
            case "localImage":
                return [{
                    type: input.type,
                    path: input.path,
                    ...(input.detail ? { detail: input.detail } : {}),
                }];
            case "text":
            case "skill":
            case "mention":
            case "audio":
            case "localAudio":
                return [];
            default:
                return assertNever(input);
        }
    });

    return JSON.stringify({ text, attachments });
}

export function reasoningTextForItem(item: Extract<ThreadItem, { type: "plan" | "reasoning" }>): string
{
    if (item.type === "plan")
    {
        return item.text.trim();
    }

    return [...item.summary, ...item.content]
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n\n");
}

function assertNever(value: never): never
{
    throw new Error(`Unhandled thread item: ${JSON.stringify(value)}`);
}
