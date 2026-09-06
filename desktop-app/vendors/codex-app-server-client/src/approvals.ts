import type { AppServerClient } from "./client/app-server-client";
import type { JsonRpcRequest } from "./client/transport";
import type { FileChangePatchUpdatedNotification } from "./protocol/app-server-protocol/v2/FileChangePatchUpdatedNotification";
import type { FileUpdateChange } from "./protocol/app-server-protocol/v2/FileUpdateChange";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeApprovalDecision,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    ItemCompletedNotification,
    ItemStartedNotification,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
    TurnCompletedNotification,
} from "./protocol/types";

export type CodexCommandApprovalRequest = CommandExecutionRequestApprovalParams;
export type CodexFileChangeApprovalRequest = FileChangeRequestApprovalParams & {
    changes: FileUpdateChange[]
};
export type CodexToolUserInputRequest = ToolRequestUserInputParams;
export type CodexElicitationRequest = McpServerElicitationRequestParams;
export type CodexPermissionsApprovalRequest = PermissionsRequestApprovalParams;

export type CommandApprovalHandler = (
    request: CodexCommandApprovalRequest,
) => CommandExecutionApprovalDecision | Promise<CommandExecutionApprovalDecision>;

export type FileChangeApprovalHandler = (
    request: CodexFileChangeApprovalRequest,
) => FileChangeApprovalDecision | Promise<FileChangeApprovalDecision>;

export type ToolUserInputHandler = (
    request: CodexToolUserInputRequest,
) => ToolRequestUserInputResponse | Promise<ToolRequestUserInputResponse>;

export type ElicitationHandler = (
    request: CodexElicitationRequest,
) => McpServerElicitationRequestResponse | Promise<McpServerElicitationRequestResponse>;

export type PermissionsApprovalHandler = (
    request: CodexPermissionsApprovalRequest,
) => PermissionsRequestApprovalResponse | Promise<PermissionsRequestApprovalResponse>;

export interface ApprovalsDispatcherSettings {
    onCommandApproval?: CommandApprovalHandler
    onFileChangeApproval?: FileChangeApprovalHandler
    onToolUserInput?: ToolUserInputHandler
    onElicitation?: ElicitationHandler
    onPermissionsApproval?: PermissionsApprovalHandler
}

function defaultToolUserInputHandler(
    params: ToolRequestUserInputParams,
): ToolRequestUserInputResponse
{
    const answers: ToolRequestUserInputResponse["answers"] = {};
    for (const q of params.questions)
    {
        const first = q.options?.[0];
        answers[q.id] = { answers: first ? [first.label] : [] };
    }
    return { answers };
}

function itemKey(threadId: string, turnId: string, itemId: string): string
{
    return `${threadId}\u0000${turnId}\u0000${itemId}`;
}

export class ApprovalsDispatcher
{
    private readonly onCommandApproval: CommandApprovalHandler;
    private readonly onFileChangeApproval: FileChangeApprovalHandler;
    private readonly onToolUserInput: ToolUserInputHandler;
    private readonly onElicitation: ElicitationHandler;
    private readonly onPermissionsApproval: PermissionsApprovalHandler;
    private readonly fileChangeBatches = new Map<string, FileUpdateChange[]>();

    constructor(settings: ApprovalsDispatcherSettings = {})
    {
        this.onCommandApproval = settings.onCommandApproval ?? (() => "decline");
        this.onFileChangeApproval = settings.onFileChangeApproval ?? (() => "decline");
        this.onToolUserInput = settings.onToolUserInput ?? defaultToolUserInputHandler;
        this.onElicitation =
            settings.onElicitation ??
      (() =>
        ({
            action: "accept",
            content: null,
            _meta: null,
        }) satisfies McpServerElicitationRequestResponse);
        this.onPermissionsApproval =
            settings.onPermissionsApproval ??
      (() => ({ permissions: {}, scope: "turn" }) satisfies PermissionsRequestApprovalResponse);
    }

