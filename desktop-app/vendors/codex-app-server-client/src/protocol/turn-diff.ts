import { isAbsolute, relative, sep } from "node:path";

import { stripUndefined } from "../utils/object";
import type { FileUpdateChange } from "./app-server-protocol/v2/FileUpdateChange";
import type { CodexRenderableThreadItem } from "./shared-item-extractors";

export const TURN_DIFF_PREVIEW_CHAR_LIMIT = 50_000;
export const TURN_DIFF_ACTION_PATCH_CHAR_LIMIT = 2 * 1024 * 1024;

export type TurnDiffPatchUnavailableReason = "missing-cwd" | "patch-too-large";

export interface TurnPatchBatch
{
    cwd: string;
    diff: string;
    gitRoot?: string;
}

export interface TurnDiffItem
{
    id: string;
    threadId?: string;
    type: "turnDiff";
    status: "inProgress" | "completed";
    cwd?: string;
    diff: string;
    truncated: boolean;
    originalLength?: number;
    patchBatches?: readonly TurnPatchBatch[];
    patchUnavailableReason?: TurnDiffPatchUnavailableReason;
}

export interface FileChangeDiffBatch
{
    changes: readonly FileUpdateChange[];
    cwd?: string | undefined;
}

interface VirtualLine
{
    origin?: number;
    text?: string;
}

interface VirtualFile
{
    originalPath: string;
    currentPath: string;
    originalExists: boolean;
    currentExists: boolean;
    original: VirtualLine[];
    current: VirtualLine[];
    originalByOrigin: Map<number, VirtualLine>;
    detachedByText: Map<string, VirtualLine[]>;
    nextOrigin: number;
}

interface UnifiedDiffHunk
{
    oldStart: number;
    oldCount: number;
    newCount: number;
    lines: string[];
}

/**
 * Derives action-patch batches from the stable order in a completed turn.
 * Commands advance the working directory for later file changes only when
 * they provide one, matching the Codex Electron recovery model.
 */
export function fileChangeDiffBatchesForOrderedItems(
    items: readonly CodexRenderableThreadItem[],
    initialCwd?: string,
): FileChangeDiffBatch[]
{
    const batches: FileChangeDiffBatch[] = [];
    let cwd = initialCwd;

    for (const item of items)
    {
        if (item.type === "commandExecution")
        {
            if (item.cwd)
            {
                cwd = item.cwd;
            }
            continue;
        }

        if (
            item.type === "fileChange" &&
            item.status !== "failed" &&
            item.status !== "declined" &&
            item.changes.length > 0
        )
        {
            batches.push({ changes: item.changes, cwd });
        }
    }

    return batches;
}

export function turnDiffItem({
    id,
    threadId,
    status,
    cwd,
    diff,
    patchBatches,
}: {
    id: string;
    threadId?: string | undefined;
    status: TurnDiffItem["status"];
    cwd?: string | undefined;
    diff: string;
    patchBatches?: readonly FileChangeDiffBatch[] | undefined;
}): TurnDiffItem
{
    const truncated = diff.length > TURN_DIFF_PREVIEW_CHAR_LIMIT;
    const actionPatch = status === "completed" && patchBatches
        ? turnPatchBatchesForFileChanges(patchBatches)
        : undefined;
    return stripUndefined({
        id,
        threadId,
        type: "turnDiff" as const,
        status,
        cwd,
        diff: truncated ? diff.slice(0, TURN_DIFF_PREVIEW_CHAR_LIMIT) : diff,
        truncated,
        originalLength: truncated ? diff.length : undefined,
        patchBatches: actionPatch?.patchBatches,
        patchUnavailableReason: actionPatch?.patchUnavailableReason,
    });
}

export function turnPatchBatchesForFileChanges(
    batches: readonly FileChangeDiffBatch[],
): { patchBatches?: readonly TurnPatchBatch[]; patchUnavailableReason?: TurnDiffPatchUnavailableReason }
{
    const patchBatches: TurnPatchBatch[] = [];
    let totalLength = 0;

    for (const batch of batches)
    {
        if (!batch.cwd)
        {
            return { patchUnavailableReason: "missing-cwd" };
        }

        const diff = unifiedDiffForFileChangeBatches([{ changes: batch.changes, cwd: batch.cwd }]);
        if (!diff)
        {
            continue;
        }

        totalLength += diff.length;
        if (totalLength > TURN_DIFF_ACTION_PATCH_CHAR_LIMIT)
        {
            return { patchUnavailableReason: "patch-too-large" };
        }

        patchBatches.push({ cwd: batch.cwd, diff });
    }

    return patchBatches.length > 0 ? { patchBatches } : {};
}

