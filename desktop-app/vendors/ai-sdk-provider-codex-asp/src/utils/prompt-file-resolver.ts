import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ThreadReadResponse } from "@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/ThreadReadResponse";

import { CodexProviderError } from "../errors";
import type {
    CodexTurnInputItem,
    CodexTurnInputText,
} from "../protocol/types";
import {
    extractComposerContextDirectives,
    threadIdFromTaskReference,
} from "./context-codec";
import {
    buildFilesMentionedContext,
    type LocalContextReference,
} from "./local-context-directives";
import {
    buildReferencedTasksContext,
    normalizeReferencedTask,
    type ReferencedTaskContext,
} from "./task-reference-context";

export const LOCAL_FILE_ATTACHMENT_MEDIA_TYPE = "application/vnd.dascowork.local-file";
export const LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE = "application/vnd.dascowork.local-folder";

/**
 * Extracts system messages from the prompt and concatenates them into a single
 * string suitable for `developerInstructions` on `thread/start` or
 * `thread/resume`.  Returns `undefined` when no system content is present.
 */
export function mapSystemPrompt(prompt: LanguageModelV3Prompt): string | undefined
{
    const chunks: string[] = [];

    for (const message of prompt)
    {
        if (message.role === "system")
        {
            const text = message.content.trim();
            if (text.length > 0)
            {
                chunks.push(text);
            }
        }
    }

    return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

function textItem(text: string): CodexTurnInputText
{
    return { type: "text", text, text_elements: [] };
}

/**
 * Pluggable backend for persisting inline binary data so that the Codex
 * protocol can reference it by URL.
 *
 * Implement this interface to use a different storage backend (e.g. S3, GCS).
 *
 * - A `file:` URL maps to `{ type: "localImage", path }` in the Codex protocol.
 * - An `http(s):` URL maps to `{ type: "image", url }`.
 */
export interface FileWriter
{
    /** Persist `data` and return a URL that Codex can use to access it. */
    write(data: Uint8Array | string, mediaType: string): Promise<URL>;

    /**
     * Remove previously written files.  Best-effort — implementations should
     * never throw.
     */
    cleanup(urls: URL[]): Promise<void>;
}

const MEDIA_TYPE_TO_EXT: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
};

function extensionForMediaType(mediaType: string): string
{
    return MEDIA_TYPE_TO_EXT[mediaType] ?? ".bin";
}

/**
 * A {@link FileWriter} that writes to `os.tmpdir()` and returns `file:` URLs.
 */
export class LocalFileWriter implements FileWriter
{
    async write(data: Uint8Array | string, mediaType: string): Promise<URL>
    {
        const ext = extensionForMediaType(mediaType);
        const filename = `codex-ai-sdk-${randomUUID()}${ext}`;
        const filepath = join(tmpdir(), filename);

        const buffer = typeof data === "string"
            ? Buffer.from(base64Payload(data), "base64")
            : data;

        await writeFile(filepath, buffer);
        return pathToFileURL(filepath);
    }

    async cleanup(urls: URL[]): Promise<void>
    {
        await Promise.allSettled(
            urls
                .filter((u) => u.protocol === "file:")
                .map((u) => unlink(u)),
        );
    }
}

function base64Payload(data: string): string
{
    const marker = ";base64,";
    const markerIndex = data.indexOf(marker);
    if (!data.startsWith("data:") || markerIndex < 0)
    {
        return data;
    }

    return data.slice(markerIndex + marker.length);
}

/**
 * Resolves inline binary data in AI SDK prompts and maps user content to
 * {@link CodexTurnInputItem} arrays ready for `turn/start`.
 *
 * Instantiate with an optional custom {@link FileWriter} for non-local storage
 * (e.g. S3).  Tracks all written URLs so that {@link cleanup} can remove them
 * after the turn completes.
 *
 * @example
 * ```ts
 * const fileResolver = new PromptFileResolver();
 * const turnInput = await fileResolver.resolve(prompt, isResume);
 * // … after the turn …
 * await fileResolver.cleanup();
 * ```
 */
