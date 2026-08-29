import { describe, expect, it, vi } from "vitest";

import { JsonRpcError } from "../src/client/app-server-client";
import {
    CodexContextCatalogClient,
    type CodexContextCatalogJsonRpcClientLike,
} from "../src/context-catalog-client";

class CatalogMockClient implements CodexContextCatalogJsonRpcClientLike
{
    readonly requests: Array<{ method: string; params: unknown }> = [];
    readonly notifications: Array<{ method: string; params: unknown }> = [];
    private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
    connectCount = 0;
    disconnectCount = 0;

    constructor(private readonly handler: (method: string, params: unknown) => unknown) {}

    connect(): Promise<void>
    {
        this.connectCount++;
        return Promise.resolve();
    }

    disconnect(): Promise<void>
    {
        this.disconnectCount++;
        return Promise.resolve();
    }

    notification(method: string, params?: unknown): Promise<void>
    {
        this.notifications.push({ method, params });
        return Promise.resolve();
    }

    onNotification(method: string, handler: (params: unknown) => void | Promise<void>): () => void
    {
        const handlers = this.notificationHandlers.get(method) ?? new Set();
        handlers.add(handler);
        this.notificationHandlers.set(method, handlers);
        return () =>
        {
            handlers.delete(handler);
            if (handlers.size === 0)
            {
                this.notificationHandlers.delete(method);
            }
        };
    }

    request<T>(method: string, params?: unknown): Promise<T>
    {
        this.requests.push({ method, params });
        if (method === "initialize")
        {
            return Promise.resolve({} as T);
        }
        return Promise.resolve(this.handler(method, params) as T);
    }

    emitNotification(method: string, params: unknown): void
    {
        for (const handler of this.notificationHandlers.get(method) ?? [])
        {
            void handler(params);
        }
    }
}

function fuzzyFile(path: string)
{
    return {
        root: "/repo",
        path,
        match_type: "file" as const,
        file_name: path,
        score: 1,
        indices: null,
    };
}

function mcpStatus(name: string, overrides: Record<string, unknown> = {})
{
    return {
        name,
        serverInfo: {
            name,
            title: `${name} title`,
            version: "1.0.0",
            description: "private server description",
            icons: [{ src: "private-icon" }],
            websiteUrl: "https://private.example.invalid",
        },
        tools: {
            lookup: {
                name: "lookup",
                title: "Lookup",
                description: "private tool schema",
                inputSchema: {
                    type: "object",
                    properties: {
                        token: { type: "string" },
                    },
                },
            },
        },
        resources: [{ uri: "secret://resource", name: "secret resource" }],
        resourceTemplates: [{ uriTemplate: "secret://{id}", name: "secret template" }],
        authStatus: "oAuth",
        ...overrides,
    };
}

