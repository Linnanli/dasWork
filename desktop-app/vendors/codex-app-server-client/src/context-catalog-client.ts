import { randomUUID } from "node:crypto";

import { AppServerClient, JsonRpcError } from "./client/app-server-client";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import type { CodexAppServerClientSettings, TransportContext } from "./client-settings";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type { FuzzyFileSearchResponse } from "./protocol/app-server-protocol/FuzzyFileSearchResponse";
import type { FuzzyFileSearchResult } from "./protocol/app-server-protocol/FuzzyFileSearchResult";
import type { JsonValue } from "./protocol/app-server-protocol/serde_json/JsonValue";
import type { AppInfo } from "./protocol/app-server-protocol/v2/AppInfo";
import type { AppsListResponse } from "./protocol/app-server-protocol/v2/AppsListResponse";
import type { AppsReadParams } from "./protocol/app-server-protocol/v2/AppsReadParams";
import type { AppsReadResponse } from "./protocol/app-server-protocol/v2/AppsReadResponse";
import type { ConfigBatchWriteParams } from "./protocol/app-server-protocol/v2/ConfigBatchWriteParams";
import type { ConfigReadResponse } from "./protocol/app-server-protocol/v2/ConfigReadResponse";
import type { ConfigWriteResponse } from "./protocol/app-server-protocol/v2/ConfigWriteResponse";
import type { ConnectorMetadata } from "./protocol/app-server-protocol/v2/ConnectorMetadata";
import type { FsReadFileParams } from "./protocol/app-server-protocol/v2/FsReadFileParams";
import type { FsReadFileResponse } from "./protocol/app-server-protocol/v2/FsReadFileResponse";
import type { ListMcpServerStatusResponse } from "./protocol/app-server-protocol/v2/ListMcpServerStatusResponse";
import type { MarketplaceAddParams } from "./protocol/app-server-protocol/v2/MarketplaceAddParams";
import type { MarketplaceAddResponse } from "./protocol/app-server-protocol/v2/MarketplaceAddResponse";
import type { McpAuthStatus } from "./protocol/app-server-protocol/v2/McpAuthStatus";
import type { McpServerStatus } from "./protocol/app-server-protocol/v2/McpServerStatus";
import type { PluginDetail } from "./protocol/app-server-protocol/v2/PluginDetail";
import type { PluginInstalledResponse } from "./protocol/app-server-protocol/v2/PluginInstalledResponse";
import type { PluginInstallParams } from "./protocol/app-server-protocol/v2/PluginInstallParams";
import type { PluginInstallResponse } from "./protocol/app-server-protocol/v2/PluginInstallResponse";
import type { PluginListParams } from "./protocol/app-server-protocol/v2/PluginListParams";
import type { PluginListResponse } from "./protocol/app-server-protocol/v2/PluginListResponse";
import type { PluginMarketplaceEntry } from "./protocol/app-server-protocol/v2/PluginMarketplaceEntry";
import type { PluginReadResponse } from "./protocol/app-server-protocol/v2/PluginReadResponse";
import type { PluginSkillReadParams } from "./protocol/app-server-protocol/v2/PluginSkillReadParams";
import type { PluginSkillReadResponse } from "./protocol/app-server-protocol/v2/PluginSkillReadResponse";
import type { PluginSummary } from "./protocol/app-server-protocol/v2/PluginSummary";
import type { PluginUninstallParams } from "./protocol/app-server-protocol/v2/PluginUninstallParams";
import type { PluginUninstallResponse } from "./protocol/app-server-protocol/v2/PluginUninstallResponse";
import type { SkillMetadata } from "./protocol/app-server-protocol/v2/SkillMetadata";
import type { SkillsConfigWriteParams } from "./protocol/app-server-protocol/v2/SkillsConfigWriteParams";
import type { SkillsConfigWriteResponse } from "./protocol/app-server-protocol/v2/SkillsConfigWriteResponse";
import type { SkillsListResponse } from "./protocol/app-server-protocol/v2/SkillsListResponse";
import type { ThreadSearchResponse } from "./protocol/app-server-protocol/v2/ThreadSearchResponse";
import type { CodexInitializeParams, CodexInitializeResult } from "./protocol/types";
import { stripUndefined } from "./utils/object";

const PLUGIN_DETAIL_READ_CONCURRENCY = 6;
const APP_READ_BATCH_SIZE = 100;
const DEFAULT_SKILL_CONTENTS_MAX_BYTES = 512 * 1024;

type InstalledAppSummary = {
    id: string;
    runtimeName?: string | null;
    enabled: boolean;
    callable: boolean;
};

type AppsInstalledResponse = {
    apps: InstalledAppSummary[];
};

