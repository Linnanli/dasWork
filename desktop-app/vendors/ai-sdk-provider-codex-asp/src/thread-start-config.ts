import type { JsonValue } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/serde_json/JsonValue";

import type {
    CodexCustomModelProviderSettings,
    CodexModelProviderInfo,
    CodexProviderSettings,
} from "./provider-settings";
import { stripUndefined } from "./utils/object";

export function stripModelProviderInfo(provider: CodexModelProviderInfo): Record<string, JsonValue>
{
    const info: Record<string, JsonValue> = {};
    setJsonField(info, "name", provider.name);
    setJsonField(info, "base_url", provider.base_url);
    setJsonField(info, "env_key", provider.env_key);
    setJsonField(info, "env_key_instructions", provider.env_key_instructions);
    setJsonField(info, "experimental_bearer_token", provider.experimental_bearer_token);
    setJsonField(info, "wire_api", provider.wire_api);
    setJsonField(info, "query_params", provider.query_params);
    setJsonField(info, "http_headers", provider.http_headers);
    setJsonField(info, "env_http_headers", provider.env_http_headers);
    setJsonField(info, "request_max_retries", provider.request_max_retries);
    setJsonField(info, "stream_max_retries", provider.stream_max_retries);
    setJsonField(info, "stream_idle_timeout_ms", provider.stream_idle_timeout_ms);
    setJsonField(info, "websocket_connect_timeout_ms", provider.websocket_connect_timeout_ms);
    setJsonField(info, "requires_openai_auth", provider.requires_openai_auth);
    setJsonField(info, "supports_websockets", provider.supports_websockets);
    return info;
}

function setJsonField(
    target: Record<string, JsonValue>,
    key: string,
    value: JsonValue | undefined,
): void
{
    if (value !== undefined)
    {
        target[key] = value;
    }
}

export function resolveCustomModelProviderSettings(
    providerSettings: Readonly<CodexProviderSettings>,
    modelSettings: CodexCustomModelProviderSettings,
): { modelProvider?: string; config?: Record<string, JsonValue | undefined> }
{
    const customModelProviders = {
        ...providerSettings.customModelProviders,
        ...modelSettings.customModelProviders,
    };
    const providerEntries = Object.entries(customModelProviders);

    if (providerEntries.length === 0)
    {
        return {};
    }

    const modelProvider = modelSettings.modelProvider
        ?? providerSettings.modelProvider
        ?? (providerEntries.length === 1 ? providerEntries[0]?.[0] : undefined);

    const modelProvidersConfig = Object.fromEntries(
        providerEntries.map(([providerId, provider]) => [
            providerId,
            stripModelProviderInfo(provider),
        ]),
    ) as Record<string, JsonValue>;

    const resolved: { modelProvider?: string; config?: Record<string, JsonValue | undefined> } = {
        config: stripUndefined({
            model_provider: modelProvider,
            model_providers: modelProvidersConfig,
        }),
    };

    if (modelProvider)
    {
        resolved.modelProvider = modelProvider;
    }

    return resolved;
}

export function mergeThreadConfig(
    ...configs: Array<Record<string, JsonValue | undefined> | undefined>
): Record<string, JsonValue | undefined> | undefined
{
    const merged: Record<string, JsonValue | undefined> = {};
    for (const config of configs)
    {
        if (config)
        {
            Object.assign(merged, config);
        }
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
}
