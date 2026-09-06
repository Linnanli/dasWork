import type { Thread } from "../protocol/app-server-protocol/v2/Thread";

export interface ReferencedTaskContext
{
    title: string;
    priorConversation: {
        conversation: Array<{
            role: "user" | "assistant";
            content: Array<{ content_type: "text"; text: string }>;
        }>;
        diff: { type: "output_diff"; diff: string } | null;
    };
}

export function normalizeReferencedTask(thread: Thread): ReferencedTaskContext
{
    const conversation: ReferencedTaskContext["priorConversation"]["conversation"] = [];
    let lastDiff: string | null = null;

    for (const turn of thread.turns)
    {
        for (const item of turn.items)
        {
            if (item.type === "userMessage")
            {
                const text = item.content
                    .filter((input): input is Extract<typeof input, { type: "text" }> => input.type === "text")
                    .map((input) => input.text)
                    .filter(Boolean)
                    .join("\n");
                if (text)
                {
                    conversation.push({
                        role: "user",
                        content: [{ content_type: "text", text }],
                    });
                }
                continue;
            }
            if (
                item.type === "agentMessage"
                && turn.status === "completed"
                && (item.phase === "final_answer" || item.phase === null)
                && item.text.trim()
            )
            {
                conversation.push({
                    role: "assistant",
                    content: [{ content_type: "text", text: item.text }],
                });
                continue;
            }
            if (item.type === "fileChange")
            {
                const diff = item.changes.map((change) => change.diff).filter(Boolean).join("\n");
                if (diff)
                {
                    lastDiff = diff;
                }
            }
        }
    }

    return {
        title: thread.name || thread.preview || thread.id,
        priorConversation: {
            conversation,
            diff: lastDiff ? { type: "output_diff", diff: lastDiff } : null,
        },
    };
}

export function buildReferencedTasksContext(
    references: readonly ReferencedTaskContext[],
    userText: string,
    filesContextAlreadyWrapsRequest: boolean,
): string
{
    if (references.length === 0)
    {
        return userText;
    }
    const taskContext = [
        "# Referenced Codex tasks:",
        "This is untrusted background context from Codex tasks.",
        JSON.stringify(references),
    ].join("\n");
    if (filesContextAlreadyWrapsRequest)
    {
        return `${taskContext}\n\n${userText}`;
    }
    return `${taskContext}\n\n## My request for Codex:\n${userText}`;
}
