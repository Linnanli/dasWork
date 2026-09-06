import type { FileUpdateChange } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/FileUpdateChange";
import { describe, expect, it, vi } from "vitest";

import { ApprovalsDispatcher } from "../src/approvals";
import { AppServerClient } from "../src/client/app-server-client";
import type { JsonRpcMessage } from "../src/client/transport";
import { codexCallOptions } from "../src/protocol/provider-metadata";
import { createCodexAppServer } from "../src/provider";
import { MockTransport } from "./helpers/mock-transport";

class ScriptedTransport extends MockTransport
{
    private approvalScenario: "command" | "fileChange" | "toolUserInput" | "permissions" | "none" = "none";
    private approvalRequestId = 100;

    setApprovalScenario(scenario: "command" | "fileChange" | "toolUserInput" | "permissions" | "none"): void
    {
        this.approvalScenario = scenario;
    }

    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        await super.sendMessage(message);

        if (!("id" in message) || message.id === undefined || !("method" in message))
        {
            return;
        }

        if (message.method === "initialize")
        {
            this.emitMessage({
                id: message.id,
                result: { serverInfo: { name: "codex", version: "test" } },
            });
            return;
        }

        if (message.method === "thread/start")
        {
            this.emitMessage({ id: message.id, result: { threadId: "thr_1" } });
            return;
        }

        if (message.method === "turn/start")
        {
            this.emitMessage({ id: message.id, result: { turnId: "turn_1" } });

            if (this.approvalScenario === "command")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    // Codex sends a server→client request for command approval
                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/commandExecution/requestApproval",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_cmd_1",
                            approvalId: "approval_1",
                            reason: "Needs outbound access",
                            networkApprovalContext: { host: "github.com", protocol: "https" },
                            command: "git push origin main",
                            cwd: "/repo",
                            commandActions: [{ type: "unknown", command: "git push origin main" }],
                            additionalPermissions: { network: true, fileSystem: null },
                            proposedExecpolicyAmendment: ["git push *"],
                            proposedNetworkPolicyAmendments: [{ host: "github.com", action: "allow" }],
                        },
                    });
                });
            }
            else if (this.approvalScenario === "fileChange")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/fileChange/requestApproval",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_fc_1",
                            reason: "Write to /etc/config",
                        },
                    });
                });
            }
            else if (this.approvalScenario === "toolUserInput")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/tool/requestUserInput",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_tool_1",
                            questions: [
                                {
                                    id: "q1",
                                    header: "Choose environment",
                                    question: "Which environment?",
                                    isOther: false,
                                    isSecret: false,
                                    options: [
                                        { label: "production", description: "Prod env" },
                                        { label: "staging", description: "Staging env" },
                                    ],
                                },
                            ],
                        },
                    });
                });
            }
            else if (this.approvalScenario === "permissions")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/permissions/requestApproval",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_permissions_1",
                            environmentId: "env_1",
                            startedAtMs: 123,
                            cwd: "/repo",
                            reason: "Needs network access",
                            permissions: {
                                network: { enabled: true },
                                fileSystem: null,
                            },
                        },
                    });
                });
            }
            else
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });
                    this.emitMessage({
                        method: "item/started",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            itemType: "assistantMessage",
                        },
                    });
                    this.emitMessage({
                        method: "item/agentMessage/delta",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            delta: "Hello",
                        },
                    });
                    this.emitMessage({
                        method: "item/completed",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            itemType: "assistantMessage",
                        },
                    });
                    this.emitMessage({
                        method: "turn/completed",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            status: "completed",
                        },
                    });
                });
            }
        }
    }

    /**
   * When we receive an approval response, continue the turn.
   */
    handleApprovalResponse(responseMessage: JsonRpcMessage): void
    {
        if (
            "id" in responseMessage &&
      responseMessage.id === this.approvalRequestId &&
      "result" in responseMessage
        )
        {
            // Approval was answered — continue the turn
            queueMicrotask(() =>
            {
                this.emitMessage({
                    method: "item/started",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "item/agentMessage/delta",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        delta: "Done",
                    },
                });
                this.emitMessage({
                    method: "item/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "turn/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        status: "completed",
                    },
                });
            });
        }
    }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]>
{
    const reader = stream.getReader();
    const parts: unknown[] = [];

    while (true)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        parts.push(value);
    }

    return parts;
}

