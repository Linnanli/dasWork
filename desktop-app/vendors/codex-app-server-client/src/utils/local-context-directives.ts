import { isAbsolute } from "node:path";

export type LocalContextDirectiveType = "file" | "folder";

export interface LocalContextReference
{
    type: LocalContextDirectiveType;
    label: string;
    path: string;
}

export interface ExtractedLocalContext
{
    text: string;
    references: LocalContextReference[];
}

export interface RestoredLocalContext
{
    text: string;
    references: LocalContextReference[];
}

const DIRECTIVE_RE = /:(file|folder)\[([^\]\n]{1,1024})\]\{name=([^}\n]{1,1024})\}/gu;
const FILES_MENTIONED_HEADER = "# Files mentioned by the user:\n\n";
const MY_REQUEST_DELIMITER = "\n\n## My request for Codex:\n";
const HISTORY_ENTRY_RE = /^## (".*"): (".*")$/u;

/**
 * Extract valid local file/folder directives from composer text. Invalid or
 * relative-path directives deliberately remain user-visible text.
 */
export function extractLocalContextDirectives(text: string): ExtractedLocalContext
{
    const references: LocalContextReference[] = [];
    const paths = new Set<string>();
    let body = "";
    let lastIndex = 0;

    for (const match of text.matchAll(DIRECTIVE_RE))
    {
        const type = match[1] as LocalContextDirectiveType | undefined;
        const label = match[2];
        const path = match[3];
        if (!type || !label || !path)
        {
            continue;
        }

        const decodedLabel = decodeDirectiveField(label);
        const decodedPath = decodeDirectiveField(path);
        if (!decodedLabel || !isAbsolute(decodedPath))
        {
            continue;
        }

        body += text.slice(lastIndex, match.index);
        lastIndex = match.index + match[0].length;

        if (!paths.has(decodedPath))
        {
            paths.add(decodedPath);
            references.push({ type, label: decodedLabel, path: decodedPath });
        }
    }

    if (lastIndex === 0)
    {
        return { text, references };
    }

    return { text: body + text.slice(lastIndex), references };
}

/**
 * Add local file and folder references to the plain-text protocol context.
 * The JSON string encoding keeps labels and paths unambiguous in history.
 */
export function buildFilesMentionedContext(
    references: readonly LocalContextReference[],
    request: string,
): string
{
    if (references.length === 0)
    {
        return request;
    }

    const entries = references
        .map((reference) => `## ${JSON.stringify(reference.label)}: ${JSON.stringify(reference.path)}`)
        .join("\n\n");

    return `${FILES_MENTIONED_HEADER}${entries}${MY_REQUEST_DELIMITER}${request}`;
}

/**
 * Restore a complete Files mentioned prefix into composer directives. The
 * protocol does not persist file-vs-folder type, so history without client
 * attachment metadata intentionally degrades to the generic file directive.
 */
export function restoreFilesMentionedContext(text: string): RestoredLocalContext
{
    const parsed = parseFilesMentionedContext(text);
    if (!parsed)
    {
        return { text, references: [] };
    }

    const directives = parsed.references
        .map((reference) => serializeLocalContextDirective({ ...reference, type: "file" }))
        .join("\n");
    const restoredText = parsed.request
        ? `${directives}\n${parsed.request}`
        : directives;

    return { text: restoredText, references: parsed.references };
}

export function serializeLocalContextDirective(reference: LocalContextReference): string
{
    return `:${reference.type}[${encodeURIComponent(reference.label)}]{name=${encodeURIComponent(reference.path)}}`;
}

function decodeDirectiveField(value: string): string
{
    try
    {
        return decodeURIComponent(value);
    }
    catch
    {
        // Older composer drafts may have stored raw, rather than URI-encoded,
        // values. Keep those values available when they are otherwise valid.
        return value;
    }
}

function parseFilesMentionedContext(
    text: string,
): { references: LocalContextReference[]; request: string; } | null
{
    if (!text.startsWith(FILES_MENTIONED_HEADER))
    {
        return null;
    }

    const delimiterIndex = text.indexOf(MY_REQUEST_DELIMITER, FILES_MENTIONED_HEADER.length);
    if (delimiterIndex < 0)
    {
        return null;
    }

    const entriesText = text.slice(FILES_MENTIONED_HEADER.length, delimiterIndex);
    if (!entriesText)
    {
        return null;
    }

    const paths = new Set<string>();
    const references: LocalContextReference[] = [];
    for (const entry of entriesText.split("\n\n"))
    {
        const match = HISTORY_ENTRY_RE.exec(entry);
        const label = match?.[1];
        const path = match?.[2];
        if (!label || !path)
        {
            return null;
        }

        const parsedLabel = parseJsonString(label);
        const parsedPath = parseJsonString(path);
        if (!parsedLabel || !parsedPath || !isAbsolute(parsedPath))
        {
            return null;
        }

        if (!paths.has(parsedPath))
        {
            paths.add(parsedPath);
            references.push({ type: "file", label: parsedLabel, path: parsedPath });
        }
    }

    if (references.length === 0)
    {
        return null;
    }

    return {
        references,
        request: text.slice(delimiterIndex + MY_REQUEST_DELIMITER.length),
    };
}

function parseJsonString(value: string): string | null
{
    try
    {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "string" ? parsed : null;
    }
    catch
    {
        return null;
    }
}