export interface CodexContextCatalogJsonRpcClientLike
{
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    notification(method: string, params?: unknown): Promise<void>;
    onNotification(method: string, handler: (params: unknown) => void | Promise<void>): () => void;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface CodexContextCatalogClientLease
{
    client: CodexContextCatalogJsonRpcClientLike;
    release(): Promise<void>;
}

export interface CodexContextCatalogClientSettings extends CodexAppServerClientSettings
{
    createClient?: () => CodexContextCatalogJsonRpcClientLike;
    /**
     * Supplies an already-initialized logical client owned by the embedding host.
     * When provided, this client never performs the app-server handshake itself.
     */
    acquireClient?: () => Promise<CodexContextCatalogClientLease>;
    /**
     * Lease a logical client for each request instead of reserving a physical
     * app-server connection for the whole catalog lifetime.
     */
    connectionLifecycle?: "persistent" | "per-operation";
}

export interface CodexCatalogSkill
{
    name: string;
    displayName: string;
    description: string;
    shortDescription?: string;
    path: string;
    scope: SkillMetadata["scope"];
    enabled: boolean;
}

export interface CodexCatalogPlugin
{
    id: string;
    name: string;
    mentionName: string;
    displayName: string;
    description?: string;
    marketplaceName: string;
    sourcePath: string;
    mentionPath: string;
    enabled: true;
}

export interface CodexCatalogApp
{
    id: string;
    name: string;
    mentionName: string;
    pluginDisplayNames: string[];
    description?: string;
    logoUrl?: string;
    logoUrlDark?: string;
    mentionPath: string;
    enabled: true;
    accessible: true;
}

export interface CodexAppsListParams
{
    threadId?: string | null;
    forceRefetch?: boolean;
    pageSize?: number;
}

export interface CodexAppsPage
{
    data: CodexCatalogApp[];
    nextCursor?: string;
}

export interface CodexAppsManagementPage
{
    data: AppInfo[];
    nextCursor?: string;
}

export interface CodexAppsReadParams
{
    appIds: string[];
    threadId?: AppsReadParams["threadId"];
    includeTools?: AppsReadParams["includeTools"];
}

export interface CodexAppsManagementReadResult
{
    apps: ConnectorMetadata[];
    missingAppIds: string[];
}

export interface CodexFuzzyFileSearchSession
{
    update(query: string): Promise<void>;
    stop(): Promise<void>;
}

export interface CodexTaskSearchResult
{
    threadId: string;
    name?: string;
    preview?: string;
    snippet?: string;
    cwd?: string;
    updatedAt: string;
    branch?: string;
    source: unknown;
    threadSource?: string;
    parentThreadId?: string;
    archived: boolean;
}

export interface CodexMcpServerStatusListParams
{
    threadId?: string | null;
    pageSize?: number;
}

export interface CodexMcpServerStatusSummary
{
    name: string;
    connected: boolean;
    authStatus: McpAuthStatus;
    toolCount: number;
}

interface McpServerStatusPage
{
    data: CodexMcpServerStatusSummary[];
    nextCursor?: string;
}

export interface CodexPluginCatalogListParams
{
    cwd?: string;
    forceRefetch?: boolean;
    marketplaceKinds?: PluginListParams["marketplaceKinds"];
}

export interface CodexPluginCatalogDetailsParams extends CodexPluginCatalogListParams
{
    onlyInstalled?: boolean;
}

export interface CodexPluginInstallRequest
{
    marketplacePath?: string | null;
    remoteMarketplaceName?: string | null;
    installAttemptId?: string | null;
    pluginName: string;
}

/** A fully resolved plugin/read target. Exactly one marketplace locator is required. */
export interface CodexPluginDetailReadRequest
{
    marketplacePath?: string;
    remoteMarketplaceName?: string;
    pluginName: string;
}

export interface CodexSkillEnabledRequest
{
    path?: string | null;
    name?: string | null;
    enabled: boolean;
}

export interface CodexConfigWriteActionResult
{
    response: ConfigWriteResponse;
    readback: ConfigReadResponse;
}

export interface CodexMcpConfigWriteActionResult extends CodexConfigWriteActionResult
{
    reloadStatus: "reloaded" | "failed";
}

export interface CodexMcpManagementSnapshot
{
    config: ConfigReadResponse;
    servers: CodexMcpServerStatusSummary[];
}

export interface CodexSkillFileReadParams
{
    path: string;
    maxBytes?: number;
}

export interface CodexRemotePluginSkillReadParams
{
    remoteMarketplaceName: string;
    remotePluginId: string;
    skillName: string;
    maxBytes?: number;
}

export class CodexContextCatalogClient
{
    private clientPromise: Promise<CodexContextCatalogJsonRpcClientLike> | undefined;
    private readonly fuzzyFileSearchSessionStops = new Set<() => Promise<void>>();
    private readonly mcpServerStatusRequests = new Map<string, Promise<CodexMcpServerStatusSummary[]>>();
    private fuzzyFileSearchSessionSupport: "unknown" | "supported" | "unsupported" = "unknown";

    constructor(private readonly settings: CodexContextCatalogClientSettings = {}) {}

    async listSkills(params: { cwd: string; forceReload?: boolean }): Promise<CodexCatalogSkill[]>
    {
        return this.withClient(async (client) =>
        {
            const response = await client.request<SkillsListResponse>("skills/list", stripUndefined({
                cwds: [params.cwd],
                forceReload: params.forceReload,
            }));

            return response.data
                .flatMap((entry) => entry.skills)
                .filter((skill) => skill.enabled)
                .map(normalizeSkill);
        });
    }

    async listInstalledPlugins(params: { cwd: string }): Promise<CodexCatalogPlugin[]>
    {
        return this.withClient(async (client) =>
        {
            const response = await client.request<PluginInstalledResponse>("plugin/installed", {
                cwds: [params.cwd],
                installSuggestionPluginNames: [],
            });

            return response.marketplaces.flatMap((marketplace) =>
                marketplace.plugins.flatMap((plugin) =>
                {
                    if (!plugin.installed || !plugin.enabled || plugin.source.type !== "local")
                    {
                        return [];
                    }

                    const mentionId = plugin.id.includes("@")
                        ? plugin.id
                        : `${plugin.name}@${marketplace.name}`;
                    return [stripUndefined({
                        id: plugin.id,
                        name: plugin.name,
                        mentionName: plugin.name,
                        displayName: plugin.interface?.displayName ?? plugin.name,
                        description: plugin.interface?.shortDescription ?? undefined,
                        marketplaceName: marketplace.name,
                        sourcePath: plugin.source.path,
                        mentionPath: `plugin://${mentionId}`,
                        enabled: true as const,
                    })];
                }),
            );
        });
    }

    async listPluginCatalog(params: CodexPluginCatalogListParams = {}): Promise<PluginListResponse>
    {
        return this.withClient((client) => client.request<PluginListResponse>("plugin/list", stripUndefined({
            cwds: params.cwd ? [params.cwd] : undefined,
            forceRefetch: params.forceRefetch,
            marketplaceKinds: params.marketplaceKinds,
        })));
    }

    async readPluginDetailsForManagement(params: CodexPluginCatalogDetailsParams = {}): Promise<PluginDetail[]>
    {
        return this.withClient(async (client) =>
        {
            const catalog = await client.request<PluginListResponse>("plugin/list", stripUndefined({
                cwds: params.cwd ? [params.cwd] : undefined,
                forceRefetch: params.forceRefetch,
                marketplaceKinds: params.marketplaceKinds,
            }));
            return this.readPluginDetailsFromCatalogWithClient(client, catalog, params.onlyInstalled === true);
        });
    }

