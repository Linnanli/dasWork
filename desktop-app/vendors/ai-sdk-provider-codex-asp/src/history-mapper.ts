import { pathToFileURL } from "node:url";

import type { Thread } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/ThreadItem";
import type { Turn } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/Turn";
import type { UIMessage } from "ai";

import { CODEX_PROVIDER_ID } from "./protocol/provider-metadata";
import {
    type CodexRenderableThreadItem,
    type CodexThreadItemToolInvocation,
    reasoningTextForItem,
    toolInvocationForItem,
    userInputText,
} from "./protocol/shared-item-extractors";
import {
    fileChangeDiffBatchesForOrderedItems,
    turnDiffItem,
    unifiedDiffForFileChangeBatches,
} from "./protocol/turn-diff";
import type { CodexTurnInputItem } from "./protocol/types";
import { normalizedFailedTurnError } from "./turn-error";
import { stripUndefined } from "./utils/object";

type UiMessagePart = UIMessage["parts"][number];
type DynamicToolUiPart = Extract<UiMessagePart, { type: "dynamic-tool" }>;
type FileUiPart = Extract<UiMessagePart, { type: "file" }>;
type HistoricalTerminalTurnStatus = Extract<Turn["status"], "failed" | "interrupted">;

type CodexHistoricalTurnMessageMetadata = {
    codexTurn: {
        turnId: string
        status: HistoricalTerminalTurnStatus
        error?: NonNullable<Turn["error"]>
    }
};

type CodexHistorySourceMessageMetadata = {
    codexSource: {
        turnId: string
    }
};

export type CodexTurnForUi = Pick<Turn, "id" | "durationMs"> &
  Partial<Omit<Turn, "id" | "durationMs" | "items">> & {
      items: readonly CodexRenderableThreadItem[]
      /** Final live turn diff persisted by the desktop host. Empty means the turn ended with no changes. */
      diff?: string
  };

export type CodexThreadForUi = Pick<Thread, "id"> & {
    turns: CodexTurnForUi[]
    // Thread-list and history responses may omit cwd or return null for
    // threads created before the working directory was recorded.
    cwd?: Thread["cwd"] | null
};

export function mapCodexThreadToUiMessages(thread: CodexThreadForUi): UIMessage[]
{
    return thread.turns.flatMap((turn, index) =>
        mapCodexTurnToUiMessages(
            turn,
            thread.cwd ?? undefined,
            !hasLaterCompletedTurn(thread.turns, index),
        ),
    );
}

export function mapCodexTurnToUiMessages(
    turn: CodexTurnForUi,
    cwd?: string,
    includeTerminalState = true,
): UIMessage[]
{
    const messages: UIMessage[] = [];
    let assistantParts: UIMessage["parts"] = [];
    let assistantMessageId: string | undefined;

    const flushAssistant = (): void =>
    {
        if (assistantParts.length === 0)
        {
            return;
        }

        messages.push({
            id: assistantMessageId ?? `assistant:${turn.id}:turn-diff`,
            role: "assistant",
            parts: assistantParts,
            metadata: {
                codexSource: { turnId: turn.id },
            } satisfies CodexHistorySourceMessageMetadata,
        });

        assistantParts = [];
        assistantMessageId = undefined;
    };

    const appendAssistantPart = (sourceItemId: string, part: UiMessagePart): void =>
    {
    // A turn can contain multiple assistant-side segments separated by a
    // user message (for example, sub-agent activity before the user's
    // prompt). Anchor each segment to its first source item so that its
    // ID is both unique and stable when history is reloaded.
        assistantMessageId ??= `assistant:${turn.id}:${sourceItemId}`;
        assistantParts.push(part);
    };

    for (const item of turn.items)
    {
        switch (item.type)
        {
            case "userMessage": {
                flushAssistant();
                const parts = userMessageParts(item);
                if (parts.length > 0)
                {
                    messages.push({
                        id: item.clientId ?? item.id,
                        role: "user",
                        parts,
                    });
                }
                break;
            }
            case "agentMessage": {
                const text = item.text.trim();
                if (text)
                {
                    appendAssistantPart(item.id, agentMessagePart(item, text, turn.durationMs));
                }
                break;
            }
            case "plan":
            case "reasoning": {
                const text = reasoningTextForItem(item);
                if (text)
                {
                    appendAssistantPart(item.id, { type: "reasoning", text, state: "done" });
                }
                break;
            }
            case "commandExecution":
            case "fileChange":
            case "mcpToolCall":
            case "dynamicToolCall":
            case "collabAgentToolCall":
            case "collabToolCall":
            case "subAgentActivity":
            case "webSearch":
            case "imageView":
            case "sleep":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "contextCompaction":
            case "hookPrompt":
            case "loadedTool":
            case "loaded-tool": {
                const invocation = toolInvocationForItem(item);
                if (invocation)
                {
                    appendAssistantPart(item.id, dynamicToolPartForInvocation(invocation));
                }
                break;
            }
            case "imageGeneration": {
                if (item.result)
                {
                    appendAssistantPart(item.id, imageGenerationFilePart(item));
                }
                break;
            }
            default:
                assertNever(item);
        }
    }

    const historicalTurnDiffPart = turnDiffPartForTurn(turn, cwd);
    if (historicalTurnDiffPart)
    {
        appendAssistantPart(`turn-diff:${turn.id}`, historicalTurnDiffPart);
    }

    flushAssistant();
    if (includeTerminalState)
    {
        appendHistoricalTerminalState(messages, turn);
    }
    return messages;
}