export class PromptFileResolver
{
    private readonly writer: FileWriter;
    private readonly written: URL[] = [];

    constructor(writer?: FileWriter)
    {
        this.writer = writer ?? new LocalFileWriter();
    }

    /**
     * Resolve inline file data and map user content to Codex input items.
     *
     * - Inline image data (base64 / Uint8Array) is written via the
     *   {@link FileWriter} and converted to `localImage` or `image` items.
     * - URL-based image file parts are converted directly.
     * - Inline text file data is decoded and inlined as text.
     * - DasCowork vendor file/folder parts with a `file:` URL are added to the
     *   existing plain-text "Files mentioned" context without reading or
     *   uploading bytes.
     * - Unsupported media types are silently skipped.
     *
     * Fresh and resumed turns both extract only the last user message. Text
     * input is always sent before images, whose source order is retained.
     */
    async resolve(
        prompt: LanguageModelV3Prompt,
        _isResume: boolean = false,
        taskOptions?: {
            activeThreadId?: string;
            loadTask(threadId: string): Promise<ThreadReadResponse>;
        },
    ): Promise<CodexTurnInputItem[]>
    {
        return this.resolveLastUserMessage(prompt, taskOptions);
    }

    /**
     * Remove all files created by previous {@link resolve} calls.
     * Best-effort — never throws.
     */
    async cleanup(): Promise<void>
    {
        const urls = this.written.splice(0);
        if (urls.length > 0)
        {
            await this.writer.cleanup(urls);
        }
    }

    /**
     * Convert a resolved image URL to a Codex input item.
     */
    private mapImageUrl(mediaType: string, data: URL): CodexTurnInputItem | null
    {
        if (!mediaType.startsWith("image/"))
        {
            return null;
        }

        if (data.protocol === "file:")
        {
            return { type: "localImage", path: fileURLToPath(data) };
        }

        return { type: "image", url: data.href };
    }

    /**
     * Resolve a single file part: write inline data via the writer, then
     * convert to a Codex input item.  Text files are decoded and returned
     * as text items.  Returns `null` for unsupported media types.
     */
    private async resolveFilePart(
        part: LanguageModelV3FilePart,
    ): Promise<CodexTurnInputItem | null>
    {
        const { mediaType, data } = part;

        // Text files → decode and inline as text.
        // URL text files pass through as the URL string — we don't fetch remote
        // content; the URL itself serves as a reference for the model.
        if (mediaType.startsWith("text/"))
        {
            if (data instanceof URL)
            {
                return textItem(data.href);
            }

            const text = typeof data === "string"
                ? Buffer.from(data, "base64").toString("utf-8")
                : new TextDecoder().decode(data);
            return textItem(text);
        }

        // Images with inline data → write via writer, then map the URL.
        if (mediaType.startsWith("image/") && !(data instanceof URL))
        {
            const url = await this.writer.write(data, mediaType);
            this.written.push(url);
            return this.mapImageUrl(mediaType, url);
        }

        // Images that already have a URL → map directly.
        if (data instanceof URL)
        {
            return this.mapImageUrl(mediaType, data);
        }

        return null;
    }

    private mapLocalAttachmentReference(part: LanguageModelV3FilePart): LocalContextReference | null
    {
        const type = part.mediaType === LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE ? "folder" : "file";
        if (type === "file" && part.mediaType !== LOCAL_FILE_ATTACHMENT_MEDIA_TYPE)
        {
            return null;
        }

        const url = part.data instanceof URL
            ? part.data
            : typeof part.data === "string" && part.data.startsWith("file:")
                ? new URL(part.data)
                : null;
        if (!url || url.protocol !== "file:")
        {
            return null;
        }

        const path = fileURLToPath(url);
        return {
            type,
            path,
            label: part.filename?.trim() || basename(path),
        };
    }

