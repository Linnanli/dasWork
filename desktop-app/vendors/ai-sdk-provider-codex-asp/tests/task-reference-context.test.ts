import type { Thread } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/Thread";
import { describe, expect, it } from "vitest";

import { normalizeReferencedTask } from "../src/utils/task-reference-context";

describe("normalizeReferencedTask", () =>
{
    it("keeps visible user/final assistant text and the last diff only", () =>
    {
        const thread = {
            id: "thread-1",
            name: "Referenced task",
            preview: "preview",
            turns: [
                {
                    status: "completed",
                    items: [
                        {
                            type: "userMessage",
                            content: [
                                { type: "text", text: "user request", text_elements: [] },
                                { type: "image", url: "https://example.com/image.png" },
                            ],
                        },
                        { type: "reasoning", summary: ["secret"], content: ["hidden"] },
                        { type: "agentMessage", text: "interim", phase: "commentary" },
                        { type: "agentMessage", text: "final answer", phase: "final_answer" },
                        {
                            type: "fileChange",
                            changes: [{ path: "a.ts", kind: "update", diff: "first diff" }],
                        },
                    ],
                },
                {
                    status: "completed",
                    items: [
                        {
                            type: "fileChange",
                            changes: [{ path: "b.ts", kind: "update", diff: "last diff" }],
                        },
                    ],
                },
            ],
        } as unknown as Thread;

        expect(normalizeReferencedTask(thread)).toEqual({
            title: "Referenced task",
            priorConversation: {
                conversation: [
                    {
                        role: "user",
                        content: [{ content_type: "text", text: "user request" }],
                    },
                    {
                        role: "assistant",
                        content: [{ content_type: "text", text: "final answer" }],
                    },
                ],
                diff: { type: "output_diff", diff: "last diff" },
            },
        });
    });
});
