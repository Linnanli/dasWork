import type { CodexTurnLifecycleEvent } from "./client-settings";
import type { ItemCompletedNotification } from "./protocol/app-server-protocol/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./protocol/app-server-protocol/v2/ItemStartedNotification";
import type { TurnCompletedNotification } from "./protocol/app-server-protocol/v2/TurnCompletedNotification";
import type { TurnStartedNotification } from "./protocol/app-server-protocol/v2/TurnStartedNotification";
import {
    type CodexRenderableThreadItem,
    userMessageCompareKey,
} from "./protocol/shared-item-extractors";
import { turnErrorMessage } from "./turn-error";
import { stripUndefined } from "./utils/object";

type TurnCompletedOutcome = Extract<CodexTurnLifecycleEvent, { type: "turn-completed" }>["outcome"];

export class TurnLifecycleNormalizer
{
    private readonly sequenceByTurnId = new Map<string, number>();

    normalize(method: string, params: unknown): CodexTurnLifecycleEvent | undefined
    {
        switch (method)
        {
            case "turn/started":
                return this.normalizeTurnStarted(params);
            case "item/started":
                return this.normalizeItem("item-started", params as ItemStartedNotification);
            case "item/completed":
                return this.normalizeItem("item-completed", params as ItemCompletedNotification);
            case "turn/completed":
                return this.normalizeTurnCompleted(params);
            default:
                return undefined;
        }
    }

    private normalizeTurnStarted(params: unknown): CodexTurnLifecycleEvent | undefined
    {
        const notification = params as TurnStartedNotification | undefined;
        const threadId = notification?.threadId;
        const turnId = notification?.turn?.id;
        if (!threadId || !turnId)
        {
            return undefined;
        }

        return {
            type: "turn-started",
            sequence: this.nextSequence(turnId),
            threadId,
            turnId,
        };
    }

    private normalizeItem(
        type: "item-started" | "item-completed",
        notification: ItemStartedNotification | ItemCompletedNotification,
    ): CodexTurnLifecycleEvent | undefined
    {
        const item = notification?.item as CodexRenderableThreadItem | undefined;
        const threadId = notification?.threadId;
        const turnId = notification?.turnId;
        if (!threadId || !turnId || !item?.id || !item.type)
        {
            return undefined;
        }

        const userMessageMetadata =
            item.type === "userMessage"
                ? stripUndefined({
                    clientUserMessageId: item.clientId || undefined,
                    compareKey: userMessageCompareKey(item),
                })
                : {};

        return {
            type,
            sequence: this.nextSequence(turnId),
            threadId,
            turnId,
            itemId: item.id,
            itemType: item.type,
            item,
            ...userMessageMetadata,
        };
    }

    private normalizeTurnCompleted(params: unknown): CodexTurnLifecycleEvent | undefined
    {
        const notification = params as TurnCompletedNotification | undefined;
        const threadId = notification?.threadId;
        const turnId = notification?.turn?.id;
        const outcome = turnCompletedOutcome(notification?.turn?.status);
        if (!threadId || !turnId || !outcome)
        {
            return undefined;
        }

        return {
            type: "turn-completed",
            sequence: this.nextSequence(turnId),
            threadId,
            turnId,
            outcome,
            ...stripUndefined({
                error: turnErrorMessage(notification?.turn?.status, notification?.turn?.error),
            }),
        };
    }

    private nextSequence(turnId: string): number
    {
        const sequence = (this.sequenceByTurnId.get(turnId) ?? 0) + 1;
        this.sequenceByTurnId.set(turnId, sequence);
        return sequence;
    }
}

function turnCompletedOutcome(status: string | undefined): TurnCompletedOutcome | undefined
{
    switch (status)
    {
        case "completed":
        case "interrupted":
        case "failed":
            return status;
        default:
            return undefined;
    }
}