    private async resolveLastUserMessage(
        prompt: LanguageModelV3Prompt,
        taskOptions?: {
            activeThreadId?: string;
            loadTask(threadId: string): Promise<ThreadReadResponse>;
        },
    ): Promise<CodexTurnInputItem[]>
    {
        for (let i = prompt.length - 1; i >= 0; i--)
        {
            const message = prompt[i];

            if (message?.role === "user")
            {
                return this.resolveUserMessages([message], taskOptions);
            }
        }

        return [textItem("")];
    }

    private async resolveUserMessages(
        messages: readonly LanguageModelV3Prompt[number][],
        taskOptions?: {
            activeThreadId?: string;
            loadTask(threadId: string): Promise<ThreadReadResponse>;
        },
    ): Promise<CodexTurnInputItem[]>
    {
        const textChunks: string[] = [];
        const contextInputs: CodexTurnInputItem[] = [];
        const contextInputKeys = new Set<string>();
        const localReferences: LocalContextReference[] = [];
        const localReferencePaths = new Set<string>();
        const taskThreadIds = new Set<string>();
        const attachments: CodexTurnInputItem[] = [];

        for (const message of messages)
        {
            if (message.role !== "user")
            {
                continue;
            }

            for (const part of message.content)
            {
                if (part.type === "text")
                {
                    const extracted = extractComposerContextDirectives(part.text);
                    for (const input of extracted.inputs)
                    {
                        const key = `${input.type}:${input.path}`;
                        if (!contextInputKeys.has(key))
                        {
                            contextInputKeys.add(key);
                            contextInputs.push(input);
                        }
                    }

                    for (const reference of extracted.references)
                    {
                        if ((reference.type === "file" || reference.type === "folder")
                            && !localReferencePaths.has(reference.path))
                        {
                            localReferencePaths.add(reference.path);
                            localReferences.push({
                                type: reference.type,
                                label: reference.label,
                                path: reference.path,
                            });
                        }
                        if (reference.type === "chat")
                        {
                            const threadId = threadIdFromTaskReference(reference.path);
                            if (threadId && threadId !== taskOptions?.activeThreadId)
                            {
                                taskThreadIds.add(threadId);
                            }
                        }
                    }

                    const text = extracted.text.trim();
                    if (text.length > 0)
                    {
                        textChunks.push(text);
                    }
                }
                else if (part.type === "file")
                {
                    const localReference = this.mapLocalAttachmentReference(part);
                    if (localReference)
                    {
                        if (!localReferencePaths.has(localReference.path))
                        {
                            localReferencePaths.add(localReference.path);
                            localReferences.push(localReference);
                        }
                        continue;
                    }

                    const mapped = await this.resolveFilePart(part);
                    if (mapped?.type === "text")
                    {
                        textChunks.push(mapped.text);
                    }
                    else if (mapped)
                    {
                        attachments.push(mapped);
                    }
                }
            }
        }

        if (taskThreadIds.size > 3)
        {
            throw new CodexProviderError(
                "thread_reference_limit_exceeded: each message can reference at most 3 tasks",
            );
        }
        let referencedTasks: ReferencedTaskContext[] = [];
        if (taskThreadIds.size > 0)
        {
            if (!taskOptions)
            {
                throw new CodexProviderError(
                    "thread_reference_read_failed: task loader is unavailable",
                );
            }
            try
            {
                referencedTasks = await Promise.all(
                    [...taskThreadIds].map(async (threadId) =>
                        normalizeReferencedTask((await taskOptions.loadTask(threadId)).thread),
                    ),
                );
            }
            catch (error)
            {
                throw new CodexProviderError(
                    "thread_reference_read_failed: unable to load referenced task",
                    { cause: error },
                );
            }
        }
        const requestText = textChunks.join("\n\n");
        const filesText = buildFilesMentionedContext(localReferences, requestText);
        const text = buildReferencedTasksContext(
            referencedTasks,
            filesText,
            localReferences.length > 0,
        );
        return [textItem(text), ...contextInputs, ...attachments];
    }
}
