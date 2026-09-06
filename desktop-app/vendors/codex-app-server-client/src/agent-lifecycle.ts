import type { CodexAgentLifecycleEvent } from "./client-settings";
import { stripUndefined } from "./utils/object";

/** Normalize app-server item notifications into the live-agent projection contract. */
export function agentLifecycleEvents(method: string, params: unknown): CodexAgentLifecycleEvent[]
{
    if (method !== "item/started" && method !== "item/completed")
    {
        return [];
    }

    const notification = recordValue(params);
    const item = recordValue(notification?.["item"]);
    const threadId = stringValue(notification?.["threadId"]);
    const turnId = stringValue(notification?.["turnId"]);
    const toolCallId = stringValue(item?.["id"]);
    if (!item || !threadId || !turnId || !toolCallId)
    {
        return [];
    }

    const timestampMs = numberValue(
        notification?.[method === "item/started" ? "startedAtMs" : "completedAtMs"],
    );
    if (item["type"] === "subAgentActivity")
    {
        const agentThreadId = stringValue(item["agentThreadId"]);
        const activity = stringValue(item["kind"]);
        if (!agentThreadId || !activity)
        {
            return [];
        }
        const kind: CodexAgentLifecycleEvent["kind"] = activity === "started"
            ? "started"
            : "updated";
        return [stripUndefined({
            kind,
            threadId,
            turnId,
            agentThreadId,
            agentPath: stringValue(item["agentPath"]),
            status: activity,
            toolCallId,
            timestampMs,
        })];
    }

    if (item["type"] !== "collabAgentToolCall")
    {
        return [];
    }

    const tool = collabToolName(item["tool"]);
    const states = recordValue(item["agentsStates"]);
    const receiverThreadIds = stringArray(item["receiverThreadIds"]);
    const agentThreadIds = receiverThreadIds.length > 0
        ? receiverThreadIds
        : states
            ? Object.keys(states)
            : [];

    return agentThreadIds.map((agentThreadId) =>
    {
        const state = recordValue(states?.[agentThreadId]);
        const status = stringValue(state?.["status"]);
        return stripUndefined({
            kind: lifecycleKindForCollab({ method, tool, status }),
            threadId,
            turnId,
            agentThreadId,
            status,
            toolCallId,
            timestampMs,
        });
    });
}

function lifecycleKindForCollab({
    method,
    tool,
    status,
}: {
    method: string;
    tool: string | undefined;
    status: string | undefined;
}): CodexAgentLifecycleEvent["kind"]
{
    if (tool === "closeAgent" || status === "shutdown" || status === "notFound")
    {
        return "closed";
    }
    if (status === "completed")
    {
        return "completed";
    }
    if (tool === "spawnAgent" && method === "item/started")
    {
        return "started";
    }
    return "updated";
}

function collabToolName(value: unknown): string | undefined
{
    if (typeof value === "string")
    {
        return value;
    }
    return stringValue(recordValue(value)?.["type"]);
}

function recordValue(value: unknown): Record<string, unknown> | undefined
{
    return value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : undefined;
}

function stringValue(value: unknown): string | undefined
{
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined
{
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[]
{
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
}