    /**
     * Reads exactly one plugin detail after the desktop main process has
     * resolved its marketplace. This intentionally does not issue plugin/list.
     */
    async readPluginDetailForManagement(params: CodexPluginDetailReadRequest): Promise<PluginDetail>
    {
        assertPluginDetailReadRequest(params);
        return this.withClient(async (client) =>
        {
            const response = await client.request<PluginReadResponse>("plugin/read", stripUndefined({
                ...(params.marketplacePath ? { marketplacePath: params.marketplacePath } : {}),
                ...(params.remoteMarketplaceName ? { remoteMarketplaceName: params.remoteMarketplaceName } : {}),
                pluginName: params.pluginName,
            }));
            return response.plugin;
        });
    }

    async listInstalledPluginsForManagement(params: { cwd?: string } = {}): Promise<PluginInstalledResponse>
    {
        return this.withClient((client) => client.request<PluginInstalledResponse>("plugin/installed", {
            cwds: params.cwd ? [params.cwd] : [],
            installSuggestionPluginNames: [],
        }));
    }

    async readInstalledPluginDetails(params: { cwd?: string } = {}): Promise<PluginDetail[]>
    {
        return this.withClient(async (client) =>
        {
            const response = await client.request<PluginInstalledResponse>("plugin/installed", {
                cwds: params.cwd ? [params.cwd] : [],
                installSuggestionPluginNames: [],
            });

            const installedPlugins = response.marketplaces.flatMap((marketplace) =>
                marketplace.plugins
                    .filter((plugin) => plugin.installed)
                    .map((plugin) => ({
                        marketplacePath: marketplace.path,
                        remoteMarketplaceName: marketplace.path ? undefined : marketplace.name,
                        pluginName: plugin.name,
                    })),
            );

            const details: PluginDetail[] = [];
            for (const plugin of installedPlugins)
            {
                const detail = await client.request<PluginReadResponse>("plugin/read", stripUndefined(plugin));
                details.push(detail.plugin);
            }
            return details;
        });
    }

    async listSkillsForManagement(params: { cwd?: string; forceReload?: boolean }): Promise<SkillMetadata[]>
    {
        return this.withClient(async (client) =>
        {
            const response = await client.request<SkillsListResponse>("skills/list", stripUndefined({
                cwds: params.cwd ? [params.cwd] : [],
                forceReload: params.forceReload,
            }));

            return response.data.flatMap((entry) => entry.skills);
        });
    }

    async readSkillFileContents(params: CodexSkillFileReadParams): Promise<string>
    {
        const path = requiredSkillContentValue(params.path, "path");
        const maxBytes = skillContentsMaxBytes(params.maxBytes);
        return this.withClient(async (client) =>
        {
            const response = await client.request<FsReadFileResponse>(
                "fs/readFile",
                { path } satisfies FsReadFileParams,
            );
            return decodeBoundedSkillContents(response.dataBase64, maxBytes);
        });
    }

    async readRemotePluginSkillContents(params: CodexRemotePluginSkillReadParams): Promise<string | null>
    {
        const remoteMarketplaceName = requiredSkillContentValue(
            params.remoteMarketplaceName,
            "remote marketplace name",
        );
        const remotePluginId = requiredSkillContentValue(params.remotePluginId, "remote plugin id");
        const skillName = requiredSkillContentValue(params.skillName, "skill name");
        const maxBytes = skillContentsMaxBytes(params.maxBytes);
        return this.withClient(async (client) =>
        {
            const response = await client.request<PluginSkillReadResponse>(
                "plugin/skill/read",
                {
                    remoteMarketplaceName,
                    remotePluginId,
                    skillName,
                } satisfies PluginSkillReadParams,
            );
            return response.contents === null
                ? null
                : boundedSkillContents(response.contents, maxBytes);
        });
    }

    async listAppsForManagement(params: CodexAppsListParams = {}): Promise<AppInfo[]>
    {
        return this.withClient(async (client) =>
        {
            try
            {
                const installed = await client.request<AppsInstalledResponse>(
                    "app/installed",
                    params.forceRefetch ? { forceRefresh: true } : {},
                );
                const metadataById = new Map<string, ConnectorMetadata>();
                for (let start = 0; start < installed.apps.length; start += APP_READ_BATCH_SIZE)
                {
                    const appIds = installed.apps
                        .slice(start, start + APP_READ_BATCH_SIZE)
                        .map((app) => app.id);
                    const response = await client.request<AppsReadResponse>("app/read", { appIds });
                    for (const app of response.apps)
                    {
                        metadataById.set(app.id, app);
                    }
                }

                return installed.apps.map((app) => installedAppInfo(app, metadataById.get(app.id)));
            }
            catch (error)
            {
                if (!isUnsupportedMethod(error, "app/installed") && !isUnsupportedMethod(error, "app/read"))
                {
                    throw error;
                }
            }

            const apps: AppInfo[] = [];
            let cursor: string | undefined;

            do
            {
                const response = await this.requestAppsManagementPage(client, params, cursor);
                apps.push(...response.data);
                cursor = nextCursor(response.nextCursor, cursor, "app/list");
            }
            while (cursor);

            return apps;
        });
    }

    async readAppsForManagement(params: CodexAppsReadParams): Promise<CodexAppsManagementReadResult>
    {
        const appIds = [...new Set(params.appIds.filter(Boolean))];
        if (appIds.length === 0)
        {
            return { apps: [], missingAppIds: [] };
        }

        return this.withClient(async (client) =>
        {
            const apps: ConnectorMetadata[] = [];
            const missingAppIds: string[] = [];
            for (let start = 0; start < appIds.length; start += 100)
            {
                const request = stripUndefined({
                    appIds: appIds.slice(start, start + 100),
                    threadId: params.threadId,
                    includeTools: params.includeTools,
                }) satisfies AppsReadParams;
                const response = await client.request<AppsReadResponse>("app/read", request);
                apps.push(...response.apps);
                missingAppIds.push(...(response.missingAppIds ?? []));
            }
            return { apps, missingAppIds };
        });
    }