function hasLaterCompletedTurn(turns: readonly CodexTurnForUi[], index: number): boolean
{
    return turns.slice(index + 1).some((turn) => turn.status === "completed");
}

function appendHistoricalTerminalState(messages: UIMessage[], turn: CodexTurnForUi): void
{
    if (turn.status !== "failed" && turn.status !== "interrupted")
    {
        return;
    }

    const error = normalizedFailedTurnError(turn.status, turn.error);
    const metadata: CodexHistoricalTurnMessageMetadata = {
        codexTurn: {
            turnId: turn.id,
            status: turn.status,
            ...(error ? { error } : {}),
        },
    };
    const lastMessageIndex = messages.length - 1;
    const lastMessage = messages[lastMessageIndex];
    if (lastMessage?.role === "assistant")
    {
        messages[lastMessageIndex] = {
            ...lastMessage,
            metadata: mergeMessageMetadata(lastMessage.metadata, metadata),
        };
        return;
    }

    messages.push({
        id: `assistant:${turn.id}:terminal`,
        role: "assistant",
        parts: [],
        metadata: {
            codexSource: { turnId: turn.id },
            ...metadata,
        } satisfies CodexHistorySourceMessageMetadata & CodexHistoricalTurnMessageMetadata,
    });
}

function mergeMessageMetadata(
    current: UIMessage["metadata"],
    terminal: CodexHistoricalTurnMessageMetadata,
): Record<string, unknown>
{
    return current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), ...terminal }
        : terminal;
}

function turnDiffPartForTurn(turn: CodexTurnForUi, cwd?: string): DynamicToolUiPart | null
{
    const batches = fileChangeDiffBatchesForOrderedItems(turn.items, cwd);
    const diff = typeof turn.diff === "string"
        ? turn.diff
        : unifiedDiffForFileChangeBatches(batches);
    if (!diff)
    {
        return null;
    }

    const item = turnDiffItem({
        id: `turn-diff:${turn.id}`,
        status: "completed",
        cwd: batches[0]?.cwd ?? cwd,
        diff,
        patchBatches: batches,
    });
    return {
        type: "dynamic-tool",
        toolName: "codex_turn_diff",
        toolCallId: item.id,
        state: "output-available",
        input: { turnId: turn.id },
        output: { item },
        providerExecuted: true,
    };
}