    attach(client: AppServerClient): () => void
    {
        const unsubItemStarted = client.onNotification("item/started", (params: unknown) =>
        {
            const notification = params as Partial<ItemStartedNotification> | undefined;
            const item = notification?.item;
            if (
                item?.type !== "fileChange" ||
        !notification?.threadId ||
        !notification.turnId ||
        !item.id
            )
            {
                return;
            }

            this.fileChangeBatches.set(itemKey(notification.threadId, notification.turnId, item.id), [
                ...item.changes,
            ]);
        });

        const unsubFileChangePatchUpdated = client.onNotification(
            "item/fileChange/patchUpdated",
            (params: unknown) =>
            {
                const notification = params as Partial<FileChangePatchUpdatedNotification> | undefined;
                if (
                    !notification?.threadId ||
          !notification.turnId ||
          !notification.itemId ||
          !Array.isArray(notification.changes)
                )
                {
                    return;
                }

                this.fileChangeBatches.set(
                    itemKey(notification.threadId, notification.turnId, notification.itemId),
                    [...notification.changes],
                );
            },
        );

        const unsubItemCompleted = client.onNotification("item/completed", (params: unknown) =>
        {
            const notification = params as Partial<ItemCompletedNotification> | undefined;
            const item = notification?.item;
            if (!notification?.threadId || !notification.turnId || !item?.id)
            {
                return;
            }

            this.fileChangeBatches.delete(itemKey(notification.threadId, notification.turnId, item.id));
        });

        const unsubTurnCompleted = client.onNotification("turn/completed", (params: unknown) =>
        {
            const notification = params as Partial<TurnCompletedNotification> | undefined;
            const threadId = notification?.threadId;
            const turnId = notification?.turn?.id;
            if (!threadId || !turnId)
            {
                return;
            }

            this.deleteTurnFileChanges(threadId, turnId);
        });

        const unsubCommand = client.onRequest(
            "item/commandExecution/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                const decision = await this.onCommandApproval(params as CodexCommandApprovalRequest);
                return { decision } satisfies CommandExecutionRequestApprovalResponse;
            },
        );

        const unsubFileChange = client.onRequest(
            "item/fileChange/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                const request = params as FileChangeRequestApprovalParams;
                const changes =
                    this.fileChangeBatches.get(itemKey(request.threadId, request.turnId, request.itemId)) ??
          [];
                const decision = await this.onFileChangeApproval({ ...request, changes });
                return { decision } satisfies FileChangeRequestApprovalResponse;
            },
        );

        const unsubToolUserInput = client.onRequest(
            "item/tool/requestUserInput",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                return (await this.onToolUserInput(
                    params as CodexToolUserInputRequest,
                )) satisfies ToolRequestUserInputResponse;
            },
        );

        const unsubPermissions = client.onRequest(
            "item/permissions/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                return (await this.onPermissionsApproval(
                    params as CodexPermissionsApprovalRequest,
                )) satisfies PermissionsRequestApprovalResponse;
            },
        );

        const unsubElicitation = client.onRequest(
            "mcpServer/elicitation/request",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                return (await this.onElicitation(
                    params as CodexElicitationRequest,
                )) satisfies McpServerElicitationRequestResponse;
            },
        );

        return () =>
        {
            unsubItemStarted();
            unsubFileChangePatchUpdated();
            unsubItemCompleted();
            unsubTurnCompleted();
            unsubCommand();
            unsubFileChange();
            unsubToolUserInput();
            unsubPermissions();
            unsubElicitation();
            this.fileChangeBatches.clear();
        };
    }

    private deleteTurnFileChanges(threadId: string, turnId: string): void
    {
        const prefix = `${threadId}\u0000${turnId}\u0000`;
        for (const key of this.fileChangeBatches.keys())
        {
            if (key.startsWith(prefix))
            {
                this.fileChangeBatches.delete(key);
            }
        }
    }
}