    async listAppsManagementPage(
        params: CodexAppsListParams & { cursor?: string } = {},
    ): Promise<CodexAppsManagementPage>
    {
        return this.withClient((client) => this.requestAppsManagementPage(client, params, params.cursor));
    }

    async readConfigForManagement(params: { cwd?: string } = {}): Promise<ConfigReadResponse>
    {
        return this.withClient((client) => this.readConfig(client, params.cwd));
    }

    async readMcpManagementSnapshot(params: { cwd?: string } = {}): Promise<CodexMcpManagementSnapshot>
    {
        const [config, servers] = await Promise.all([
            this.readConfigForManagement(params),
            this.listMcpServerStatus().catch(() => []),
        ]);
        return { config, servers };
    }

    async installPlugin(params: CodexPluginInstallRequest): Promise<PluginInstallResponse>
    {
        const request = stripUndefined({
            marketplacePath: params.marketplacePath,
            remoteMarketplaceName: params.remoteMarketplaceName,
            installAttemptId: params.installAttemptId,
            pluginName: params.pluginName,
        }) satisfies PluginInstallParams;
        return this.withClient((client) => client.request<PluginInstallResponse>("plugin/install", request));
    }

    async uninstallPlugin(params: PluginUninstallParams): Promise<PluginUninstallResponse>
    {
        return this.withClient((client) => client.request<PluginUninstallResponse>("plugin/uninstall", params));
    }

    async setPluginEnabled(params: { cwd?: string; pluginId: string; enabled: boolean }): Promise<CodexConfigWriteActionResult>
    {
        return this.writeEnabledConfigValue(params.cwd, ["plugins", params.pluginId, "enabled"], params.enabled);
    }

    async setAppEnabled(params: { cwd?: string; appId: string; enabled: boolean }): Promise<CodexConfigWriteActionResult>
    {
        return this.writeEnabledConfigValue(params.cwd, ["apps", params.appId, "enabled"], params.enabled);
    }

    async setMcpServerEnabled(params: { cwd?: string; serverName: string; enabled: boolean }): Promise<CodexMcpConfigWriteActionResult>
    {
        return this.withClient(async (client) =>
        {
            const result = await this.writeConfigValueWithClient(
                client,
                params.cwd,
                ["mcp_servers", params.serverName, "enabled"],
                params.enabled,
                "upsert",
            );
            return this.reloadMcpServersAfterWrite(client, result);
        });
    }

    async upsertMcpServer(params: { cwd?: string; serverName: string; value: JsonValue }): Promise<CodexMcpConfigWriteActionResult>
    {
        return this.withClient(async (client) =>
        {
            const result = await this.writeConfigValueWithClient(
                client,
                params.cwd,
                ["mcp_servers", params.serverName],
                params.value,
                "replace",
            );
            return this.reloadMcpServersAfterWrite(client, result);
        });
    }

    async removeMcpServer(params: { cwd?: string; serverName: string }): Promise<CodexMcpConfigWriteActionResult>
    {
        return this.withClient(async (client) =>
        {
            const result = await this.writeConfigValueWithClient(
                client,
                params.cwd,
                ["mcp_servers", params.serverName],
                null,
                "replace",
            );
            return this.reloadMcpServersAfterWrite(client, result);
        });
    }

    async reloadMcpServers(): Promise<void>
    {
        await this.withClient((client) => client.request("config/mcpServer/reload"));
    }

    async setSkillEnabled(params: CodexSkillEnabledRequest): Promise<SkillsConfigWriteResponse>
    {
        const request = stripUndefined({
            path: params.path,
            name: params.name,
            enabled: params.enabled,
        }) satisfies SkillsConfigWriteParams;
        return this.withClient((client) => client.request<SkillsConfigWriteResponse>("skills/config/write", request));
    }

    async addMarketplace(params: MarketplaceAddParams): Promise<MarketplaceAddResponse>
    {
        const sparsePaths = params.sparsePaths?.map((path) => path.trim()).filter(Boolean);
        return this.withClient((client) => client.request<MarketplaceAddResponse>("marketplace/add", stripUndefined({
            source: params.source.trim(),
            refName: params.refName?.trim() || undefined,
            sparsePaths: sparsePaths?.length ? sparsePaths : undefined,
        })));
    }

    async listApps(params: CodexAppsListParams = {}): Promise<CodexCatalogApp[]>
    {
        return this.withClient(async (client) =>
        {
            const apps: CodexCatalogApp[] = [];
            let cursor: string | undefined;

            do
            {
                const response = await this.requestAppsPage(client, params, cursor);
                apps.push(...response.data);
                cursor = nextCursor(response.nextCursor, cursor, "app/list");
            }
            while (cursor);

            return apps;
        });
    }

    async listAppsPage(params: CodexAppsListParams & { cursor?: string } = {}): Promise<CodexAppsPage>
    {
        return this.withClient((client) => this.requestAppsPage(client, params, params.cursor));
    }

    async listMcpServerStatus(
        params: CodexMcpServerStatusListParams = {},
    ): Promise<CodexMcpServerStatusSummary[]>
    {
        const requestKey = JSON.stringify([
            params.threadId ?? null,
            params.pageSize ?? 100,
        ]);
        const existingRequest = this.mcpServerStatusRequests.get(requestKey);
        if (existingRequest)
        {
            return existingRequest;
        }

        const request = this.withClient(async (client) =>
        {
            const servers: CodexMcpServerStatusSummary[] = [];
            let cursor: string | undefined;

            do
            {
                const response = await this.requestMcpServerStatusPage(client, params, cursor);
                servers.push(...response.data);
                cursor = nextCursor(response.nextCursor, cursor, "mcpServerStatus/list");
            }
            while (cursor);

            return servers;
        });
        this.mcpServerStatusRequests.set(requestKey, request);
        const clearRequest = (): void =>
        {
            if (this.mcpServerStatusRequests.get(requestKey) === request)
            {
                this.mcpServerStatusRequests.delete(requestKey);
            }
        };
        void request.then(clearRequest, clearRequest);
        return request;
    }