export function mapCodexThreadItemToUiPart(item: CodexRenderableThreadItem): UiMessagePart | null
{
    switch (item.type)
    {
        case "agentMessage": {
            const text = item.text.trim();
            return text ? agentMessagePart(item, text) : null;
        }
        case "plan":
        case "reasoning": {
            const text = reasoningTextForItem(item);
            return text ? { type: "reasoning", text, state: "done" } : null;
        }
        case "commandExecution":
        case "fileChange":
        case "mcpToolCall":
        case "dynamicToolCall":
        case "collabAgentToolCall":
        case "collabToolCall":
        case "subAgentActivity":
        case "webSearch":
        case "imageView":
        case "sleep":
        case "enteredReviewMode":
        case "exitedReviewMode":
        case "contextCompaction":
        case "hookPrompt":
        case "loadedTool":
        case "loaded-tool": {
            const invocation = toolInvocationForItem(item);
            return invocation ? dynamicToolPartForInvocation(invocation) : null;
        }
        case "imageGeneration":
            return item.result ? imageGenerationFilePart(item) : null;
        case "userMessage":
            return null;
        default:
            return assertNever(item);
    }
}

function agentMessagePart(
    item: Extract<CodexRenderableThreadItem, { type: "agentMessage" }>,
    text: string,
    turnDurationMs?: number | null,
): Extract<UiMessagePart, { type: "text" }>
{
    const metadata = stripUndefined({
        messagePhase: item.phase ?? undefined,
        turnDurationMs: turnDurationMs ?? undefined,
    });

    return {
        type: "text",
        text,
        state: "done",
        ...(Object.keys(metadata).length > 0
            ? { providerMetadata: { [CODEX_PROVIDER_ID]: metadata } }
            : {}),
    };
}

function userMessageParts(item: Extract<ThreadItem, { type: "userMessage" }>): UIMessage["parts"]
{
    const parts: UIMessage["parts"] = [];
    const content = item.content;
    const text = userInputText(content);
    if (text)
    {
        parts.push({ type: "text", text, state: "done" });
    }

    for (const entry of content)
    {
        const filePart = userInputFilePart(entry);
        if (filePart)
        {
            parts.push(filePart);
        }
    }

    return parts;
}

function userInputFilePart(entry: CodexTurnInputItem): FileUiPart | null
{
    switch (entry.type)
    {
        case "image":
            return { type: "file", mediaType: "image/*", url: entry.url };
        case "localImage":
            return { type: "file", mediaType: "image/*", url: pathToFileURL(entry.path).href };
        case "audio":
            return { type: "file", mediaType: "audio/*", url: entry.url };
        case "localAudio":
            return { type: "file", mediaType: "audio/*", url: pathToFileURL(entry.path).href };
        case "text":
        case "skill":
        case "mention":
            return null;
        default:
            return assertNever(entry);
    }
}

function dynamicToolPartForInvocation(
    invocation: CodexThreadItemToolInvocation,
): DynamicToolUiPart
{
    return {
        type: "dynamic-tool",
        toolName: invocation.toolName,
        toolCallId: invocation.toolCallId,
        state: "output-available",
        input: invocation.input,
        output: invocation.result,
        providerExecuted: true,
    };
}

function imageGenerationFilePart(
    item: Extract<ThreadItem, { type: "imageGeneration" }>,
): FileUiPart
{
    const providerMetadata = providerMetadataForImageGeneration(item);
    return stripUndefined({
        type: "file" as const,
        mediaType: "image/png",
        url: imageDataUrl(item.result),
        providerMetadata,
    });
}

function providerMetadataForImageGeneration(
    item: Extract<ThreadItem, { type: "imageGeneration" }>,
): FileUiPart["providerMetadata"] | undefined
{
    const metadata = stripUndefined({
        revisedPrompt: item.revisedPrompt ?? undefined,
        savedPath: item.savedPath,
    });

    return Object.keys(metadata).length > 0 ? { [CODEX_PROVIDER_ID]: metadata } : undefined;
}

function imageDataUrl(data: string): string
{
    return data.startsWith("data:") ? data : `data:image/png;base64,${data}`;
}

function assertNever(value: never): never
{
    throw new Error(`Unhandled user input: ${JSON.stringify(value)}`);
}