describe("CodexContextCatalogClient", () =>
{
    it("leases and releases a client for each catalog operation when sharing a host connection", async () =>
    {
        const clients: CatalogMockClient[] = [];
        const client = new CodexContextCatalogClient({
            connectionLifecycle: "per-operation",
            createClient: () =>
            {
                const next = new CatalogMockClient(() => ({ data: [], nextCursor: null }));
                clients.push(next);
                return next;
            },
        });

        await Promise.all([client.listApps(), client.listApps()]);

        expect(clients).toHaveLength(2);
        expect(clients.map((item) => item.connectCount)).toEqual([1, 1]);
        expect(clients.map((item) => item.disconnectCount)).toEqual([1, 1]);
        await client.shutdown();
    });

    it("normalizes enabled skills and installed local plugins", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "skills/list")
            {
                return {
                    data: [{
                        cwd: "/repo",
                        errors: [],
                        skills: [
                            {
                                name: "slides",
                                description: "Create slides",
                                shortDescription: "Slides",
                                interface: { displayName: "Slides UI" },
                                path: "/skills/slides/SKILL.md",
                                scope: "user",
                                enabled: true,
                            },
                            {
                                name: "disabled",
                                description: "Disabled",
                                path: "/skills/disabled/SKILL.md",
                                scope: "user",
                                enabled: false,
                            },
                        ],
                    }],
                };
            }

            return {
                marketplaceLoadErrors: [],
                marketplaces: [{
                    name: "local-market",
                    plugins: [
                        {
                            id: "sample",
                            name: "sample",
                            installed: true,
                            enabled: true,
                            source: { type: "local", path: "/plugins/sample" },
                            interface: { displayName: "Sample Plugin", shortDescription: "A sample" },
                        },
                        {
                            id: "remote",
                            name: "remote",
                            installed: true,
                            enabled: true,
                            source: { type: "remote" },
                            interface: null,
                        },
                    ],
                }],
            };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listSkills({ cwd: "/repo" })).resolves.toEqual([{
            name: "slides",
            displayName: "Slides UI",
            description: "Create slides",
            shortDescription: "Slides",
            path: "/skills/slides/SKILL.md",
            scope: "user",
            enabled: true,
        }]);
        await expect(client.listInstalledPlugins({ cwd: "/repo" })).resolves.toEqual([{
            id: "sample",
            name: "sample",
            mentionName: "sample",
            displayName: "Sample Plugin",
            description: "A sample",
            marketplaceName: "local-market",
            sourcePath: "/plugins/sample",
            mentionPath: "plugin://sample@local-market",
            enabled: true,
        }]);
        expect(mock.connectCount).toBe(1);
        await client.shutdown();
        expect(mock.disconnectCount).toBe(1);
    });

    it("keeps management plugin, skill, and app lists unfiltered", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "plugin/list")
            {
                return {
                    marketplaceLoadErrors: [],
                    featuredPluginIds: ["remote-plugin"],
                    marketplaces: [{
                        name: "remote-market",
                        path: null,
                        interface: null,
                        plugins: [{
                            id: "remote-plugin",
                            remotePluginId: "remote-plugin",
                            version: "1",
                            localVersion: null,
                            name: "remote-plugin",
                            shareContext: null,
                            source: { type: "remote" },
                            installed: false,
                            installedAt: null,
                            enabled: false,
                            installPolicy: "allowed",
                            installPolicySource: null,
                            mustShowInstallationInterstitial: null,
                            authPolicy: "none",
                            availability: { type: "available" },
                            disabledReason: null,
                            eligiblePlanTypes: null,
                            interface: null,
                            keywords: [],
                        }],
                    }],
                };
            }
            if (method === "skills/list")
            {
                return {
                    data: [{
                        cwd: "/repo",
                        errors: [],
                        skills: [
                            {
                                name: "enabled",
                                description: "Enabled",
                                path: "/skills/enabled/SKILL.md",
                                scope: "user",
                                enabled: true,
                            },
                            {
                                name: "disabled",
                                description: "Disabled",
                                path: "/skills/disabled/SKILL.md",
                                scope: "user",
                                enabled: false,
                            },
                        ],
                    }],
                };
            }
            if (method === "app/installed")
            {
                return {
                    apps: [{
                        id: "disabled-app",
                        runtimeName: "Disabled App",
                        enabled: false,
                        callable: false,
                    }],
                };
            }
            if (method === "app/read")
            {
                return {
                    apps: [{
                        id: "disabled-app",
                        name: "Disabled App",
                        description: null,
                        iconUrl: null,
                        iconUrlDark: null,
                        distributionChannel: null,
                        installUrl: null,
                        pluginDisplayNames: [],
                        toolSummaries: null,
                    }],
                    missingAppIds: [],
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const catalog = await client.listPluginCatalog({ cwd: "/repo", forceRefetch: true });
        const skills = await client.listSkillsForManagement({ cwd: "/repo" });
        const apps = await client.listAppsForManagement();

        expect(catalog.featuredPluginIds).toEqual(["remote-plugin"]);
        expect(skills.map((skill) => [skill.name, skill.enabled])).toEqual([
            ["enabled", true],
            ["disabled", false],
        ]);
        expect(apps.map((app) => [app.id, app.isEnabled, app.isAccessible])).toEqual([
            ["disabled-app", false, false],
        ]);
        expect(mock.requests.find(({ method }) => method === "plugin/list")?.params).toEqual({
            cwds: ["/repo"],
            forceRefetch: true,
        });
        expect(mock.requests.find(({ method }) => method === "app/installed")?.params).toEqual({});
        expect(mock.requests.find(({ method }) => method === "app/read")?.params).toEqual({
            appIds: ["disabled-app"],
        });
    });

    it("falls back to app/list when the installed app lifecycle is unsupported", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "initialize")
            {
                return { userAgent: "test" };
            }
            if (method === "app/installed")
            {
                throw new JsonRpcError({ code: -32_601, message: "Method not found" });
            }
            if (method === "app/list")
            {
                return {
                    data: [{
                        id: "directory-app",
                        name: "Directory App",
                        description: null,
                        logoUrl: null,
                        logoUrlDark: null,
                        iconAssets: null,
                        iconDarkAssets: null,
                        distributionChannel: null,
                        branding: null,
                        appMetadata: null,
                        labels: null,
                        installUrl: null,
                        isEnabled: true,
                        isAccessible: true,
                        pluginDisplayNames: [],
                    }],
                    nextCursor: null,
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listAppsForManagement()).resolves.toMatchObject([
            { id: "directory-app", name: "Directory App" },
        ]);
        expect(mock.requests.map(({ method }) => method)).toContain("app/list");
    });

    it("preserves installed app order while enriching identity aliases from app/read", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "initialize")
            {
                return { userAgent: "test" };
            }
            if (method === "app/installed")
            {
                return {
                    apps: [
                        { id: "github", runtimeName: "GitHub", enabled: true, callable: true },
                        { id: "security-access", runtimeName: "Security", enabled: true, callable: true },
                    ],
                };
            }
            if (method === "app/read")
            {
                return {
                    apps: [
                        {
                            id: "security-access",
                            name: "Codex Security Access",
                            description: null,
                            iconUrl: null,
                            iconUrlDark: null,
                            distributionChannel: null,
                            installUrl: null,
                            pluginDisplayNames: ["Codex Security"],
                            toolSummaries: null,
                        },
                        {
                            id: "github",
                            name: "GitHub",
                            description: null,
                            iconUrl: null,
                            iconUrlDark: null,
                            distributionChannel: null,
                            installUrl: null,
                            pluginDisplayNames: ["Codex Security", "GitHub"],
                            toolSummaries: null,
                        },
                    ],
                    missingAppIds: [],
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const apps = await client.listAppsForManagement();

        expect(apps.map((app) => app.id)).toEqual(["github", "security-access"]);
        expect(apps[0]?.pluginDisplayNames).toEqual(["Codex Security", "GitHub"]);
    });

    it("reads local skill contents through fs/readFile with bounded UTF-8 decoding", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method === "fs/readFile")
            {
                expect(params).toEqual({ path: "/trusted/review/SKILL.md" });
                return {
                    dataBase64: Buffer.from("# Review\nUse this skill.", "utf8").toString("base64"),
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(
            client.readSkillFileContents({
                path: "/trusted/review/SKILL.md",
                maxBytes: 512,
            }),
        ).resolves.toBe("# Review\nUse this skill.");
        expect(mock.requests.map(({ method }) => method)).toContain("fs/readFile");
    });

    it("rejects non-UTF-8 or oversized local skill contents", async () =>
    {
        const invalidUtf8 = new CatalogMockClient((method) =>
        {
            if (method === "fs/readFile")
            {
                return { dataBase64: Buffer.from([0xff]).toString("base64") };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const oversized = new CatalogMockClient((method) =>
        {
            if (method === "fs/readFile")
            {
                return { dataBase64: Buffer.from("too large", "utf8").toString("base64") };
            }
            throw new Error(`unexpected method: ${method}`);
        });

        await expect(
            new CodexContextCatalogClient({ createClient: () => invalidUtf8 }).readSkillFileContents({
                path: "/trusted/review/SKILL.md",
            }),
        ).rejects.toThrow("valid UTF-8");
        await expect(
            new CodexContextCatalogClient({ createClient: () => oversized }).readSkillFileContents({
                path: "/trusted/review/SKILL.md",
                maxBytes: 4,
            }),
        ).rejects.toThrow("maximum supported size");
    });

    it("reads remote plugin skill contents through plugin/skill/read", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method === "plugin/skill/read")
            {
                expect(params).toEqual({
                    remoteMarketplaceName: "openai-curated-remote",
                    remotePluginId: "plugin-123",
                    skillName: "review",
                });
                return { contents: "# Remote review" };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(
            client.readRemotePluginSkillContents({
                remoteMarketplaceName: "openai-curated-remote",
                remotePluginId: "plugin-123",
                skillName: "review",
                maxBytes: 512,
            }),
        ).resolves.toBe("# Remote review");
    });

    it("preserves remote skill missing responses and bounds remote contents", async () =>
    {
        const missing = new CatalogMockClient((method) =>
        {
            if (method === "plugin/skill/read")
            {
                return { contents: null };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const oversized = new CatalogMockClient((method) =>
        {
            if (method === "plugin/skill/read")
            {
                return { contents: "too large" };
            }
            throw new Error(`unexpected method: ${method}`);
        });

        await expect(
            new CodexContextCatalogClient({ createClient: () => missing }).readRemotePluginSkillContents({
                remoteMarketplaceName: "openai-curated-remote",
                remotePluginId: "plugin-123",
                skillName: "review",
            }),
        ).resolves.toBeNull();
        await expect(
            new CodexContextCatalogClient({
                createClient: () => oversized,
            }).readRemotePluginSkillContents({
                remoteMarketplaceName: "openai-curated-remote",
                remotePluginId: "plugin-123",
                skillName: "review",
                maxBytes: 4,
            }),
        ).rejects.toThrow("maximum supported size");
    });

    it("writes fixed enabled config actions with quoted dynamic key segments", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "config/read")
            {
                return {
                    config: {},
                    origins: {},
                    layers: [{
                        name: { type: "user", file: "/user/config.toml", profile: null },
                        version: "v1",
                        config: {},
                        disabledReason: null,
                    }],
                };
            }
            if (method === "config/batchWrite")
            {
                return {
                    status: "ok",
                    version: "v2",
                    filePath: "/user/config.toml",
                    overriddenMetadata: null,
                };
            }
            if (method === "config/mcpServer/reload")
            {
                return {};
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await client.setPluginEnabled({ cwd: "/repo", pluginId: "market.plugin", enabled: false });
        await client.setAppEnabled({ appId: "github.enterprise", enabled: true });
        await client.setMcpServerEnabled({ serverName: "corp.mcp", enabled: false });
        await client.setMcpServerEnabled({ serverName: 'corp."quoted"\\mcp', enabled: true });

        expect(mock.requests
            .filter(({ method }) => method === "config/batchWrite")
            .map(({ params }) => (params as { edits: Array<{ keyPath: string; value: unknown }> }).edits[0]))
            .toEqual([
                { keyPath: 'plugins."market.plugin".enabled', value: false, mergeStrategy: "upsert" },
                { keyPath: 'apps."github.enterprise".enabled', value: true, mergeStrategy: "upsert" },
                { keyPath: 'mcp_servers."corp.mcp".enabled', value: false, mergeStrategy: "upsert" },
                { keyPath: 'mcp_servers."corp.\\"quoted\\"\\\\mcp".enabled', value: true, mergeStrategy: "upsert" },
            ]);
        expect(mock.requests
            .filter(({ method }) => method === "config/batchWrite")
            .map(({ params }) => (params as { expectedVersion: string | null; reloadUserConfig: boolean }).expectedVersion))
            .toEqual(["v1", "v1", "v1", "v1"]);
        expect(mock.requests.filter(({ method }) => method === "config/mcpServer/reload")).toHaveLength(2);
    });

    it("reads management plugin details from the full catalog including uninstalled plugins", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method === "plugin/list")
            {
                expect(params).toEqual({ cwds: ["/repo"], forceRefetch: true });
                return {
                    marketplaceLoadErrors: [],
                    featuredPluginIds: [],
                    marketplaces: [{
                        name: "official",
                        path: null,
                        interface: null,
                        plugins: [{
                            id: "github@official",
                            name: "github",
                            installed: false,
                            enabled: false,
                            source: { type: "remote" },
                            interface: null,
                        }],
                    }],
                };
            }
            if (method === "plugin/read")
            {
                expect(params).toEqual({
                    remoteMarketplaceName: "official",
                    pluginName: "github",
                });
                return {
                    plugin: {
                        marketplaceName: "official",
                        marketplacePath: null,
                        summary: { id: "github@official", name: "github", installed: false, enabled: false },
                        shareUrl: null,
                        description: null,
                        skills: [{ name: "review", description: "Review", path: null, enabled: true }],
                        hooks: [],
                        apps: [{ id: "github", name: "GitHub", description: null, installUrl: null, category: null }],
                        appTemplates: [],
                        mcpServers: ["github-mcp"],
                        scheduledTasks: null,
                    },
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const details = await client.readPluginDetailsForManagement({ cwd: "/repo", forceRefetch: true });

        expect(details[0]?.summary.id).toBe("github@official");
        expect(details[0]?.skills).toHaveLength(1);
    });

    it("reads management plugin details with bounded concurrency", async () =>
    {
        const readResolvers: Array<() => void> = [];
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method === "plugin/list")
            {
                return {
                    marketplaceLoadErrors: [],
                    featuredPluginIds: [],
                    marketplaces: [{
                        name: "official",
                        path: null,
                        interface: null,
                        plugins: Array.from({ length: 7 }, (_, index) => ({
                            id: `plugin-${index + 1}@official`,
                            name: `plugin-${index + 1}`,
                            installed: true,
                            enabled: true,
                            source: { type: "remote" },
                            interface: null,
                        })),
                    }],
                };
            }
            if (method === "plugin/read")
            {
                const pluginName = (params as { pluginName: string }).pluginName;
                return new Promise((resolve) =>
                {
                    readResolvers.push(() =>
                        resolve({
                            plugin: {
                                marketplaceName: "official",
                                marketplacePath: null,
                                summary: {
                                    id: `${pluginName}@official`,
                                    name: pluginName,
                                    installed: true,
                                    enabled: true,
                                },
                                shareUrl: null,
                                description: null,
                                skills: [],
                                hooks: [],
                                apps: [],
                                appTemplates: [],
                                mcpServers: [],
                                scheduledTasks: null,
                            },
                        }),
                    );
                });
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const detailsPromise = client.readPluginDetailsForManagement({ cwd: "/repo" });
        await vi.waitFor(() =>
        {
            expect(mock.requests.filter(({ method }) => method === "plugin/read")).toHaveLength(6);
        });
        readResolvers.splice(0).forEach((resolve) => resolve());
        await vi.waitFor(() =>
        {
            expect(mock.requests.filter(({ method }) => method === "plugin/read")).toHaveLength(7);
        });
        readResolvers.splice(0).forEach((resolve) => resolve());
        await expect(detailsPromise).resolves.toHaveLength(7);
    });

    it("reads one resolved plugin detail without listing the catalog again", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method !== "plugin/read")
            {
                throw new Error(`unexpected method: ${method}`);
            }
            expect(params).toEqual({
                remoteMarketplaceName: "official",
                pluginName: "github",
            });
            return {
                plugin: {
                    marketplaceName: "official",
                    marketplacePath: null,
                    summary: { id: "github@official", name: "github", installed: false, enabled: false },
                    shareUrl: null,
                    description: "GitHub detail",
                    skills: [],
                    hooks: [],
                    apps: [],
                    appTemplates: [],
                    mcpServers: [],
                    scheduledTasks: null,
                },
            };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.readPluginDetailForManagement({
            remoteMarketplaceName: "official",
            pluginName: "github",
        })).resolves.toMatchObject({ description: "GitHub detail" });
        expect(mock.requests.map(({ method }) => method)).toEqual(["initialize", "plugin/read"]);
        await expect(client.readPluginDetailForManagement({
            marketplacePath: "/plugins",
            remoteMarketplaceName: "official",
            pluginName: "github",
        })).rejects.toThrow("exactly one marketplace locator");
    });

    it("returns a partial MCP action result when runtime reload fails after config write", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "config/read")
            {
                return {
                    config: {},
                    origins: {},
                    layers: [{
                        name: { type: "user", file: "/user/config.toml", profile: null },
                        version: "v1",
                        config: {},
                        disabledReason: null,
                    }],
                };
            }
            if (method === "config/batchWrite")
            {
                return {
                    status: "ok",
                    version: "v2",
                    filePath: "/user/config.toml",
                    overriddenMetadata: null,
                };
            }
            if (method === "config/mcpServer/reload")
            {
                throw new Error("reload failed with internal details");
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.setMcpServerEnabled({ serverName: "local", enabled: false }))
            .resolves.toMatchObject({ reloadStatus: "failed", response: { status: "ok" } });
    });

    it("does not reload MCP servers after a version-conflict write failure", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "config/read")
            {
                return {
                    config: {},
                    origins: {},
                    layers: [{
                        name: { type: "user", file: "/user/config.toml", profile: null },
                        version: "v1",
                        config: {},
                        disabledReason: null,
                    }],
                };
            }
            if (method === "config/batchWrite")
            {
                throw new Error("version conflict");
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.setMcpServerEnabled({ serverName: "local", enabled: false }))
            .rejects.toThrow("version conflict");
        expect(mock.requests.some(({ method }) => method === "config/mcpServer/reload")).toBe(false);
    });

    it("installs, uninstalls, writes skill config, and trims marketplace add params", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method === "plugin/install")
            {
                expect(params).toEqual({
                    remoteMarketplaceName: "official",
                    installAttemptId: "attempt-1",
                    pluginName: "github",
                });
                return { authPolicy: "none", appsNeedingAuth: [] };
            }
            if (method === "plugin/uninstall")
            {
                expect(params).toEqual({ pluginId: "github@official" });
                return {};
            }
            if (method === "skills/config/write")
            {
                expect(params).toEqual({
                    path: "/skills/writer/SKILL.md",
                    enabled: false,
                });
                return { effectiveEnabled: false };
            }
            if (method === "marketplace/add")
            {
                expect(params).toEqual({
                    source: "owner/repo",
                    refName: "main",
                    sparsePaths: ["plugins", "skills"],
                });
                return {
                    marketplaceName: "owner/repo",
                    installedRoot: "/marketplaces/owner-repo",
                    alreadyAdded: false,
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await client.installPlugin({
            remoteMarketplaceName: "official",
            installAttemptId: "attempt-1",
            pluginName: "github",
        });
        await client.uninstallPlugin({ pluginId: "github@official" });
        await client.setSkillEnabled({ path: "/skills/writer/SKILL.md", enabled: false });
        await client.addMarketplace({
            source: " owner/repo ",
            refName: " main ",
            sparsePaths: [" plugins ", "", "skills"],
        });
    });

    it("reads MCP management snapshot with config, status summaries, and installed plugin details", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "config/read")
            {
                return { config: { mcp_servers: {} }, origins: {}, layers: null };
            }
            if (method === "mcpServerStatus/list")
            {
                return { data: [mcpStatus("plain")], nextCursor: null };
            }
            if (method === "plugin/installed")
            {
                return {
                    marketplaceLoadErrors: [],
                    marketplaces: [{
                        name: "local",
                        path: "/market/local",
                        interface: null,
                        plugins: [{
                            id: "sample",
                            name: "sample",
                            installed: true,
                            enabled: true,
                            source: { type: "local", path: "/plugins/sample" },
                            interface: null,
                        }],
                    }],
                };
            }
            if (method === "plugin/read")
            {
                return {
                    plugin: {
                        marketplaceName: "local",
                        marketplacePath: "/market/local",
                        summary: { id: "sample", name: "sample", installed: true, enabled: true },
                        shareUrl: null,
                        description: null,
                        skills: [],
                        hooks: [],
                        apps: [],
                        appTemplates: [],
                        mcpServers: ["plugin-server"],
                        scheduledTasks: null,
                    },
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const snapshot = await client.readMcpManagementSnapshot({ cwd: "/repo", threadId: "thread-1" });

        expect(snapshot.servers).toEqual([{
            name: "plain",
            connected: true,
            authStatus: "oAuth",
            toolCount: 1,
        }]);
        expect(snapshot.pluginDetails.map((plugin) => plugin.mcpServers)).toEqual([["plugin-server"]]);
        expect(mock.requests.find(({ method }) => method === "config/read")?.params).toEqual({
            includeLayers: true,
            cwd: "/repo",
        });
        expect(mock.requests.find(({ method }) => method === "plugin/read")?.params).toEqual({
            marketplacePath: "/market/local",
            pluginName: "sample",
        });
    });

    it("auto-pages apps and filters inaccessible or disabled entries", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            expect(method).toBe("app/list");
            const request = params as { cursor?: string; threadId?: string | null };
            expect(request.threadId).toBeNull();
            const cursor = request.cursor;
            return cursor
                ? {
                    data: [{
                        id: "disabled",
                        name: "Disabled",
                        description: null,
                        logoUrl: null,
                        logoUrlDark: null,
                        isEnabled: false,
                        isAccessible: true,
                        pluginDisplayNames: [],
                    }],
                    nextCursor: null,
                }
                : {
                    data: [{
                        id: "github",
                        name: "GitHub",
                        description: "Repositories",
                        logoUrl: "https://example.com/github.png",
                        logoUrlDark: null,
                        isEnabled: true,
                        isAccessible: true,
                        pluginDisplayNames: ["GitHub Plugin"],
                    }],
                    nextCursor: "page-2",
                };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listApps({ threadId: null, pageSize: 1 })).resolves.toEqual([{
            id: "github",
            name: "GitHub",
            mentionName: "github",
            pluginDisplayNames: ["GitHub Plugin"],
            description: "Repositories",
            logoUrl: "https://example.com/github.png",
            mentionPath: "app://github",
            enabled: true,
            accessible: true,
        }]);
    });

    it("normalizes app mention names and falls back to the app id", async () =>
    {
        const mock = new CatalogMockClient(() => ({
            data: [
                {
                    id: "enterprise",
                    name: "  GitHub ++ Enterprise!  ",
                    description: null,
                    logoUrl: null,
                    logoUrlDark: null,
                    isEnabled: true,
                    isAccessible: true,
                },
                {
                    id: "fallback-app",
                    name: "!!!",
                    description: null,
                    logoUrl: null,
                    logoUrlDark: null,
                    isEnabled: true,
                    isAccessible: true,
                },
            ],
            nextCursor: null,
        }));
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listApps()).resolves.toMatchObject([
            {
                id: "enterprise",
                name: "  GitHub ++ Enterprise!  ",
                mentionName: "github-enterprise",
                mentionPath: "app://enterprise",
            },
            {
                id: "fallback-app",
                name: "!!!",
                mentionName: "fallback-app",
                mentionPath: "app://fallback-app",
            },
        ]);
    });

    it("lists MCP server status with tools-and-auth detail and returns safe summaries", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            expect(method).toBe("mcpServerStatus/list");
            expect(params).toEqual({
                limit: 25,
                detail: "toolsAndAuthOnly",
                threadId: "thread-1",
            });
            return {
                data: [
                    mcpStatus("connected-server"),
                    mcpStatus("auth-only-server", {
                        serverInfo: null,
                        tools: {},
                        resources: [],
                        resourceTemplates: [],
                        authStatus: "notLoggedIn",
                    }),
                ],
                nextCursor: null,
            };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        const result = await client.listMcpServerStatus({ threadId: "thread-1", pageSize: 25 });

        expect(result).toEqual([
            {
                name: "connected-server",
                connected: true,
                authStatus: "oAuth",
                toolCount: 1,
            },
            {
                name: "auth-only-server",
                connected: false,
                authStatus: "notLoggedIn",
                toolCount: 0,
            },
        ]);
        expect(Object.keys(result[0] ?? {})).toEqual([
            "name",
            "connected",
            "authStatus",
            "toolCount",
        ]);
        expect(JSON.stringify(result)).not.toContain("private");
        expect(JSON.stringify(result)).not.toContain("secret://");
    });

    it("auto-pages MCP server status and advances cursors", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            expect(method).toBe("mcpServerStatus/list");
            const request = params as { cursor?: string; limit?: number; detail?: string };
            expect(request.limit).toBe(1);
            expect(request.detail).toBe("toolsAndAuthOnly");
            return request.cursor
                ? {
                    data: [mcpStatus("second", {
                        serverInfo: null,
                        tools: { second_tool: { name: "second_tool" } },
                        authStatus: "bearerToken",
                    })],
                    nextCursor: null,
                }
                : {
                    data: [mcpStatus("first", {
                        tools: {},
                        authStatus: "unsupported",
                    })],
                    nextCursor: "page-2",
                };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listMcpServerStatus({ pageSize: 1 })).resolves.toEqual([
            {
                name: "first",
                connected: true,
                authStatus: "unsupported",
                toolCount: 0,
            },
            {
                name: "second",
                connected: true,
                authStatus: "bearerToken",
                toolCount: 1,
            },
        ]);
        expect(mock.requests
            .filter(({ method }) => method === "mcpServerStatus/list")
            .map(({ params }) => (params as { cursor?: string }).cursor)).toEqual([
            undefined,
            "page-2",
        ]);
    });

    it("rejects MCP server status pagination when the cursor does not advance", async () =>
    {
        const mock = new CatalogMockClient(() => ({
            data: [],
            nextCursor: "same-cursor",
        }));
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.listMcpServerStatus()).rejects.toThrow(
            "mcpServerStatus/list returned the same pagination cursor twice.",
        );
        expect(mock.requests
            .filter(({ method }) => method === "mcpServerStatus/list")
            .map(({ params }) => (params as { cursor?: string }).cursor)).toEqual([
            undefined,
            "same-cursor",
        ]);
    });

    it("recreates the catalog connection after a transport request fails", async () =>
    {
        const clients: CatalogMockClient[] = [];
        const client = new CodexContextCatalogClient({
            createClient: () =>
            {
                const attempt = clients.length;
                const mock = new CatalogMockClient((method) =>
                {
                    expect(method).toBe("skills/list");
                    if (attempt === 0)
                    {
                        throw new Error("transport closed");
                    }
                    return { data: [] };
                });
                clients.push(mock);
                return mock;
            },
        });

        await expect(client.listSkills({ cwd: "/repo" })).rejects.toThrow("transport closed");
        await expect(client.listSkills({ cwd: "/repo" })).resolves.toEqual([]);
        expect(clients).toHaveLength(2);
        expect(clients[0]?.disconnectCount).toBe(1);
        expect(clients[1]?.connectCount).toBe(1);
    });

    it("uses a reusable app-server fuzzy file search session and notification updates", async () =>
    {
        const mock = new CatalogMockClient((method, value) =>
        {
            if (method === "fuzzyFileSearch/sessionStart")
            {
                expect(value).toMatchObject({ roots: ["/repo"] });
                return {};
            }
            if (method === "fuzzyFileSearch/sessionUpdate")
            {
                return {};
            }
            if (method === "fuzzyFileSearch/sessionStop")
            {
                return {};
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });
        const updated: Array<{ query: string; path: string }> = [];
        const completed: string[] = [];
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: (files, query) => updated.push({ query, path: files[0]?.path ?? "" }),
            onCompleted: (query) => completed.push(query),
        });

        await session.update("one");
        await session.update("two");
        const sessionId = (mock.requests.find(({ method }) =>
            method === "fuzzyFileSearch/sessionStart")?.params as { sessionId: string }).sessionId;
        mock.emitNotification("fuzzyFileSearch/sessionUpdated", {
            sessionId,
            query: "two",
            files: [fuzzyFile("two.ts")],
        });
        mock.emitNotification("fuzzyFileSearch/sessionCompleted", { sessionId });
        await session.stop();
        await session.update("ignored");

        expect(updated).toEqual([{ query: "two", path: "two.ts" }]);
        expect(completed).toEqual(["two"]);
        expect(mock.requests.map(({ method }) => method)).toEqual([
            "initialize",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionStop",
        ]);
        expect(mock.requests.filter(({ method }) => method === "fuzzyFileSearch")).toHaveLength(0);
        expect(mock.requests[2]?.params).toMatchObject({
            sessionId,
            query: "one",
        });
        expect(mock.requests[3]?.params).toMatchObject({
            sessionId,
            query: "two",
        });
    });

    it("keeps one leased connection for a fuzzy file search session with per-operation lifecycle", async () =>
    {
        const clients: CatalogMockClient[] = [];
        const client = new CodexContextCatalogClient({
            connectionLifecycle: "per-operation",
            createClient: () =>
            {
                const mock = new CatalogMockClient((method) =>
                {
                    if (
                        method === "fuzzyFileSearch/sessionStart" ||
                        method === "fuzzyFileSearch/sessionUpdate" ||
                        method === "fuzzyFileSearch/sessionStop"
                    )
                    {
                        return {};
                    }
                    throw new Error(`unexpected method: ${method}`);
                });
                clients.push(mock);
                return mock;
            },
        });
        const updated = vi.fn();
        const completed = vi.fn();
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: updated,
            onCompleted: completed,
        });

        await session.update("needle");
        const mock = clients[0];
        const sessionId = (mock?.requests.find(({ method }) =>
            method === "fuzzyFileSearch/sessionStart")?.params as { sessionId: string }).sessionId;
        mock?.emitNotification("fuzzyFileSearch/sessionUpdated", {
            sessionId,
            query: "needle",
            files: [fuzzyFile("needle.ts")],
        });
        await session.stop();

        expect(clients).toHaveLength(1);
        expect(mock?.connectCount).toBe(1);
        expect(mock?.disconnectCount).toBe(1);
        expect(mock?.requests.map(({ method }) => method)).toEqual([
            "initialize",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionStop",
        ]);
        expect(updated).toHaveBeenCalledWith([
            expect.objectContaining({ path: "needle.ts" }),
        ], "needle");
        expect(completed).not.toHaveBeenCalled();
    });

    it("falls back to legacy fuzzyFileSearch when session methods are unsupported", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "fuzzyFileSearch/sessionStart")
            {
                throw new JsonRpcError({
                    code: -32601,
                    message: "method not found: fuzzyFileSearch/sessionStart",
                });
            }
            if (method === "fuzzyFileSearch")
            {
                return { files: [fuzzyFile("needle.ts")] };
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });
        const updated = vi.fn();
        const completed = vi.fn();
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: updated,
            onCompleted: completed,
        });

        await session.update("needle");
        await session.stop();

        expect(updated).toHaveBeenCalledWith([
            expect.objectContaining({ path: "needle.ts" }),
        ], "needle");
        expect(completed).toHaveBeenCalledWith("needle");
        expect(mock.requests.map(({ method }) => method)).toEqual([
            "initialize",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch",
        ]);
        expect(mock.requests.at(-1)?.params).toMatchObject({
            query: "needle",
            roots: ["/repo"],
            cancellationToken: "vscode-fuzzy-file-search",
        });
    });

    it("reconnects, restarts the fuzzy session, and replays an update after transport loss", async () =>
    {
        const clients: CatalogMockClient[] = [];
        const client = new CodexContextCatalogClient({
            createClient: () =>
            {
                const attempt = clients.length;
                const mock = new CatalogMockClient((method) =>
                {
                    if (method === "fuzzyFileSearch/sessionStart")
                    {
                        return {};
                    }
                    if (method === "fuzzyFileSearch/sessionUpdate")
                    {
                        if (attempt === 0)
                        {
                            throw new Error("transport closed");
                        }
                        return {};
                    }
                    throw new Error(`unexpected method: ${method}`);
                });
                clients.push(mock);
                return mock;
            },
        });
        const updated = vi.fn();
        const completed = vi.fn();
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: updated,
            onCompleted: completed,
        });

        await session.update("needle");
        const sessionId = (clients[1]?.requests.find(({ method }) =>
            method === "fuzzyFileSearch/sessionStart")?.params as { sessionId: string }).sessionId;
        clients[1]?.emitNotification("fuzzyFileSearch/sessionUpdated", {
            sessionId,
            query: "needle",
            files: [fuzzyFile("needle.ts")],
        });
        clients[1]?.emitNotification("fuzzyFileSearch/sessionCompleted", { sessionId });

        expect(clients).toHaveLength(2);
        expect(clients[0]?.disconnectCount).toBe(1);
        expect(clients[1]?.requests.map(({ method }) => method)).toEqual([
            "initialize",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionUpdate",
        ]);
        expect(updated).toHaveBeenCalledWith([
            expect.objectContaining({ path: "needle.ts" }),
        ], "needle");
        expect(completed).toHaveBeenCalledWith("needle");
    });

    it("propagates fuzzy search protocol errors without reconnecting around them", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (method === "fuzzyFileSearch/sessionStart")
            {
                return {};
            }
            throw new JsonRpcError({ code: -32602, message: "invalid roots" });
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: () => undefined,
            onCompleted: () => undefined,
        });

        await expect(session.update("needle")).rejects.toMatchObject({
            code: -32602,
            message: "invalid roots",
        });
        expect(mock.disconnectCount).toBe(0);
        expect(mock.requests.filter(({ method }) => method === "fuzzyFileSearch/sessionUpdate")).toHaveLength(1);
    });

    it("suppresses fuzzy session notifications after catalog shutdown", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            if (
                method === "fuzzyFileSearch/sessionStart" ||
                method === "fuzzyFileSearch/sessionUpdate" ||
                method === "fuzzyFileSearch/sessionStop"
            )
            {
                return {};
            }
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });
        const updated = vi.fn();
        const completed = vi.fn();
        const session = await client.createFuzzyFileSearchSession({
            roots: ["/repo"],
            onUpdated: updated,
            onCompleted: completed,
        });

        await session.update("needle");
        const sessionId = (mock.requests.find(({ method }) =>
            method === "fuzzyFileSearch/sessionStart")?.params as { sessionId: string }).sessionId;
        await client.shutdown();
        mock.emitNotification("fuzzyFileSearch/sessionUpdated", {
            sessionId,
            query: "needle",
            files: [fuzzyFile("needle.ts")],
        });
        mock.emitNotification("fuzzyFileSearch/sessionCompleted", { sessionId });

        expect(updated).not.toHaveBeenCalled();
        expect(completed).not.toHaveBeenCalled();
        expect(mock.requests.map(({ method }) => method)).toEqual([
            "initialize",
            "fuzzyFileSearch/sessionStart",
            "fuzzyFileSearch/sessionUpdate",
            "fuzzyFileSearch/sessionStop",
        ]);
        expect(mock.disconnectCount).toBe(1);
    });

    it("reads exact app metadata in app/read batches with missing ids and tool summaries", async () =>
    {
        const mock = new CatalogMockClient((method, params) =>
        {
            if (method !== "app/read")
            {
                throw new Error(`unexpected method: ${method}`);
            }
            const appIds = (params as { appIds: string[] }).appIds;
            return {
                apps: appIds
                    .filter((id) => id !== "missing-app")
                    .map((id) => ({
                        id,
                        name: `App ${id}`,
                        toolSummaries: id === "app-100"
                            ? [{
                                name: "lookup",
                                title: "Lookup",
                                description: "Find a record",
                                isEnabled: false,
                                disabledReason: "disabled_by_admin",
                                readOnly: true,
                            }]
                            : [],
                    })),
                missingAppIds: appIds.includes("missing-app") ? ["missing-app"] : [],
            };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });
        const appIds = Array.from({ length: 101 }, (_, index) => `app-${index}`);

        const result = await client.readAppsForManagement({
            appIds: [...appIds, "app-0", "missing-app"],
            threadId: "thread-1",
            includeTools: true,
        });

        expect(result.apps).toHaveLength(101);
        expect(result.missingAppIds).toEqual(["missing-app"]);
        expect(result.apps.find((app) => app.id === "app-100")?.toolSummaries).toEqual([{
            name: "lookup",
            title: "Lookup",
            description: "Find a record",
            isEnabled: false,
            disabledReason: "disabled_by_admin",
            readOnly: true,
        }]);
        expect(mock.requests.filter(({ method }) => method === "app/read").map(({ params }) => params))
            .toEqual([
                { appIds: appIds.slice(0, 100), threadId: "thread-1", includeTools: true },
                { appIds: [...appIds.slice(100), "missing-app"], threadId: "thread-1", includeTools: true },
            ]);
        await client.shutdown();
    });

    it("reads an empty app set without calling app/read", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            throw new Error(`unexpected method: ${method}`);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.readAppsForManagement({ appIds: ["", ""] })).resolves.toEqual({
            apps: [],
            missingAppIds: [],
        });
        expect(mock.requests).toEqual([]);
        await client.shutdown();
    });

    it("propagates app/read protocol errors", async () =>
    {
        const error = new JsonRpcError({ code: -32_602, message: "Invalid app/read params" });
        const mock = new CatalogMockClient((method) =>
        {
            if (method !== "app/read")
            {
                throw new Error(`unexpected method: ${method}`);
            }
            return Promise.reject(error);
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.readAppsForManagement({ appIds: ["bad-app"] })).rejects.toBe(error);
        await client.shutdown();
    });

    it("exposes a safe config/read entry for management", async () =>
    {
        const configResponse = {
            config: { apps: { github: { enabled: true } } },
            origins: {
                "apps.\"github\".enabled": {
                    name: { type: "user", file: "/user/config.toml", profile: null },
                    value: true,
                },
            },
            layers: [],
        };
        const mock = new CatalogMockClient((method) =>
        {
            if (method !== "config/read")
            {
                throw new Error(`unexpected method: ${method}`);
            }
            return configResponse;
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.readConfigForManagement({ cwd: "/repo" })).resolves.toBe(configResponse);
        expect(mock.requests.at(-1)).toEqual({
            method: "config/read",
            params: {
                includeLayers: true,
                cwd: "/repo",
            },
        });
        await client.shutdown();
    });

    it("searches threads with the reference parameters and normalizes results", async () =>
    {
        const mock = new CatalogMockClient((method) =>
        {
            expect(method).toBe("thread/search");
            return {
                data: [{
                    snippet: "matching history",
                    thread: {
                        id: "thread-1",
                        name: "Task title",
                        preview: "preview",
                        cwd: "/repo",
                        updatedAt: 1_700_000_000,
                        gitInfo: { branch: "feature/search" },
                        source: "appServer",
                        threadSource: "desktop",
                        parentThreadId: null,
                    },
                }],
                nextCursor: null,
                backwardsCursor: null,
            };
        });
        const client = new CodexContextCatalogClient({ createClient: () => mock });

        await expect(client.searchThreads({ query: "needle" })).resolves.toEqual([{
            threadId: "thread-1",
            name: "Task title",
            preview: "preview",
            snippet: "matching history",
            cwd: "/repo",
            updatedAt: "2023-11-14T22:13:20.000Z",
            branch: "feature/search",
            source: "appServer",
            threadSource: "desktop",
            archived: false,
        }]);
        expect(mock.requests.at(-1)).toEqual({
            method: "thread/search",
            params: {
                searchTerm: "needle",
                limit: 50,
                sortKey: "updated_at",
                sortDirection: "desc",
                archived: false,
            },
        });
    });
});