    async createFuzzyFileSearchSession(params: {
        roots: string[];
        onUpdated: (files: FuzzyFileSearchResult[], query: string) => void;
        onCompleted: (query: string) => void;
    }): Promise<CodexFuzzyFileSearchSession>
    {
        const sessionId = randomUUID();
        let lease = await this.createFuzzyFileSearchClientLease();
        let stopped = false;
        let currentQuery = "";
        let lastUpdatedQuery = "";

        let removeUpdatedHandler: () => void = () => undefined;
        let removeCompletedHandler: () => void = () => undefined;
        const subscribeToSessionNotifications = (): void =>
        {
            removeUpdatedHandler();
            removeCompletedHandler();
            removeUpdatedHandler = lease.client.onNotification(
                "fuzzyFileSearch/sessionUpdated",
                (raw) =>
                {
                    const notification = parseFuzzyFileSearchSessionUpdated(raw);
                    if (!notification || notification.sessionId !== sessionId || stopped)
                    {
                        return;
                    }

                    lastUpdatedQuery = notification.query;
                    params.onUpdated(notification.files, notification.query);
                },
            );
            removeCompletedHandler = lease.client.onNotification(
                "fuzzyFileSearch/sessionCompleted",
                (raw) =>
                {
                    const notification = parseFuzzyFileSearchSessionCompleted(raw);
                    if (!notification || notification.sessionId !== sessionId || stopped)
                    {
                        return;
                    }

                    params.onCompleted(lastUpdatedQuery || currentQuery);
                },
            );
        };
        subscribeToSessionNotifications();

        const startSession = async (): Promise<void> =>
        {
            if (this.fuzzyFileSearchSessionSupport === "unsupported")
            {
                return;
            }

            try
            {
                await lease.client.request("fuzzyFileSearch/sessionStart", {
                    sessionId,
                    roots: params.roots,
                });
                this.fuzzyFileSearchSessionSupport = "supported";
            }
            catch (error)
            {
                if (isUnsupportedFuzzyFileSearchMethod(error, "fuzzyFileSearch/sessionStart"))
                {
                    this.fuzzyFileSearchSessionSupport = "unsupported";
                    return;
                }
                throw error;
            }
        };

        try
        {
            await startSession();
        }
        catch (error)
        {
            removeUpdatedHandler();
            removeCompletedHandler();
            await this.invalidateFuzzyFileSearchClientLease(lease.client, lease.release);
            throw error;
        }

        const reconnect = async (): Promise<void> =>
        {
            const staleLease = lease;
            await this.invalidateFuzzyFileSearchClientLease(staleLease.client, staleLease.release);
            lease = await this.createFuzzyFileSearchClientLease();
            subscribeToSessionNotifications();
            if (this.fuzzyFileSearchSessionSupport === "supported")
            {
                await lease.client.request("fuzzyFileSearch/sessionStart", {
                    sessionId,
                    roots: params.roots,
                });
            }
        };

        const update = async (query: string, canReconnect = true): Promise<void> =>
        {
            if (stopped)
            {
                return;
            }

            currentQuery = query;
            try
            {
                if (this.fuzzyFileSearchSessionSupport === "supported")
                {
                    await this.updateFuzzyFileSearchSession(lease.client, sessionId, query, params.roots);
                    return;
                }

                await this.fuzzyFileSearch(
                    lease.client,
                    params.roots,
                    query,
                    () => stopped,
                    params.onUpdated,
                    params.onCompleted,
                );
            }
            catch (error)
            {
                if (error instanceof JsonRpcError || !canReconnect)
                {
                    throw error;
                }
                await reconnect();
                await update(query, false);
            }
        };

        const stop = async (): Promise<void> =>
        {
            if (stopped)
            {
                return;
            }

            stopped = true;
            this.fuzzyFileSearchSessionStops.delete(stop);
            removeUpdatedHandler();
            removeCompletedHandler();
            await this.stopFuzzyFileSearchSession(lease.client, sessionId);
            await lease.release();
        };
        this.fuzzyFileSearchSessionStops.add(stop);

        return {
            update,
            stop,
        };
    }

    async searchThreads(params: { query: string; limit?: number }): Promise<CodexTaskSearchResult[]>
    {
        return this.withClient(async (client) =>
        {
            const response = await client.request<ThreadSearchResponse>("thread/search", {
                searchTerm: params.query,
                limit: params.limit ?? 50,
                sortKey: "updated_at",
                sortDirection: "desc",
                archived: false,
            });
            return response.data.map(({ thread, snippet }) => stripUndefined({
                threadId: thread.id,
                name: thread.name ?? undefined,
                preview: thread.preview || undefined,
                snippet: snippet || undefined,
                cwd: thread.cwd || undefined,
                updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
                branch: thread.gitInfo?.branch ?? undefined,
                source: thread.source,
                threadSource: thread.threadSource ?? undefined,
                parentThreadId: thread.parentThreadId ?? undefined,
                archived: false,
            }));
        });
    }

    private async requestAppsPage(
        client: CodexContextCatalogJsonRpcClientLike,
        params: CodexAppsListParams,
        cursor: string | undefined,
    ): Promise<CodexAppsPage>
    {
        const response = await client.request<AppsListResponse>("app/list", stripUndefined({
            cursor,
            limit: params.pageSize ?? 100,
            threadId: params.threadId,
            forceRefetch: params.forceRefetch,
        }));

        return stripUndefined({
            data: response.data
                .filter((app) => app.isEnabled && app.isAccessible)
                .map(normalizeApp),
            nextCursor: response.nextCursor ?? undefined,
        });
    }

    private async requestAppsManagementPage(
        client: CodexContextCatalogJsonRpcClientLike,
        params: CodexAppsListParams,
        cursor: string | undefined,
    ): Promise<CodexAppsManagementPage>
    {
        const response = await client.request<AppsListResponse>("app/list", stripUndefined({
            cursor,
            limit: params.pageSize ?? 100,
            threadId: params.threadId,
            forceRefetch: params.forceRefetch,
        }));

        return stripUndefined({
            data: response.data,
            nextCursor: response.nextCursor ?? undefined,
        });
    }

