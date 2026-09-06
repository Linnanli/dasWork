import { isAbsolute } from "node:path";

import type {
    CodexTurnInputItem,
    CodexTurnInputMention,
    CodexTurnInputSkill,
} from "../protocol/types";

export type ComposerContextDirectiveType =
    | "file"
    | "folder"
    | "chat"
    | "agent"
    | "agentRole"
    | "skill"
    | "app"
    | "plugin";

export interface ComposerContextDirective
{
    type: ComposerContextDirectiveType;
    label: string;
    path: string;
}

export interface ExtractedComposerContext
{
    text: string;
    inputs: Array<CodexTurnInputMention | CodexTurnInputSkill>;
    references: ComposerContextDirective[];
}

const DIRECTIVE_RE = /:([\w-]{1,64})\[([^\]\n]{1,1024})\]\{name=([^}\n]{1,4096})\}/gu;
const AGENT_ROLE_ALIASES = new Set(["agentRole", "agent-role", "configuredAgent", "configured-agent"]);

/**
 * Convert composer directives into app-server inputs.
 *
 * File and folder references are returned for the caller to place in the
 * existing plain-text "Files mentioned" context. Agent-like references remain
 * readable Markdown. Skills and app/plugin mentions become existing structured
 * app-server inputs; apps and plugins also keep Codex's canonical token.
 */
export function extractComposerContextDirectives(text: string): ExtractedComposerContext
{
    const inputs: Array<CodexTurnInputMention | CodexTurnInputSkill> = [];
    const references: ComposerContextDirective[] = [];
    const inputKeys = new Set<string>();
    let output = "";
    let lastIndex = 0;

    for (const match of text.matchAll(DIRECTIVE_RE))
    {
        const rawType = match[1];
        const rawLabel = match[2];
        const rawPath = match[3];
        if (!rawType || !rawLabel || !rawPath)
        {
            continue;
        }

        const type = normalizeDirectiveType(rawType);
        const label = decodeDirectiveField(rawLabel);
        const path = decodeDirectiveField(rawPath);
        if (!type || !label || !isValidDirectivePath(type, path))
        {
            continue;
        }

        output += text.slice(lastIndex, match.index);
        lastIndex = match.index + match[0].length;

        const reference = { type, label, path } satisfies ComposerContextDirective;
        references.push(reference);

        switch (type)
        {
            case "file":
            case "folder":
                break;
            case "chat":
            case "agent":
            case "agentRole":
                output += markdownLink(`@${label}`, path);
                break;
            case "skill": {
                const input = { type: "skill", name: label, path } satisfies CodexTurnInputSkill;
                appendUniqueInput(inputs, inputKeys, input);
                break;
            }
            case "app":
            case "plugin": {
                const name = label;
                const token = type === "app" ? `$${name}` : `@${name}`;
                output += token;
                const input = { type: "mention", name, path } satisfies CodexTurnInputMention;
                appendUniqueInput(inputs, inputKeys, input);
                break;
            }
            default:
                assertNever(type);
        }
    }

    if (lastIndex === 0)
    {
        return { text, inputs, references };
    }

    return {
        text: output + text.slice(lastIndex),
        inputs,
        references,
    };
}

/** Restore structured inputs and recognized Markdown links into composer directives. */
export function restoreComposerContextInputs(inputs: readonly CodexTurnInputItem[]): string
{
    let text = inputs
        .filter((entry): entry is Extract<CodexTurnInputItem, { type: "text" }> => entry.type === "text")
        .map((entry) => entry.text)
        .filter((entry) => entry.trim().length > 0)
        .join("\n");

    text = restoreMarkdownContextLinks(text);

    for (const input of inputs)
    {
        switch (input.type)
        {
            case "skill": {
                const directive = serializeComposerContextDirective({
                    type: "skill",
                    label: input.name,
                    path: input.path,
                });
                text = replaceCanonicalTokenOrAppend(text, `$${input.name}`, directive);
                break;
            }
            case "mention": {
                const normalizedPath = normalizeMentionPath(input.path);
                const type = directiveTypeForMentionPath(normalizedPath);
                if (!type)
                {
                    break;
                }
                const directive = serializeComposerContextDirective({
                    type,
                    label: input.name,
                    path: normalizedPath,
                });
                const token = type === "app" ? `$${input.name}` : `@${input.name}`;
                text = replaceCanonicalTokenOrAppend(text, token, directive);
                break;
            }
            case "text":
            case "image":
            case "localImage":
            case "audio":
            case "localAudio":
                break;
            default:
                assertNever(input);
        }
    }

    return text;
}

export function serializeComposerContextDirective(reference: ComposerContextDirective): string
{
    return `:${reference.type}[${encodeURIComponent(reference.label)}]{name=${encodeURIComponent(reference.path)}}`;
}

export function threadIdFromTaskReference(path: string): string | null
{
    let encodedId = "";
    if (path.startsWith("thread://"))
    {
        encodedId = path.slice("thread://".length);
    }
    else if (path.startsWith("codex:thread:"))
    {
        encodedId = path.slice("codex:thread:".length);
    }
    if (!encodedId)
    {
        return null;
    }
    const threadId = decodeDirectiveField(encodedId).trim();
    return threadId.length > 0 ? threadId : null;
}