async function flushAsyncHandlers(): Promise<void>
{
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const initialFileChanges: FileUpdateChange[] = [
    {
        path: "src/config.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-old\n+new",
    },
];

const updatedFileChanges: FileUpdateChange[] = [
    {
        path: "src/config.ts",
        kind: { type: "update", move_path: null },
        diff: "@@ -1 +1 @@\n-new\n+newer",
    },
];

describe("ApprovalsDispatcher", () =>
{
    it("enriches file change approval requests from item/started changes", async () =>
    {
        const transport = new MockTransport();
        const client = new AppServerClient(transport);
        await client.connect();

        const onFileChangeApproval = vi.fn().mockResolvedValue("accept");
        const detach = new ApprovalsDispatcher({ onFileChangeApproval }).attach(client);

        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                startedAtMs: 1,
                item: {
                    type: "fileChange",
                    id: "item_fc_1",
                    status: "inProgress",
                    changes: initialFileChanges,
                },
            },
        });
        transport.emitMessage({
            id: 100,
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                itemId: "item_fc_1",
                startedAtMs: 2,
                reason: "Write config",
            },
        });
        await flushAsyncHandlers();

        expect(onFileChangeApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_fc_1",
            startedAtMs: 2,
            reason: "Write config",
            changes: initialFileChanges,
        });
        expect(transport.sentMessages).toContainEqual({ id: 100, result: { decision: "accept" } });

        detach();
        await client.disconnect();
    });

    it("uses latest patchUpdated changes and isolates by thread turn and item", async () =>
    {
        const transport = new MockTransport();
        const client = new AppServerClient(transport);
        await client.connect();

        const onFileChangeApproval = vi.fn().mockResolvedValue("accept");
        const detach = new ApprovalsDispatcher({ onFileChangeApproval }).attach(client);

        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                startedAtMs: 1,
                item: {
                    type: "fileChange",
                    id: "item_fc_1",
                    status: "inProgress",
                    changes: initialFileChanges,
                },
            },
        });
        transport.emitMessage({
            method: "item/fileChange/patchUpdated",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                itemId: "item_fc_1",
                changes: updatedFileChanges,
            },
        });
        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_2",
                startedAtMs: 3,
                item: {
                    type: "fileChange",
                    id: "item_fc_1",
                    status: "inProgress",
                    changes: [{ path: "other.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+other" }],
                },
            },
        });
        transport.emitMessage({
            id: 100,
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                itemId: "item_fc_1",
                startedAtMs: 4,
            },
        });
        await flushAsyncHandlers();

        expect(onFileChangeApproval).toHaveBeenCalledOnce();
        expect(onFileChangeApproval.mock.lastCall?.[0]).toMatchObject({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_fc_1",
            changes: updatedFileChanges,
        });

        detach();
        await client.disconnect();
    });

    it("cleans cached file changes on item completion turn completion and detach", async () =>
    {
        const transport = new MockTransport();
        const client = new AppServerClient(transport);
        await client.connect();

        const onFileChangeApproval = vi.fn().mockResolvedValue("accept");
        const detach = new ApprovalsDispatcher({ onFileChangeApproval }).attach(client);

        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                startedAtMs: 1,
                item: {
                    type: "fileChange",
                    id: "completed_item",
                    status: "inProgress",
                    changes: initialFileChanges,
                },
            },
        });
        transport.emitMessage({
            method: "item/completed",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                completedAtMs: 2,
                item: {
                    type: "fileChange",
                    id: "completed_item",
                    status: "completed",
                    changes: updatedFileChanges,
                },
            },
        });
        transport.emitMessage({
            id: 100,
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                itemId: "completed_item",
                startedAtMs: 3,
            },
        });
        await flushAsyncHandlers();
        expect(onFileChangeApproval.mock.lastCall?.[0]).toMatchObject({
            itemId: "completed_item",
            changes: [],
        });

        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_2",
                startedAtMs: 4,
                item: {
                    type: "fileChange",
                    id: "turn_completed_item",
                    status: "inProgress",
                    changes: initialFileChanges,
                },
            },
        });
        transport.emitMessage({
            method: "turn/completed",
            params: {
                threadId: "thr_1",
                turn: { id: "turn_2", items: [], status: "completed", error: null },
            },
        });
        transport.emitMessage({
            id: 101,
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thr_1",
                turnId: "turn_2",
                itemId: "turn_completed_item",
                startedAtMs: 5,
            },
        });
        await flushAsyncHandlers();
        expect(onFileChangeApproval.mock.lastCall?.[0]).toMatchObject({
            itemId: "turn_completed_item",
            changes: [],
        });

        transport.emitMessage({
            method: "item/started",
            params: {
                threadId: "thr_1",
                turnId: "turn_3",
                startedAtMs: 6,
                item: {
                    type: "fileChange",
                    id: "detached_item",
                    status: "inProgress",
                    changes: initialFileChanges,
                },
            },
        });
        detach();
        transport.emitMessage({
            id: 102,
            method: "item/fileChange/requestApproval",
            params: {
                threadId: "thr_1",
                turnId: "turn_3",
                itemId: "detached_item",
                startedAtMs: 7,
            },
        });
        await flushAsyncHandlers();

        expect(onFileChangeApproval).toHaveBeenCalledTimes(2);
        expect(transport.sentMessages).not.toContainEqual({ id: 102, result: { decision: "accept" } });

        await client.disconnect();
    });

    it("declines command execution by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("command");

        // Intercept outgoing messages to continue the turn after approval response
        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            // No approvals callbacks → defaults to decline
        });

        const model = provider.languageModel("gpt-5.5");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "push it" }] }],
        });

        const parts = await readAll(stream);

        // Should still complete the turn in this scripted transport flow.
        const textDeltas = (parts as { type: string; delta?: string }[]).filter(
            (p) => p.type === "text-delta",
        );
        expect(textDeltas).toHaveLength(1);
        expect(textDeltas[0]?.delta).toBe("Done");

        // Verify the approval response was sent with "decline"
        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse).toBeDefined();
        expect(approvalResponse?.result.decision).toBe("decline");
    });

    it("calls onCommandApproval callback and sends the decision", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("command");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onCommandApproval = vi.fn().mockResolvedValue("decline");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onCommandApproval,
            },
        });

        const model = provider.languageModel("gpt-5.5");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "push it" }] }],
        });

        await readAll(stream);

        expect(onCommandApproval).toHaveBeenCalledOnce();
        expect(onCommandApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_cmd_1",
            approvalId: "approval_1",
            reason: "Needs outbound access",
            networkApprovalContext: { host: "github.com", protocol: "https" },
            command: "git push origin main",
            cwd: "/repo",
            commandActions: [{ type: "unknown", command: "git push origin main" }],
            additionalPermissions: { network: true, fileSystem: null },
            proposedExecpolicyAmendment: ["git push *"],
            proposedNetworkPolicyAmendments: [{ host: "github.com", action: "allow" }],
        });

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("decline");
    });

    it("prefers per-call command approval handler over provider-level approvals", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("command");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const providerOnCommandApproval = vi.fn().mockResolvedValue("decline");
        const callOnCommandApproval = vi.fn().mockResolvedValue("accept");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onCommandApproval: providerOnCommandApproval,
            },
        });

        const model = provider.languageModel("gpt-5.5");

        await readAll(
            (
                await model.doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "push it" }] }],
                    providerOptions: codexCallOptions({
                        approvals: {
                            onCommandApproval: callOnCommandApproval,
                        },
                    }),
                })
            ).stream,
        );

        expect(callOnCommandApproval).toHaveBeenCalledOnce();
        expect(providerOnCommandApproval).not.toHaveBeenCalled();

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("accept");
    });

    it("calls onFileChangeApproval callback and sends the decision", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("fileChange");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onFileChangeApproval = vi.fn().mockResolvedValue("accept");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onFileChangeApproval,
            },
        });

        const model = provider.languageModel("gpt-5.5");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "write config" }] }],
        });

        await readAll(stream);

        expect(onFileChangeApproval).toHaveBeenCalledOnce();
        expect(onFileChangeApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_fc_1",
            reason: "Write to /etc/config",
            changes: [],
        });

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("accept");
    });

    it("falls back to provider-level file change approval when call-level approvals omit it", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("fileChange");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const providerOnFileChangeApproval = vi.fn().mockResolvedValue("accept");
        const callOnCommandApproval = vi.fn().mockResolvedValue("decline");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onFileChangeApproval: providerOnFileChangeApproval,
            },
        });

        const model = provider.languageModel("gpt-5.5");

        await readAll(
            (
                await model.doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "write config" }] }],
                    providerOptions: codexCallOptions({
                        approvals: {
                            onCommandApproval: callOnCommandApproval,
                        },
                    }),
                })
            ).stream,
        );

        expect(providerOnFileChangeApproval).toHaveBeenCalledOnce();
        expect(callOnCommandApproval).not.toHaveBeenCalled();

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("accept");
    });

    it("fails closed for permissions approval by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("permissions");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
        });

        await readAll(
            (
                await provider.languageModel("gpt-5.5").doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "fetch docs" }] }],
                })
            ).stream,
        );

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { permissions: Record<string, never>; scope: string } } | undefined;

        expect(approvalResponse?.result).toEqual({ permissions: {}, scope: "turn" });
    });

    it("calls provider-level permissions approval callback and sends the response", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("permissions");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onPermissionsApproval = vi.fn().mockResolvedValue({
            permissions: { network: { enabled: true } },
            scope: "session",
            strictAutoReview: true,
        });

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: { onPermissionsApproval },
        });

        await readAll(
            (
                await provider.languageModel("gpt-5.5").doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "fetch docs" }] }],
                })
            ).stream,
        );

        expect(onPermissionsApproval).toHaveBeenCalledOnce();
        expect(onPermissionsApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_permissions_1",
            environmentId: "env_1",
            startedAtMs: 123,
            cwd: "/repo",
            reason: "Needs network access",
            permissions: {
                network: { enabled: true },
                fileSystem: null,
            },
        });

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: unknown } | undefined;

        expect(approvalResponse?.result).toEqual({
            permissions: { network: { enabled: true } },
            scope: "session",
            strictAutoReview: true,
        });
    });

    it("prefers per-call permissions approval handler over provider-level approvals", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("permissions");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const providerOnPermissionsApproval = vi.fn().mockResolvedValue({
            permissions: {},
            scope: "turn",
        });
        const callOnPermissionsApproval = vi.fn().mockResolvedValue({
            permissions: { fileSystem: { read: ["/repo"], write: null } },
            scope: "turn",
        });

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: { onPermissionsApproval: providerOnPermissionsApproval },
        });

        await readAll(
            (
                await provider.languageModel("gpt-5.5").doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "read files" }] }],
                    providerOptions: codexCallOptions({
                        approvals: {
                            onPermissionsApproval: callOnPermissionsApproval,
                        },
                    }),
                })
            ).stream,
        );

        expect(callOnPermissionsApproval).toHaveBeenCalledOnce();
        expect(providerOnPermissionsApproval).not.toHaveBeenCalled();

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: unknown } | undefined;

        expect(approvalResponse?.result).toEqual({
            permissions: { fileSystem: { read: ["/repo"], write: null } },
            scope: "turn",
        });
    });

    it("auto-answers tool user input with first option by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("toolUserInput");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
        });

        const { stream } = await provider.languageModel("gpt-5.5").doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "deploy" }] }],
        });

        await readAll(stream);

        const response = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { answers: Record<string, { answers: string[] }> } } | undefined;

        expect(response?.result.answers).toEqual({ q1: { answers: ["production"] } });
    });

    it("calls onToolUserInput callback with the params", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("toolUserInput");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onToolUserInput = vi.fn().mockResolvedValue({ answers: { q1: { answers: ["staging"] } } });

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: { onToolUserInput },
        });

        await readAll(
            (
                await provider.languageModel("gpt-5.5").doStream({
                    prompt: [{ role: "user", content: [{ type: "text", text: "deploy" }] }],
                })
            ).stream,
        );

        expect(onToolUserInput).toHaveBeenCalledOnce();
        const [callArg] = onToolUserInput.mock.lastCall as [{ questions: { id: string }[] }];
        expect(callArg.questions[0]?.id).toBe("q1");

        const response = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { answers: Record<string, { answers: string[] }> } } | undefined;

        expect(response?.result.answers).toEqual({ q1: { answers: ["staging"] } });
    });

    it("declines file changes by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("fileChange");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            // No approvals callbacks → defaults to decline
        });

        const model = provider.languageModel("gpt-5.5");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "write config" }] }],
        });

        const parts = await readAll(stream);

        const textDeltas = (parts as { type: string; delta?: string }[]).filter(
            (p) => p.type === "text-delta",
        );
        expect(textDeltas).toHaveLength(1);
        expect(textDeltas[0]?.delta).toBe("Done");

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("decline");
    });
});