    private async requestMcpServerStatusPage(
        client: CodexContextCatalogJsonRpcClientLike,
        params: CodexMcpServerStatusListParams,
        cursor: string | undefined,
    ): Promise<McpServerStatusPage>
    {
        const response = await client.request<ListMcpServerStatusResponse>("mcpServerStatus/list", stripUndefined({
            cursor,
            limit: params.pageSize ?? 100,
            detail: "toolsAndAuthOnly",
            threadId: params.threadId,
        }));

        return stripUndefined({
            data: response.data.map(normalizeMcpServerStatus),
            nextCursor: response.nextCursor ?? undefined,
        });
    }

    private async readInstalledPluginDetailsWithClient(
        client: CodexContextCatalogJsonRpcClientLike,
        cwd: string | undefined,
    ): Promise<PluginDetail[]>
    {
        const response = await client.request<PluginInstalledResponse>("plugin/installed", {
            cwds: cwd ? [cwd] : [],
            installSuggestionPluginNames: [],
        });

        return this.readPluginDetailsWithClient(
            client,
            response.marketplaces.flatMap((marketplace) =>
                marketplace.plugins
                    .filter((plugin) => plugin.installed)
                    .map((plugin) => ({ marketplace, plugin })),
            ),
        );
    }

    private async readPluginDetailsFromCatalogWithClient(
        client: CodexContextCatalogJsonRpcClientLike,
        catalog: PluginListResponse,
        onlyInstalled: boolean,
    ): Promise<PluginDetail[]>
    {
        return this.readPluginDetailsWithClient(
            client,
            catalog.marketplaces.flatMap((marketplace) =>
                marketplace.plugins
                    .filter((plugin) => !onlyInstalled || plugin.installed)
                    .map((plugin) => ({ marketplace, plugin })),
            ),
        );
    }

    private async readPluginDetailsWithClient(
        client: CodexContextCatalogJsonRpcClientLike,
        requests: Array<{ marketplace: PluginMarketplaceEntry; plugin: PluginSummary }>,
    ): Promise<PluginDetail[]>
    {
        const details: PluginDetail[] = [];
        for (let index = 0; index < requests.length; index += PLUGIN_DETAIL_READ_CONCURRENCY)
        {
            const batch = requests.slice(index, index + PLUGIN_DETAIL_READ_CONCURRENCY);
            details.push(
                ...(await Promise.all(
                    batch.map(({ marketplace, plugin }) =>
                        this.readPluginDetailWithClient(client, marketplace, plugin),
                    ),
                )),
            );
        }
        return details;
    }

    private async readPluginDetailWithClient(
        client: CodexContextCatalogJsonRpcClientLike,
        marketplace: PluginMarketplaceEntry,
        plugin: PluginSummary,
    ): Promise<PluginDetail>
    {
        const detail = await client.request<PluginReadResponse>("plugin/read", stripUndefined({
            marketplacePath: marketplace.path ?? undefined,
            remoteMarketplaceName: marketplace.path ? undefined : marketplace.name,
            pluginName: plugin.name,
        }));
        return detail.plugin;
    }

    private async writeEnabledConfigValue(
        cwd: string | undefined,
        keySegments: string[],
        enabled: boolean,
    ): Promise<CodexConfigWriteActionResult>
    {
        return this.withClient((client) => this.writeConfigValueWithClient(
            client,
            cwd,
            keySegments,
            enabled,
            "upsert",
        ));
    }

    private async writeConfigValueWithClient(
        client: CodexContextCatalogJsonRpcClientLike,
        cwd: string | undefined,
        keySegments: string[],
        value: JsonValue,
        mergeStrategy: "replace" | "upsert",
    ): Promise<CodexConfigWriteActionResult>
    {
        const before = await this.readConfig(client, cwd);
        const response = await client.request<ConfigWriteResponse>("config/batchWrite", {
            edits: [{
                keyPath: configKeyPath(keySegments),
                value,
                mergeStrategy,
            }],
            expectedVersion: findUserConfigVersion(before),
            reloadUserConfig: true,
        } satisfies ConfigBatchWriteParams);
        const readback = await this.readConfig(client, cwd);
        return { response, readback };
    }

    private async readConfig(
        client: CodexContextCatalogJsonRpcClientLike,
        cwd: string | undefined,
    ): Promise<ConfigReadResponse>
    {
        return client.request<ConfigReadResponse>("config/read", stripUndefined({
            includeLayers: true,
            cwd,
        }));
    }

    private async reloadMcpServersAfterWrite(
        client: CodexContextCatalogJsonRpcClientLike,
        result: CodexConfigWriteActionResult,
    ): Promise<CodexMcpConfigWriteActionResult>
    {
        try
        {
            await client.request("config/mcpServer/reload");
            return { ...result, reloadStatus: "reloaded" };
        }
        catch
        {
            return { ...result, reloadStatus: "failed" };
        }
    }

    private async withClient<T>(
        callback: (client: CodexContextCatalogJsonRpcClientLike) => Promise<T>,
    ): Promise<T>
    {
        if (this.settings.acquireClient)
        {
            const lease = await this.settings.acquireClient();
            try
            {
                return await callback(lease.client);
            }
            finally
            {
                await lease.release().catch(() => undefined);
            }
        }

        if (this.settings.connectionLifecycle === "per-operation")
        {
            return this.withLeasedClient(callback);
        }

        const client = await this.connectedClient();
        try
        {
            return await callback(client);
        }
        catch (error)
        {
            if (!(error instanceof JsonRpcError))
            {
                await this.invalidateClient(client);
            }
            throw error;
        }
    }

    private async withLeasedClient<T>(
        callback: (client: CodexContextCatalogJsonRpcClientLike) => Promise<T>,
    ): Promise<T>
    {
        const client = this.createClient();
        try
        {
            await client.connect();
            await client.request<CodexInitializeResult>("initialize", this.initializeParams());
            await client.notification("initialized");
            return await callback(client);
        }
        finally
        {
            await client.disconnect().catch(() => undefined);
        }
    }

    private async fuzzyFileSearch(
        client: CodexContextCatalogJsonRpcClientLike,
        roots: string[],
        query: string,
        isStopped: () => boolean,
        onUpdated: (files: FuzzyFileSearchResult[], query: string) => void,
        onCompleted: (query: string) => void,
    ): Promise<void>
    {
        const response = await client.request<FuzzyFileSearchResponse>("fuzzyFileSearch", {
            query,
            roots,
            cancellationToken: "vscode-fuzzy-file-search",
        });
        if (!isStopped())
        {
            onUpdated(response.files, query);
            onCompleted(query);
        }
    }