function restoreMarkdownContextLinks(text: string): string
{
    return text.replace(
        /\[([^\]\n]{1,1024})\]\((?:<([^>\n]{1,4096})>|([^\s)\n]{1,4096}))(?:\s+"(dascowork-folder)")?\)/gu,
        (
            raw,
            rawLabel: string,
            anglePath: string | undefined,
            plainPath: string | undefined,
            marker: string | undefined,
        ) =>
        {
            const path = anglePath ?? plainPath ?? "";
            const type = marker === "dascowork-folder"
                ? "folder"
                : directiveTypeForMarkdownPath(path);
            if (!type)
            {
                return raw;
            }

            const label = rawLabel.startsWith("@") ? rawLabel.slice(1) : rawLabel;
            return serializeComposerContextDirective({ type, label, path });
        },
    );
}

function directiveTypeForMarkdownPath(path: string): ComposerContextDirectiveType | null
{
    if (path.startsWith("thread://"))
    {
        return "chat";
    }
    if (path.startsWith("agent://"))
    {
        return "agent";
    }
    if (path.startsWith("subagent://"))
    {
        return "agentRole";
    }
    if (isAbsolute(path))
    {
        return "file";
    }
    return null;
}

function normalizeMentionPath(path: string): string
{
    const legacyThreadPrefix = "codex://thread/";
    if (path.startsWith(legacyThreadPrefix) && path.length > legacyThreadPrefix.length)
    {
        return `thread://${path.slice(legacyThreadPrefix.length)}`;
    }
    return path;
}

function directiveTypeForMentionPath(
    path: string,
): "app" | "plugin" | "chat" | "agent" | "agentRole" | null
{
    if (path.startsWith("app://"))
    {
        return "app";
    }
    if (path.startsWith("plugin://"))
    {
        return "plugin";
    }
    if (path.startsWith("thread://"))
    {
        return "chat";
    }
    if (path.startsWith("agent://"))
    {
        return "agent";
    }
    if (path.startsWith("subagent://"))
    {
        return "agentRole";
    }
    return null;
}

function replaceCanonicalTokenOrAppend(text: string, token: string, directive: string): string
{
    const index = lastTokenIndex(text, token);
    if (index >= 0)
    {
        return `${text.slice(0, index)}${directive}${text.slice(index + token.length)}`;
    }

    if (text.length === 0 || /\s$/u.test(text))
    {
        return `${text}${directive}`;
    }
    return `${text}\n${directive}`;
}

function lastTokenIndex(text: string, token: string): number
{
    let fromIndex = text.length;
    while (fromIndex >= 0)
    {
        const index = text.lastIndexOf(token, fromIndex);
        if (index < 0)
        {
            return -1;
        }

        const before = index === 0 ? "" : text[index - 1] ?? "";
        const afterIndex = index + token.length;
        const after = afterIndex >= text.length ? "" : text[afterIndex] ?? "";
        if (!isTokenCharacter(before) && !isTokenCharacter(after))
        {
            return index;
        }
        fromIndex = index - 1;
    }
    return -1;
}

function isTokenCharacter(value: string): boolean
{
    return /[\p{L}\p{N}_-]/u.test(value);
}

function markdownLink(label: string, path: string): string
{
    const safeLabel = label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
    const destination = isAbsolute(path)
        ? `<${path.replaceAll(">", "%3E")}>`
        : path;
    return `[${safeLabel}](${destination})`;
}

function appendUniqueInput(
    inputs: Array<CodexTurnInputMention | CodexTurnInputSkill>,
    keys: Set<string>,
    input: CodexTurnInputMention | CodexTurnInputSkill,
): void
{
    const key = `${input.type}:${input.path}`;
    if (keys.has(key))
    {
        return;
    }
    keys.add(key);
    inputs.push(input);
}

function normalizeDirectiveType(value: string): ComposerContextDirectiveType | null
{
    if (AGENT_ROLE_ALIASES.has(value))
    {
        return "agentRole";
    }

    switch (value)
    {
        case "file":
        case "folder":
        case "chat":
        case "agent":
        case "skill":
        case "app":
        case "plugin":
            return value;
        case "thread":
            return "chat";
        default:
            return null;
    }
}

function isValidDirectivePath(type: ComposerContextDirectiveType, path: string): boolean
{
    switch (type)
    {
        case "file":
        case "folder":
        case "skill":
            return isAbsolute(path);
        case "chat":
            return threadIdFromTaskReference(path) !== null;
        case "agent":
            return path.startsWith("agent://") && path.length > "agent://".length;
        case "agentRole":
            return path.startsWith("subagent://") && path.length > "subagent://".length;
        case "app":
            return path.startsWith("app://") && path.length > "app://".length;
        case "plugin":
            return path.startsWith("plugin://") && path.length > "plugin://".length;
        default:
            return assertNever(type);
    }
}

function decodeDirectiveField(value: string): string
{
    try
    {
        return decodeURIComponent(value);
    }
    catch
    {
        return value;
    }
}

function assertNever(value: never): never
{
    throw new Error(`Unexpected composer context directive: ${String(value)}`);
}
