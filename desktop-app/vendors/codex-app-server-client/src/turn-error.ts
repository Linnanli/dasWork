import type { TurnError } from "./protocol/app-server-protocol/v2/TurnError";
import type { TurnStatus } from "./protocol/app-server-protocol/v2/TurnStatus";

export const DEFAULT_TURN_FAILURE_MESSAGE = "The model request failed before completion.";

export function turnErrorMessage(
    status: TurnStatus | undefined,
    error: TurnError | null | undefined,
): string | undefined
{
    const message = error?.message?.trim();
    if (message)
    {
        return message;
    }
    return status === "failed" ? DEFAULT_TURN_FAILURE_MESSAGE : undefined;
}

export function normalizedFailedTurnError(
    status: TurnStatus | undefined,
    error: TurnError | null | undefined,
): TurnError | undefined
{
    if (status !== "failed")
    {
        return undefined;
    }

    return {
        message: turnErrorMessage(status, error) ?? DEFAULT_TURN_FAILURE_MESSAGE,
        codexErrorInfo: error?.codexErrorInfo ?? null,
        additionalDetails: error?.additionalDetails ?? null,
    };
}