    private async updateFuzzyFileSearchSession(
        client: CodexContextCatalogJsonRpcClientLike,
        sessionId: string,
        query: string,
        roots: string[],
    ): Promise<void>
    {
        try
        {
            await client.request("fuzzyFileSearch/sessionUpdate", {
                sessionId,
                query,
            });
        }
        catch (error)
        {
            if (!isFuzzyFileSearchSessionNotFound(error))
            {
                throw error;
            }

            await client.request("fuzzyFileSearch/sessionStart", {
                sessionId,
                roots,
            });
            await client.request("fuzzyFileSearch/sessionUpdate", {
                sessionId,
                query,
            });
        }
    }

    private async stopFuzzyFileSearchSession(
        client: CodexContextCatalogJsonRpcClientLike,
        sessionId: string,
    ): Promise<void>
    {
        if (this.fuzzyFileSearchSessionSupport === "unsupported")
        {
            return;
        }

        try
        {
            await client.request("fuzzyFileSearch/sessionStop", { sessionId });
        }
        catch (error)
        {
            if (isUnsupportedFuzzyFileSearchMethod(error, "fuzzyFileSearch/sessionStop"))
            {
                this.fuzzyFileSearchSessionSupport = "unsupported";
            }
        }
    }

    private async createFuzzyFileSearchClientLease(): Promise<{
        client: CodexContextCatalogJsonRpcClientLike;
        release: () => Promise<void>;
    }>
    {
        if (this.settings.acquireClient)
        {
            return this.settings.acquireClient();
        }

        if (this.settings.connectionLifecycle !== "per-operation")
        {
            return {
                client: await this.connectedClient(),
                release: () => Promise.resolve(),
            };
        }

        const client = this.createClient();
        await client.connect();
        try
        {
            await client.request<CodexInitializeResult>("initialize", this.initializeParams());
            await client.notification("initialized");
        }
        catch (error)
        {
            await client.disconnect().catch(() => undefined);
            throw error;
        }

        return {
            client,
            release: () => client.disconnect().catch(() => undefined),
        };
    }

    private async invalidateFuzzyFileSearchClientLease(
        client: CodexContextCatalogJsonRpcClientLike,
        release: () => Promise<void>,
    ): Promise<void>
    {
        if (this.settings.acquireClient)
        {
            await release();
            return;
        }

        if (this.settings.connectionLifecycle !== "per-operation")
        {
            await this.invalidateClient(client);
            return;
        }

        await release();
    }

    private async invalidateClient(client: CodexContextCatalogJsonRpcClientLike): Promise<void>
    {
        const connected = this.clientPromise;
        if (!connected || await connected !== client)
        {
            return;
        }
        this.clientPromise = undefined;
        await client.disconnect().catch(() => undefined);
    }

    /** Keep one initialized app-server connection for the cached desktop catalog. */
    private connectedClient(): Promise<CodexContextCatalogJsonRpcClientLike>
    {
        if (this.clientPromise)
        {
            return this.clientPromise;
        }

        const client = this.createClient();
        const connecting = (async () =>
        {
            await client.connect();
            try
            {
                await client.request<CodexInitializeResult>("initialize", this.initializeParams());
                await client.notification("initialized");
                return client;
            }
            catch (error)
            {
                await client.disconnect();
                throw error;
            }
        })();
        this.clientPromise = connecting;
        void connecting.catch(() =>
        {
            if (this.clientPromise === connecting)
            {
                this.clientPromise = undefined;
            }
        });
        return connecting;
    }

    async shutdown(): Promise<void>
    {
        await Promise.allSettled(
            [...this.fuzzyFileSearchSessionStops].map((stop) => stop()),
        );
        const connected = this.clientPromise;
        this.clientPromise = undefined;
        if (!connected)
        {
            return;
        }
        await (await connected).disconnect();
    }

    private createClient(): CodexContextCatalogJsonRpcClientLike
    {
        if (this.settings.createClient)
        {
            return this.settings.createClient();
        }

        const transport = this.settings.transportFactory
            ? this.settings.transportFactory({} satisfies TransportContext)
            : this.settings.transport?.type === "websocket"
                ? new WebSocketTransport(this.settings.transport.websocket)
                : new StdioTransport(this.settings.transport?.stdio);

        return new AppServerClient(transport);
    }