/**
 * Rebuild the turn-level unified diff from the persisted file-change items.
 * This mirrors the Codex Electron history fallback when no live turn diff is
 * available after reopening a thread.
 */
export function unifiedDiffForFileChanges(changes: readonly FileUpdateChange[]): string
{
    return unifiedDiffForFileChangeBatches([{ changes }]);
}

/**
 * The app server persists ordered file changes but not its live turn diff.
 * Replay those changes into a sparse virtual file so later corrections and
 * reversions collapse into the same net result as the live diff tracker.
 */
export function unifiedDiffForFileChangeBatches(batches: readonly FileChangeDiffBatch[]): string
{
    return netUnifiedDiffForFileChangeBatches(batches)
        ?? legacyUnifiedDiffForFileChangeBatches(batches);
}

function netUnifiedDiffForFileChangeBatches(batches: readonly FileChangeDiffBatch[]): string | null
{
    const files: VirtualFile[] = [];
    const filesByKey = new Map<string, VirtualFile>();

    for (const { changes, cwd } of batches)
    {
        for (const change of changes)
        {
            const sourcePath = patchPath(change.path, cwd);
            const sourceKey = virtualFileKey(cwd, sourcePath);
            let file = filesByKey.get(sourceKey);

            if (!file)
            {
                const existsInitially = change.kind.type !== "add";
                file = createVirtualFile(sourcePath, existsInitially);
                files.push(file);
                filesByKey.set(sourceKey, file);
            }

            switch (change.kind.type)
            {
                case "add":
                    if (!applyAdd(file, change.diff))
                    {
                        return null;
                    }
                    break;
                case "delete":
                    if (!applyDelete(file, change.diff))
                    {
                        return null;
                    }
                    break;
                case "update":
                {
                    if (!applyUpdate(file, change.diff))
                    {
                        return null;
                    }

                    if (change.kind.move_path)
                    {
                        const targetPath = patchPath(change.kind.move_path, cwd);
                        const targetKey = virtualFileKey(cwd, targetPath);
                        const targetFile = filesByKey.get(targetKey);
                        if (targetFile && targetFile !== file)
                        {
                            return null;
                        }
                        filesByKey.delete(sourceKey);
                        filesByKey.set(targetKey, file);
                        file.currentPath = targetPath;
                    }
                    break;
                }
                default:
                    assertNever(change.kind);
            }
        }
    }

    const fragments: string[] = [];
    for (const file of files)
    {
        const fragment = virtualFileDiffFragment(file);
        if (fragment === null)
        {
            return null;
        }
        if (fragment)
        {
            fragments.push(fragment);
        }
    }
    return fragments.length > 0 ? `${fragments.join("\n\n")}\n` : "";
}

function createVirtualFile(path: string, existsInitially: boolean): VirtualFile
{
    return {
        originalPath: path,
        currentPath: path,
        originalExists: existsInitially,
        currentExists: existsInitially,
        original: [],
        current: [],
        originalByOrigin: new Map(),
        detachedByText: new Map(),
        nextOrigin: 0,
    };
}

function virtualFileKey(cwd: string | undefined, path: string): string
{
    return `${cwd ?? ""}\0${path}`;
}

function applyAdd(file: VirtualFile, content: string): boolean
{
    if (file.currentExists)
    {
        return false;
    }

    file.current = contentLines(content).map((text) => restoredOrAddedLine(file, text));
    file.currentExists = true;
    return true;
}

function applyDelete(file: VirtualFile, content: string): boolean
{
    if (!file.currentExists)
    {
        return false;
    }

    const lines = contentLines(content);
    if (!reconcileFullCurrentContent(file, lines))
    {
        return false;
    }

    for (const line of file.current)
    {
        detachOriginalLine(file, line);
    }
    file.current = [];
    file.currentExists = false;
    return true;
}