    private initializeParams(): CodexInitializeParams
    {
        return stripUndefined({
            clientInfo: this.settings.clientInfo ?? {
                name: PACKAGE_NAME,
                version: PACKAGE_VERSION,
            },
            capabilities: { experimentalApi: this.settings.experimentalApi ?? true },
        });
    }
}

export function createCodexContextCatalogClient(
    settings: CodexContextCatalogClientSettings = {},
): CodexContextCatalogClient
{
    return new CodexContextCatalogClient(settings);
}

function assertPluginDetailReadRequest(params: CodexPluginDetailReadRequest): void
{
    const hasMarketplacePath = Boolean(params.marketplacePath?.trim());
    const hasRemoteMarketplaceName = Boolean(params.remoteMarketplaceName?.trim());
    if (hasMarketplacePath === hasRemoteMarketplaceName)
    {
        throw new Error("plugin/read requires exactly one marketplace locator.");
    }
    if (!params.pluginName.trim())
    {
        throw new Error("plugin/read requires a plugin name.");
    }
}

function normalizeSkill(skill: SkillMetadata): CodexCatalogSkill
{
    return stripUndefined({
        name: skill.name,
        displayName: skillDisplayName(skill),
        description: skill.description,
        shortDescription: skill.shortDescription,
        path: skill.path,
        scope: skill.scope,
        enabled: skill.enabled,
    });
}

function normalizeApp(app: AppInfo): CodexCatalogApp
{
    return stripUndefined({
        id: app.id,
        name: app.name,
        mentionName: appMentionName(app),
        pluginDisplayNames: app.pluginDisplayNames ?? [],
        description: app.description ?? undefined,
        logoUrl: app.logoUrl ?? undefined,
        logoUrlDark: app.logoUrlDark ?? undefined,
        mentionPath: `app://${app.id}`,
        enabled: true as const,
        accessible: true as const,
    });
}

function installedAppInfo(app: InstalledAppSummary, metadata?: ConnectorMetadata): AppInfo
{
    return {
        id: app.id,
        name: metadata?.name ?? app.runtimeName ?? app.id,
        description: metadata?.description ?? null,
        logoUrl: metadata?.iconUrl ?? metadata?.iconUrlDark ?? null,
        logoUrlDark: metadata?.iconUrlDark ?? metadata?.iconUrl ?? null,
        iconAssets: null,
        iconDarkAssets: null,
        distributionChannel: metadata?.distributionChannel ?? null,
        branding: null,
        appMetadata: null,
        labels: null,
        installUrl: metadata?.installUrl ?? null,
        isAccessible: app.callable,
        isEnabled: app.enabled,
        pluginDisplayNames: metadata?.pluginDisplayNames ?? [],
    };
}

function normalizeMcpServerStatus(status: McpServerStatus): CodexMcpServerStatusSummary
{
    const toolCount = countRecordKeys(status.tools);
    return {
        name: status.name,
        connected: status.serverInfo !== null || toolCount > 0,
        authStatus: status.authStatus,
        toolCount,
    };
}

function countRecordKeys(value: unknown): number
{
    if (!value || typeof value !== "object" || Array.isArray(value))
    {
        return 0;
    }
    return Object.keys(value).length;
}

function parseFuzzyFileSearchSessionUpdated(value: unknown): {
    sessionId: string;
    query: string;
    files: FuzzyFileSearchResult[];
} | undefined
{
    if (!value || typeof value !== "object")
    {
        return undefined;
    }

    const candidate = value as {
        sessionId?: unknown;
        query?: unknown;
        files?: unknown;
    };
    if (
        typeof candidate.sessionId !== "string" ||
        typeof candidate.query !== "string" ||
        !Array.isArray(candidate.files)
    )
    {
        return undefined;
    }

    return {
        sessionId: candidate.sessionId,
        query: candidate.query,
        files: candidate.files as FuzzyFileSearchResult[],
    };
}

function parseFuzzyFileSearchSessionCompleted(value: unknown): { sessionId: string } | undefined
{
    if (!value || typeof value !== "object")
    {
        return undefined;
    }

    const sessionId = (value as { sessionId?: unknown }).sessionId;
    return typeof sessionId === "string" ? { sessionId } : undefined;
}

function isUnsupportedFuzzyFileSearchMethod(error: unknown, method: string): boolean
{
    return isUnsupportedMethod(error, method);
}

function isUnsupportedMethod(error: unknown, method: string): boolean
{
    if (!(error instanceof JsonRpcError))
    {
        return false;
    }

    const message = error.message.toLowerCase();
    return (
        error.code === -32_601 ||
        message.includes("method not found") ||
        (
            message.includes("unknown variant") &&
            message.includes(method.toLowerCase())
        )
    );
}

function requiredSkillContentValue(value: string, label: string): string
{
    const trimmed = value.trim();
    if (!trimmed)
    {
        throw new Error(`Skill content ${label} is required`);
    }
    return trimmed;
}

function skillContentsMaxBytes(value: number | undefined): number
{
    const maxBytes = value ?? DEFAULT_SKILL_CONTENTS_MAX_BYTES;
    if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        maxBytes > DEFAULT_SKILL_CONTENTS_MAX_BYTES
    )
    {
        throw new Error(
            `Skill contents maximum supported size is ${DEFAULT_SKILL_CONTENTS_MAX_BYTES} bytes`,
        );
    }
    return maxBytes;
}

function decodeBoundedSkillContents(dataBase64: string, maxBytes: number): string
{
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.byteLength > maxBytes)
    {
        throw new Error(`Skill contents maximum supported size is ${maxBytes} bytes`);
    }
    try
    {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    catch
    {
        throw new Error("Skill contents must be valid UTF-8");
    }
}

function boundedSkillContents(contents: string, maxBytes: number): string
{
    if (Buffer.byteLength(contents, "utf8") > maxBytes)
    {
        throw new Error(`Skill contents maximum supported size is ${maxBytes} bytes`);
    }
    return contents;
}

function isFuzzyFileSearchSessionNotFound(error: unknown): boolean
{
    return (
        error instanceof JsonRpcError &&
        error.message.toLowerCase().includes("fuzzy file search session not found")
    );
}

function skillDisplayName(skill: SkillMetadata): string
{
    const interfaceDisplayName = skill.interface?.displayName?.trim();
    if (interfaceDisplayName)
    {
        return interfaceDisplayName;
    }

    const separatorIndex = skill.name.indexOf(":");
    if (separatorIndex > 0 && separatorIndex < skill.name.length - 1)
    {
        const pluginName = skill.name.slice(0, separatorIndex);
        const skillName = skill.name.slice(separatorIndex + 1);
        return `${skillName} (${pluginName})`;
    }

    return skill.name;
}

function appMentionName(app: AppInfo): string
{
    const mentionName = app.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    return mentionName || app.id;
}

function nextCursor(
    next: string | null | undefined,
    current: string | undefined,
    method: string,
): string | undefined
{
    if (!next)
    {
        return undefined;
    }
    if (next === current)
    {
        throw new Error(`${method} returned the same pagination cursor twice.`);
    }
    return next;
}

function findUserConfigVersion(response: ConfigReadResponse): string | null
{
    const userLayer = response.layers?.find((layer) => layer.name.type === "user");
    return userLayer?.version ?? null;
}

function configKeyPath(segments: string[]): string
{
    if (segments.length === 0)
    {
        throw new Error("Config key path requires at least one segment.");
    }

    return segments
        .map((segment, index) =>
            index === 0 || isStaticLeafSegment(segment)
                ? segment
                : quoteConfigKeySegment(segment))
        .join(".");
}

function isStaticLeafSegment(segment: string): boolean
{
    return segment === "enabled";
}

function quoteConfigKeySegment(segment: string): string
{
    return JSON.stringify(segment);
}