function applyUpdate(file: VirtualFile, diff: string): boolean
{
    if (!file.currentExists)
    {
        return false;
    }

    const hunks = parseUnifiedDiffHunks(diff);
    if (!hunks)
    {
        return false;
    }

    let lineOffset = 0;
    for (const hunk of hunks)
    {
        const index = (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + lineOffset;
        if (index < 0 || !ensureCurrentLength(file, index + hunk.oldCount))
        {
            return false;
        }

        const oldLines = file.current.slice(index, index + hunk.oldCount);
        const replacement: Array<VirtualLine | string> = [];
        const removed: VirtualLine[] = [];
        let oldIndex = 0;
        let newCount = 0;

        for (const patchLine of hunk.lines)
        {
            const prefix = patchLine[0];
            if (prefix === "\\")
            {
                continue;
            }
            if (prefix === "+")
            {
                replacement.push(patchLine.slice(1));
                newCount += 1;
                continue;
            }
            if (prefix !== " " && prefix !== "-")
            {
                return false;
            }

            const line = oldLines[oldIndex];
            if (!line || !revealLine(file, line, patchLine.slice(1)))
            {
                return false;
            }
            oldIndex += 1;
            if (prefix === " ")
            {
                replacement.push(line);
                newCount += 1;
            }
            else
            {
                removed.push(line);
            }
        }

        if (oldIndex !== hunk.oldCount || newCount !== hunk.newCount)
        {
            return false;
        }

        for (const line of removed)
        {
            detachOriginalLine(file, line);
        }
        const replacementLines = replacement.map((line) =>
            typeof line === "string" ? restoredOrAddedLine(file, line) : line,
        );
        file.current.splice(index, hunk.oldCount, ...replacementLines);
        lineOffset += hunk.newCount - hunk.oldCount;
    }
    return true;
}

function parseUnifiedDiffHunks(diff: string): UnifiedDiffHunk[] | null
{
    const hunks: UnifiedDiffHunk[] = [];
    let current: UnifiedDiffHunk | undefined;

    for (const line of diff.replaceAll("\r\n", "\n").split("\n"))
    {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (match)
        {
            current = {
                oldStart: Number(match[1]),
                oldCount: match[2] === undefined ? 1 : Number(match[2]),
                newCount: match[4] === undefined ? 1 : Number(match[4]),
                lines: [],
            };
            hunks.push(current);
            continue;
        }
        if (line.startsWith("diff --git "))
        {
            current = undefined;
            continue;
        }
        if (current && line !== "")
        {
            current.lines.push(line);
        }
    }

    return hunks.length > 0 || diff.trim().length === 0 ? hunks : null;
}

function ensureCurrentLength(file: VirtualFile, length: number): boolean
{
    if (!file.originalExists && file.current.length < length)
    {
        return false;
    }

    while (file.current.length < length)
    {
        const origin = file.nextOrigin;
        file.nextOrigin += 1;
        const originalLine = { origin } satisfies VirtualLine;
        const currentLine = { origin } satisfies VirtualLine;
        file.original.push(originalLine);
        file.originalByOrigin.set(origin, originalLine);
        file.current.push(currentLine);
    }
    return true;
}

function reconcileFullCurrentContent(file: VirtualFile, content: readonly string[]): boolean
{
    if (file.current.length > content.length || !ensureCurrentLength(file, content.length))
    {
        return false;
    }
    return file.current.every((line, index) => revealLine(file, line, content[index] ?? ""));
}

function revealLine(file: VirtualFile, line: VirtualLine, text: string): boolean
{
    if (line.text !== undefined && line.text !== text)
    {
        return false;
    }
    line.text = text;

    if (line.origin === undefined)
    {
        return true;
    }
    const originalLine = file.originalByOrigin.get(line.origin);
    if (!originalLine || (originalLine.text !== undefined && originalLine.text !== text))
    {
        return false;
    }
    originalLine.text = text;
    return true;
}

function detachOriginalLine(file: VirtualFile, line: VirtualLine): void
{
    if (line.origin === undefined || line.text === undefined)
    {
        return;
    }
    const detached = file.detachedByText.get(line.text) ?? [];
    detached.push(line);
    file.detachedByText.set(line.text, detached);
}

function restoredOrAddedLine(file: VirtualFile, text: string): VirtualLine
{
    const detached = file.detachedByText.get(text);
    const restored = detached?.shift();
    if (detached?.length === 0)
    {
        file.detachedByText.delete(text);
    }
    return restored?.origin !== undefined ? { origin: restored.origin, text } : { text };
}

function virtualFileDiffFragment(file: VirtualFile): string | null
{
    if (!file.originalExists && !file.currentExists)
    {
        return "";
    }
    if (!file.originalExists)
    {
        const content = knownContent(file.current);
        return content === null ? null : addDiffFragment(file.currentPath, content);
    }
    if (!file.currentExists)
    {
        const content = knownContent(file.original);
        return content === null ? null : deleteDiffFragment(file.originalPath, content);
    }

    const hunks = virtualFileHunks(file);
    if (hunks === null)
    {
        return null;
    }
    if (hunks.length === 0 && file.originalPath === file.currentPath)
    {
        return "";
    }

    const header = [`diff --git a/${file.originalPath} b/${file.currentPath}`];
    if (hunks.length === 0)
    {
        header.push(
            "similarity index 100%",
            `rename from ${file.originalPath}`,
            `rename to ${file.currentPath}`,
        );
        return header.join("\n");
    }
    header.push(`--- a/${file.originalPath}`, `+++ b/${file.currentPath}`, ...hunks);
    return header.join("\n");
}

function virtualFileHunks(file: VirtualFile): string[] | null
{
    const originalPositions = originPositions(file.original);
    const currentPositions = originPositions(file.current);
    if (!originsStayOrdered(file.current, originalPositions))
    {
        return null;
    }

    const hunks: string[] = [];
    let originalIndex = 0;
    let currentIndex = 0;

    while (originalIndex < file.original.length || currentIndex < file.current.length)
    {
        if (sameOrigin(file.original[originalIndex], file.current[currentIndex]))
        {
            originalIndex += 1;
            currentIndex += 1;
            continue;
        }

        const oldStart = originalIndex;
        const newStart = currentIndex;
        const deleted: string[] = [];
        const added: string[] = [];

        while (
            (originalIndex < file.original.length || currentIndex < file.current.length)
            && !sameOrigin(file.original[originalIndex], file.current[currentIndex])
        )
        {
            const originalLine = file.original[originalIndex];
            const currentLine = file.current[currentIndex];
            if (!currentLine)
            {
                if (!originalLine || originalLine.text === undefined)
                {
                    return null;
                }
                deleted.push(originalLine.text);
                originalIndex += 1;
                continue;
            }
            if (!originalLine)
            {
                if (currentLine.text === undefined)
                {
                    return null;
                }
                added.push(currentLine.text);
                currentIndex += 1;
                continue;
            }
            if (currentLine.origin === undefined)
            {
                if (currentLine.text === undefined)
                {
                    return null;
                }
                added.push(currentLine.text);
                currentIndex += 1;
                continue;
            }
            if (originalLine.origin === undefined || !currentPositions.has(originalLine.origin))
            {
                if (originalLine.text === undefined)
                {
                    return null;
                }
                deleted.push(originalLine.text);
                originalIndex += 1;
                continue;
            }

            const currentOriginPosition = originalPositions.get(currentLine.origin);
            if (currentOriginPosition === undefined || currentOriginPosition < originalIndex)
            {
                return null;
            }
            if (currentOriginPosition > originalIndex)
            {
                if (originalLine.text === undefined)
                {
                    return null;
                }
                deleted.push(originalLine.text);
                originalIndex += 1;
                continue;
            }
            return null;
        }

        if (deleted.length > 0 || added.length > 0)
        {
            hunks.push([
                `@@ -${formatUnifiedRange(oldStart, deleted.length)} +${formatUnifiedRange(newStart, added.length)} @@`,
                ...deleted.map((line) => `-${line}`),
                ...added.map((line) => `+${line}`),
            ].join("\n"));
        }
    }
    return hunks;
}

function originPositions(lines: readonly VirtualLine[]): Map<number, number>
{
    const positions = new Map<number, number>();
    lines.forEach((line, index) =>
    {
        if (line.origin !== undefined)
        {
            positions.set(line.origin, index);
        }
    });
    return positions;
}

function originsStayOrdered(lines: readonly VirtualLine[], originalPositions: ReadonlyMap<number, number>): boolean
{
    let previous = -1;
    for (const line of lines)
    {
        if (line.origin === undefined)
        {
            continue;
        }
        const position = originalPositions.get(line.origin);
        if (position === undefined || position <= previous)
        {
            return false;
        }
        previous = position;
    }
    return true;
}

function sameOrigin(left: VirtualLine | undefined, right: VirtualLine | undefined): boolean
{
    return left?.origin !== undefined && left.origin === right?.origin;
}

function formatUnifiedRange(index: number, count: number): string
{
    const start = count === 0 ? index : index + 1;
    return count === 1 ? `${start}` : `${start},${count}`;
}

function knownContent(lines: readonly VirtualLine[]): string | null
{
    if (lines.some((line) => line.text === undefined))
    {
        return null;
    }
    return lines.length > 0 ? `${lines.map((line) => line.text).join("\n")}\n` : "";
}

function contentLines(content: string): string[]
{
    const lines = content.replaceAll("\r\n", "\n").split("\n");
    return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function legacyUnifiedDiffForFileChangeBatches(batches: readonly FileChangeDiffBatch[]): string
{
    const fragments: string[] = [];
    const updateFragmentIndexes = new Map<string, number>();

    for (const { changes, cwd } of batches)
    {
        for (const change of changes)
        {
            const fragment = unifiedDiffFragment(change, cwd);
            if (!fragment)
            {
                continue;
            }

            const path = change.kind.type === "update" && change.kind.move_path
                ? change.kind.move_path
                : change.path;
            const key = `${cwd ?? ""}\0${patchPath(path, cwd)}`;
            const isInPlaceUpdate = change.kind.type === "update" && !change.kind.move_path;
            const existingIndex = isInPlaceUpdate ? updateFragmentIndexes.get(key) : undefined;

            if (existingIndex !== undefined)
            {
                const hunkStart = fragment.startsWith("@@") ? 0 : fragment.indexOf("\n@@");
                if (hunkStart !== -1)
                {
                    fragments[existingIndex] = `${fragments[existingIndex]}\n${fragment.slice(hunkStart === 0 ? 0 : hunkStart + 1)}`;
                    continue;
                }
            }

            fragments.push(fragment);
            if (isInPlaceUpdate)
            {
                updateFragmentIndexes.set(key, fragments.length - 1);
            }
            else
            {
                updateFragmentIndexes.delete(key);
            }
        }
    }

    return fragments.length > 0 ? `${fragments.join("\n\n")}\n` : "";
}

function unifiedDiffFragment(change: FileUpdateChange, cwd?: string): string | null
{
    switch (change.kind.type)
    {
        case "update":
            return updateDiffFragment(
                patchPath(change.path, cwd),
                patchPath(change.kind.move_path ?? change.path, cwd),
                change.diff,
            );
        case "add":
            return addDiffFragment(patchPath(change.path, cwd), change.diff);
        case "delete":
            return deleteDiffFragment(patchPath(change.path, cwd), change.diff);
        default:
            return assertNever(change.kind);
    }
}

/**
 * File-change items commonly use absolute paths while Git patches must be
 * repository-relative. Paths outside the reported working directory stay
 * absolute so the Main-process safety check continues to reject them.
 */
function patchPath(path: string, cwd?: string): string
{
    const normalizedPath = path.replaceAll("\\", "/");
    if (!cwd || !isAbsolute(path))
    {
        return normalizedPath;
    }

    const relativePath = relative(cwd, path);
    if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
    )
    {
        return normalizedPath;
    }

    return relativePath.split(sep).join("/");
}

function updateDiffFragment(sourcePath: string, targetPath: string, diff: string): string
{
    const body = diff.trimStart();
    const includesFileHeaders = /\n?---\s/.test(body);
    const includesGitHeader = /^diff --git /m.test(body);
    const fileHeaders = includesFileHeaders
        ? body
        : `--- a/${sourcePath}\n+++ b/${targetPath}\n${body}`;
    return `${includesGitHeader ? "" : `diff --git a/${sourcePath} b/${targetPath}\n`}${fileHeaders}`.replace(/[\r\n]+$/, "");
}

function addDiffFragment(path: string, content: string): string
{
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const contentLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
    const hunk = contentLines.length > 0
        ? `@@ -0,0 +1,${contentLines.length} @@\n${contentLines.map((line) => `+${line}`).join("\n")}\n`
        : "";
    return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${path}`,
        hunk,
    ].filter(Boolean).join("\n").replace(/[\r\n]+$/, "");
}

function deleteDiffFragment(path: string, content: string): string
{
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const contentLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;
    const hunk = contentLines.length > 0
        ? `@@ -1,${contentLines.length} +0,0 @@\n${contentLines.map((line) => `-${line}`).join("\n")}\n`
        : "";
    return [
        `diff --git a/${path} b/${path}`,
        "deleted file mode 100644",
        `--- a/${path}`,
        "+++ /dev/null",
        hunk,
    ].filter(Boolean).join("\n").replace(/[\r\n]+$/, "");
}

function assertNever(value: never): never
{
    throw new Error(`Unhandled patch change kind: ${JSON.stringify(value)}`);
}
