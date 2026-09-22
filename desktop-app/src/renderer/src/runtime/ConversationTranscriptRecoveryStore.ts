import type { DynamicToolUIPart, UIMessage } from 'ai'

import {
  LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
} from '../../../shared/composerContext'

const recoveryStorageKey = 'das-cowork.transcript-recovery.v1'
const recoveryStorageVersion = 8
const ACTIVE_TEXT_PERSIST_INTERVAL_MS = 250
export const TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS = 100
export const TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES = 5 * 1024 * 1024
export const TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS = 7 * 24 * 60 * 60 * 1_000

type LocalAttachmentOverlay = {
  type: 'file'
  mediaType: typeof LOCAL_FILE_ATTACHMENT_MEDIA_TYPE | typeof LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
  filename?: string
  url: string
}

type RecoveryRecord = {
  createdAt: number
  baseRevision: string | null
  attachmentsByMessageId: Record<string, LocalAttachmentOverlay[]>
  terminalByMessageId: Record<string, RecoveredTurnTerminal>
  toolsByMessageId: Record<string, RecoveredToolPart[]>
  activeTextByMessageId: Record<string, string>
}

type RecoveredTurnTerminal = {
  turnId: string
  status: 'failed' | 'interrupted'
  partialText?: string
  error?: {
    message: string
  }
}

/**
 * A completed tool needs the AI SDK's required input/output fields before it
 * can be placed back into a UIMessage. Persist only null placeholders: the
 * fallback preserves the tool's identity and completed state without caching
 * potentially sensitive command arguments or results.
 */
type RecoveredToolPart = Extract<DynamicToolUIPart, { state: 'output-available' }> & {
  type: 'dynamic-tool'
  toolCallId: string
  toolName: string
  state: 'output-available'
  input: null
  output: null
}

type RecoveryStoragePayload = {
  version: typeof recoveryStorageVersion
  recoveries: Record<string, RecoveryRecord>
}

type LegacyRecoveryRecord = {
  messages?: unknown
}

type V2RecoveryRecord = {
  createdAt?: unknown
  attachmentsByMessageId?: unknown
}

type V3RecoveryRecord = V2RecoveryRecord & {
  terminalByMessageId?: unknown
}

type V4RecoveryRecord = V2RecoveryRecord & {
  terminalByTurnId?: unknown
}

type LegacyRecoveryStoragePayload = {
  version: 1
  recoveries: Record<string, LegacyRecoveryRecord>
}

type V2RecoveryStoragePayload = {
  version: 2
  recoveries: Record<string, V2RecoveryRecord>
}

type V3RecoveryStoragePayload = {
  version: 3
  recoveries: Record<string, V3RecoveryRecord>
}

type V4RecoveryStoragePayload = {
  version: 4
  recoveries: Record<string, V4RecoveryRecord>
}

type V5RecoveryStoragePayload = {
  version: 5
  recoveries: Record<string, V2RecoveryRecord>
}

type V6RecoveryRecord = V2RecoveryRecord & {
  baseRevision?: unknown
}

type V6RecoveryStoragePayload = {
  version: 6
  recoveries: Record<string, V6RecoveryRecord>
}

type V7RecoveryRecord = Omit<RecoveryRecord, 'activeTextByMessageId'>

type V7RecoveryStoragePayload = {
  version: 7
  recoveries: Record<string, V7RecoveryRecord>
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type AttachmentOverlaySource = Pick<UIMessage, 'id' | 'parts'>
type TerminalRecoverySource = Pick<UIMessage, 'id' | 'role' | 'parts' | 'metadata'>
type ActiveTextRecoverySource = Pick<UIMessage, 'id' | 'role' | 'parts'>
type PendingActiveTextFallback = {
  messages: readonly ActiveTextRecoverySource[]
  baseRevision?: string | null
}

export function latestAssistantTurnFailedOrInterrupted(
  messages: readonly Pick<UIMessage, 'role' | 'metadata'>[]
): boolean {
  const latestAssistant = messages.findLast((message) => message.role === 'assistant')
  return latestAssistant ? Boolean(terminalFromMetadata(latestAssistant.metadata)) : false
}

/**
 * Stores renderer-owned local attachment metadata and a short-lived terminal
 * fallback. The fallback keeps text already rendered to the user, but tool
 * arguments and results remain sanitized. App-server history stays
 * authoritative whenever it includes the same message or tool identity.
 */
export class ConversationTranscriptRecoveryStore {
  private readonly storage: StorageLike | undefined
  private readonly now: () => number
  private recoveries: Record<string, RecoveryRecord>
  private readonly pendingActiveTextFallbacks = new Map<string, PendingActiveTextFallback>()
  private readonly activeTextFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(storage: StorageLike | undefined = safeLocalStorage(), now: () => number = Date.now) {
    this.storage = storage
    this.now = now
    this.recoveries = readRecoveries(storage, now)
  }

  saveLocalAttachmentOverlay(
    identity: string,
    messages: readonly AttachmentOverlaySource[],
    baseRevision?: string | null
  ): void {
    if (!identity) return
    const attachmentsByMessageId = localAttachmentOverlay(messages)
    if (Object.keys(attachmentsByMessageId).length === 0) return
    const existing = this.recoveries[identity]
    this.recoveries = {
      ...this.recoveries,
      [identity]: {
        createdAt: this.now(),
        baseRevision: baseRevision ?? existing?.baseRevision ?? null,
        attachmentsByMessageId,
        terminalByMessageId: existing?.terminalByMessageId ?? {},
        toolsByMessageId: existing?.toolsByMessageId ?? {},
        activeTextByMessageId: existing?.activeTextByMessageId ?? {}
      }
    }
    this.persist()
  }

  saveTerminalFallback(
    identity: string,
    messages: readonly TerminalRecoverySource[],
    baseRevision?: string | null
  ): void {
    if (!identity) return
    const supersededTerminalMessageIds =
      terminalMessageIdsSupersededByLaterAssistantMessage(messages)
    const terminalByMessageId = terminalByMessageIdFromMessages(
      messages,
      supersededTerminalMessageIds
    )
    const existing = this.recoveries[identity]
    if (Object.keys(terminalByMessageId).length === 0 && supersededTerminalMessageIds.size === 0) {
      return
    }
    if (!existing && Object.keys(terminalByMessageId).length === 0) return
    const toolsByMessageId = toolsByMessageIdFromMessages(messages, terminalByMessageId)
    const attachmentsByMessageId = existing?.attachmentsByMessageId ?? {}
    const remainingTerminals = {
      ...withoutRecoveryMessageIds(
        existing?.terminalByMessageId ?? {},
        supersededTerminalMessageIds
      ),
      ...terminalByMessageId
    }
    const remainingTools = {
      ...withoutRecoveryMessageIds(existing?.toolsByMessageId ?? {}, supersededTerminalMessageIds),
      ...toolsByMessageId
    }
    const activeTextByMessageId = existing?.activeTextByMessageId ?? {}
    const next = { ...this.recoveries }
    if (
      Object.keys(attachmentsByMessageId).length === 0 &&
      Object.keys(remainingTerminals).length === 0 &&
      Object.keys(remainingTools).length === 0 &&
      Object.keys(activeTextByMessageId).length === 0
    ) {
      delete next[identity]
    } else {
      next[identity] = {
        createdAt: this.now(),
        baseRevision: baseRevision ?? existing?.baseRevision ?? null,
        attachmentsByMessageId,
        terminalByMessageId: remainingTerminals,
        toolsByMessageId: remainingTools,
        activeTextByMessageId
      }
    }
    this.recoveries = next
    this.persist()
  }

  clearTerminalFallback(identity: string): void {
    const recovery = this.recoveries[identity]
    if (
      !recovery ||
      (Object.keys(recovery.terminalByMessageId).length === 0 &&
        Object.keys(recovery.toolsByMessageId).length === 0)
    ) {
      return
    }

    const next = { ...this.recoveries }
    if (Object.keys(recovery.attachmentsByMessageId).length === 0) {
      delete next[identity]
    } else {
      next[identity] = {
        ...recovery,
        terminalByMessageId: {},
        toolsByMessageId: {}
      }
    }
    this.recoveries = next
    this.persist()
  }

  /**
   * Preserve only text that was already rendered for an in-progress turn. It
   * is used solely if the replacement renderer cannot query main's journal;
   * it never makes an active turn look terminal.
   */
  saveActiveTextFallback(
    identity: string,
    messages: readonly ActiveTextRecoverySource[],
    baseRevision?: string | null
  ): void {
    this.discardPendingActiveTextFallback(identity)
    this.persistActiveTextFallback(identity, messages, baseRevision)
  }

  /**
   * Streaming text is updated far more often than recovery needs to be
   * written. Keep the latest visible text in memory and batch synchronous
   * localStorage writes so they do not block the renderer on every delta.
   */
  saveActiveTextFallbackDeferred(
    identity: string,
    messages: readonly ActiveTextRecoverySource[],
    baseRevision?: string | null
  ): void {
    if (!identity) return
    this.pendingActiveTextFallbacks.set(identity, { messages, baseRevision })
    if (this.activeTextFallbackTimers.has(identity)) return
    const timer = setTimeout(() => {
      this.activeTextFallbackTimers.delete(identity)
      this.flushPendingActiveTextFallback(identity)
    }, ACTIVE_TEXT_PERSIST_INTERVAL_MS)
    this.activeTextFallbackTimers.set(identity, timer)
  }

  flushPendingActiveTextFallbacks(): void {
    for (const identity of [...this.pendingActiveTextFallbacks.keys()]) {
      this.flushPendingActiveTextFallback(identity)
    }
  }

  private persistActiveTextFallback(
    identity: string,
    messages: readonly ActiveTextRecoverySource[],
    baseRevision?: string | null
  ): void {
    if (!identity) return
    const activeTextByMessageId = activeTextByMessageIdFromMessages(messages)
    if (Object.keys(activeTextByMessageId).length === 0) return
    const existing = this.recoveries[identity]
    const resolvedBaseRevision = baseRevision ?? existing?.baseRevision ?? null
    if (
      existing &&
      existing.baseRevision === resolvedBaseRevision &&
      sameTextRecord(existing.activeTextByMessageId, activeTextByMessageId)
    ) {
      return
    }
    this.recoveries = {
      ...this.recoveries,
      [identity]: {
        createdAt: this.now(),
        baseRevision: resolvedBaseRevision,
        attachmentsByMessageId: existing?.attachmentsByMessageId ?? {},
        terminalByMessageId: existing?.terminalByMessageId ?? {},
        toolsByMessageId: existing?.toolsByMessageId ?? {},
        activeTextByMessageId
      }
    }
    this.persist()
  }

  clearActiveTextFallback(identity: string): void {
    this.discardPendingActiveTextFallback(identity)
    const recovery = this.recoveries[identity]
    if (!recovery || Object.keys(recovery.activeTextByMessageId).length === 0) return
    const next = { ...this.recoveries }
    if (
      Object.keys(recovery.attachmentsByMessageId).length === 0 &&
      Object.keys(recovery.terminalByMessageId).length === 0 &&
      Object.keys(recovery.toolsByMessageId).length === 0
    ) {
      delete next[identity]
    } else {
      next[identity] = { ...recovery, activeTextByMessageId: {} }
    }
    this.recoveries = next
    this.persist()
  }

  mergeActiveTextFallback(identity: string, history: readonly UIMessage[]): UIMessage[] {
    const recovery = this.recoveries[identity]
    const clonedHistory = cloneMessages(history) ?? [...history]
    if (!recovery || Object.keys(recovery.activeTextByMessageId).length === 0) {
      return clonedHistory
    }
    const remaining = { ...recovery.activeTextByMessageId }
    const merged = clonedHistory.map((message) => {
      const text = remaining[message.id]
      if (!text) return message
      delete remaining[message.id]
      return message.parts.some((part) => part.type === 'text' && part.text.includes(text))
        ? message
        : { ...message, parts: [...message.parts, { type: 'text' as const, text }] }
    })
    for (const [messageId, text] of Object.entries(remaining)) {
      merged.push({ id: messageId, role: 'assistant', parts: [{ type: 'text', text }] })
    }
    return merged
  }

  mergeWithHistory(
    identity: string,
    history: readonly UIMessage[],
    baseRevision?: string | null
  ): UIMessage[] {
    const recovery = this.recoveries[identity]
    const clonedHistory = cloneMessages(history) ?? [...history]
    if (!recovery) return clonedHistory

    const remainingAttachments = { ...recovery.attachmentsByMessageId }
    const remainingTerminals = { ...recovery.terminalByMessageId }
    const remainingTools = { ...recovery.toolsByMessageId }
    const remainingActiveText = { ...recovery.activeTextByMessageId }
    for (const messageId of terminalMessageIdsSupersededByCanonicalHistory(
      remainingTerminals,
      clonedHistory
    )) {
      delete remainingTerminals[messageId]
      delete remainingTools[messageId]
    }
    const recoveryMessageIdsByHistoryIndex = recoveryMessageIdsByCanonicalHistoryIndex(
      remainingTerminals,
      clonedHistory
    )
    let resolvedRecoveryOverlay = false
    const merged = clonedHistory.map((message, index) => {
      const attachments = recovery.attachmentsByMessageId[message.id]
      const missingAttachments = (attachments ?? []).filter(
        (attachment) => !message.parts.some((part) => samePart(part, attachment))
      )
      if (attachments && missingAttachments.length !== attachments.length) {
        resolvedRecoveryOverlay = true
      }
      if (attachments && missingAttachments.length === 0) delete remainingAttachments[message.id]
      else if (attachments) remainingAttachments[message.id] = missingAttachments

      const messageWithTerminalFallback = mergeTerminalFallbackIntoMessage(
        missingAttachments.length === 0
          ? message
          : {
              ...message,
              parts: [...message.parts, ...missingAttachments] as UIMessage['parts']
            },
        recoveryMessageIdsByHistoryIndex.get(index),
        remainingTerminals,
        remainingTools
      )
      return mergeActiveTextIntoCanonicalTerminal(
        messageWithTerminalFallback,
        remainingActiveText,
        clonedHistory
      )
    })

    const historyMessageIds = new Set(merged.map((message) => message.id))
    for (const messageId of new Set([
      ...Object.keys(remainingTerminals),
      ...Object.keys(remainingTools)
    ])) {
      const terminal = remainingTerminals[messageId]
      if (!terminal || historyMessageIds.has(messageId)) continue
      merged.push(recoveryFallbackMessage(messageId, terminal, remainingTools[messageId] ?? []))
    }

    const revisionChanged = baseRevision !== undefined && recovery.baseRevision !== baseRevision
    if (
      resolvedRecoveryOverlay ||
      revisionChanged ||
      !sameRecoveryKeys(recovery, remainingTerminals, remainingTools) ||
      !sameKeys(recovery.activeTextByMessageId, remainingActiveText)
    ) {
      const next = { ...this.recoveries }
      if (
        Object.keys(remainingAttachments).length === 0 &&
        Object.keys(remainingTerminals).length === 0 &&
        Object.keys(remainingTools).length === 0 &&
        Object.keys(remainingActiveText).length === 0
      ) {
        delete next[identity]
      } else {
        next[identity] = {
          ...recovery,
          ...(baseRevision === undefined ? {} : { baseRevision }),
          attachmentsByMessageId: remainingAttachments,
          terminalByMessageId: remainingTerminals,
          toolsByMessageId: remainingTools,
          activeTextByMessageId: remainingActiveText
        }
      }
      this.recoveries = next
      this.persist()
    }
    return merged
  }

  migrate(fromIdentity: string, toIdentity: string): void {
    if (!fromIdentity || !toIdentity || fromIdentity === toIdentity) return
    this.flushPendingActiveTextFallback(fromIdentity)
    const source = this.recoveries[fromIdentity]
    if (!source || this.recoveries[toIdentity]) return
    const next = { ...this.recoveries, [toIdentity]: source }
    delete next[fromIdentity]
    this.recoveries = next
    this.persist()
  }

  private persist(): void {
    if (!this.storage) return
    this.recoveries = pruneRecoveries(this.recoveries, this.now())
    try {
      this.storage.setItem(
        recoveryStorageKey,
        JSON.stringify({ version: recoveryStorageVersion, recoveries: this.recoveries })
      )
    } catch {
      reportRecoveryDiagnostic('storage-write-failed')
    }
  }

  private flushPendingActiveTextFallback(identity: string): void {
    const timer = this.activeTextFallbackTimers.get(identity)
    if (timer !== undefined) clearTimeout(timer)
    this.activeTextFallbackTimers.delete(identity)
    const pending = this.pendingActiveTextFallbacks.get(identity)
    this.pendingActiveTextFallbacks.delete(identity)
    if (!pending) return
    this.persistActiveTextFallback(identity, pending.messages, pending.baseRevision)
  }

  private discardPendingActiveTextFallback(identity: string): void {
    const timer = this.activeTextFallbackTimers.get(identity)
    if (timer !== undefined) clearTimeout(timer)
    this.activeTextFallbackTimers.delete(identity)
    this.pendingActiveTextFallbacks.delete(identity)
  }
}

function readRecoveries(
  storage: StorageLike | undefined,
  now: () => number
): Record<string, RecoveryRecord> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(recoveryStorageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (isRecoveryPayload(parsed)) return pruneRecoveries(parsed.recoveries, now())
    if (isV7RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV7Recoveries(parsed.recoveries), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isV6RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV6Recoveries(parsed.recoveries, now()), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isV4RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV4Recoveries(parsed.recoveries, now()), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isV5RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV5Recoveries(parsed.recoveries, now()), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isV3RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV3Recoveries(parsed.recoveries, now()), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isV2RecoveryPayload(parsed)) {
      const migrated = pruneRecoveries(migrateV2Recoveries(parsed.recoveries, now()), now())
      persistMigration(storage, migrated)
      return migrated
    }
    if (isLegacyRecoveryPayload(parsed)) {
      const migrated = migrateLegacyRecoveries(parsed.recoveries, now())
      persistMigration(storage, migrated)
      return migrated
    }
    reportRecoveryDiagnostic('storage-schema-invalid')
  } catch {
    reportRecoveryDiagnostic('storage-read-or-migration-failed')
  }
  return {}
}

function persistMigration(storage: StorageLike, recoveries: Record<string, RecoveryRecord>): void {
  try {
    if (Object.keys(recoveries).length === 0) {
      storage.removeItem(recoveryStorageKey)
      return
    }
    storage.setItem(
      recoveryStorageKey,
      JSON.stringify({ version: recoveryStorageVersion, recoveries })
    )
  } catch {
    reportRecoveryDiagnostic('storage-migration-write-failed')
  }
}

function isRecoveryPayload(value: unknown): value is RecoveryStoragePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<RecoveryStoragePayload>
  if (payload.version !== recoveryStorageVersion || !payload.recoveries) return false
  return Object.values(payload.recoveries).every(isRecoveryRecord)
}

function isV2RecoveryPayload(value: unknown): value is V2RecoveryStoragePayload {
  return isRecord(value) && value.version === 2 && isRecord(value.recoveries)
}

function isV3RecoveryPayload(value: unknown): value is V3RecoveryStoragePayload {
  return isRecord(value) && value.version === 3 && isRecord(value.recoveries)
}

function isV4RecoveryPayload(value: unknown): value is V4RecoveryStoragePayload {
  return isRecord(value) && value.version === 4 && isRecord(value.recoveries)
}

function isV5RecoveryPayload(value: unknown): value is V5RecoveryStoragePayload {
  return isRecord(value) && value.version === 5 && isRecord(value.recoveries)
}

function isV6RecoveryPayload(value: unknown): value is V6RecoveryStoragePayload {
  return isRecord(value) && value.version === 6 && isRecord(value.recoveries)
}

function isV7RecoveryPayload(value: unknown): value is V7RecoveryStoragePayload {
  return isRecord(value) && value.version === 7 && isRecord(value.recoveries)
}

function isLegacyRecoveryPayload(value: unknown): value is LegacyRecoveryStoragePayload {
  return isRecord(value) && value.version === 1 && isRecord(value.recoveries)
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<RecoveryRecord>
  return (
    typeof record.createdAt === 'number' &&
    (record.baseRevision === null || typeof record.baseRevision === 'string') &&
    Boolean(record.attachmentsByMessageId) &&
    Boolean(record.terminalByMessageId) &&
    Boolean(record.toolsByMessageId) &&
    Boolean(record.activeTextByMessageId) &&
    Object.values(record.attachmentsByMessageId ?? {}).every(
      (attachments) => Array.isArray(attachments) && attachments.every(isLocalAttachmentOverlay)
    ) &&
    Object.values(record.terminalByMessageId ?? {}).every(isRecoveredTurnTerminal) &&
    Object.values(record.toolsByMessageId ?? {}).every(
      (tools) => Array.isArray(tools) && tools.every(isRecoveredToolPart)
    ) &&
    Object.values(record.activeTextByMessageId ?? {}).every((text) => typeof text === 'string')
  )
}

function isLocalAttachmentOverlay(value: unknown): value is LocalAttachmentOverlay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<LocalAttachmentOverlay>
  return (
    attachment.type === 'file' &&
    (attachment.mediaType === LOCAL_FILE_ATTACHMENT_MEDIA_TYPE ||
      attachment.mediaType === LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE) &&
    typeof attachment.url === 'string' &&
    (attachment.filename === undefined || typeof attachment.filename === 'string')
  )
}

function isRecoveredTurnTerminal(value: unknown): value is RecoveredTurnTerminal {
  if (!isRecord(value)) return false
  const error = value.error
  return (
    typeof value.turnId === 'string' &&
    (value.status === 'failed' || value.status === 'interrupted') &&
    (value.partialText === undefined || typeof value.partialText === 'string') &&
    (error === undefined || (isRecord(error) && typeof error.message === 'string'))
  )
}

function isRecoveredToolPart(value: unknown): value is RecoveredToolPart {
  if (!isRecord(value)) return false
  return (
    value.type === 'dynamic-tool' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    value.state === 'output-available' &&
    value.input === null &&
    value.output === null &&
    (value.providerExecuted === undefined || typeof value.providerExecuted === 'boolean')
  )
}

function migrateLegacyRecoveries(
  recoveries: Record<string, LegacyRecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, recovery]) => {
      const attachmentsByMessageId = localAttachmentOverlayFromUnknown(recovery.messages)
      return Object.keys(attachmentsByMessageId).length > 0
        ? [[identity, emptyRecoveryRecord(now, attachmentsByMessageId)]]
        : []
    })
  )
}

function migrateV2Recoveries(
  recoveries: Record<string, V2RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, record]) => {
      const attachmentsByMessageId = isRecord(record.attachmentsByMessageId)
        ? Object.fromEntries(
            Object.entries(record.attachmentsByMessageId).flatMap(([messageId, attachments]) =>
              Array.isArray(attachments) && attachments.every(isLocalAttachmentOverlay)
                ? [[messageId, attachments]]
                : []
            )
          )
        : {}
      if (Object.keys(attachmentsByMessageId).length === 0) return []
      return [[identity, emptyRecoveryRecord(record.createdAt, attachmentsByMessageId, now)]]
    })
  )
}

function migrateV3Recoveries(
  recoveries: Record<string, V3RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, record]) => {
      const attachmentsByMessageId = attachmentsByMessageIdFromUnknown(
        record.attachmentsByMessageId
      )
      const terminalByMessageId = terminalByMessageIdFromLegacy(record.terminalByMessageId)
      if (
        Object.keys(attachmentsByMessageId).length === 0 &&
        Object.keys(terminalByMessageId).length === 0
      ) {
        return []
      }
      return [
        [
          identity,
          {
            ...emptyRecoveryRecord(record.createdAt, attachmentsByMessageId, now),
            terminalByMessageId
          }
        ]
      ]
    })
  )
}

function migrateV4Recoveries(
  recoveries: Record<string, V4RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, record]) => {
      const attachmentsByMessageId = attachmentsByMessageIdFromUnknown(
        record.attachmentsByMessageId
      )
      const terminalByMessageId = terminalByTurnIdFromLegacy(record.terminalByTurnId)
      if (
        Object.keys(attachmentsByMessageId).length === 0 &&
        Object.keys(terminalByMessageId).length === 0
      ) {
        return []
      }
      return [
        [
          identity,
          {
            ...emptyRecoveryRecord(record.createdAt, attachmentsByMessageId, now),
            terminalByMessageId
          }
        ]
      ]
    })
  )
}

function migrateV5Recoveries(
  recoveries: Record<string, V2RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return migrateV2Recoveries(recoveries, now)
}

function migrateV6Recoveries(
  recoveries: Record<string, V6RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, record]) => {
      const attachmentsByMessageId = attachmentsByMessageIdFromUnknown(
        record.attachmentsByMessageId
      )
      if (Object.keys(attachmentsByMessageId).length === 0) return []
      return [
        [
          identity,
          {
            ...emptyRecoveryRecord(record.createdAt, attachmentsByMessageId, now),
            baseRevision:
              record.baseRevision === null || typeof record.baseRevision === 'string'
                ? record.baseRevision
                : null
          }
        ]
      ]
    })
  )
}

function migrateV7Recoveries(
  recoveries: Record<string, V7RecoveryRecord>
): Record<string, RecoveryRecord> {
  return Object.fromEntries(
    Object.entries(recoveries).flatMap(([identity, record]) => {
      if (!isRecoveryRecordV7(record)) return []
      return [[identity, { ...record, activeTextByMessageId: {} }]]
    })
  )
}

function isRecoveryRecordV7(value: unknown): value is V7RecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<V7RecoveryRecord>
  return (
    typeof record.createdAt === 'number' &&
    (record.baseRevision === null || typeof record.baseRevision === 'string') &&
    Boolean(record.attachmentsByMessageId) &&
    Boolean(record.terminalByMessageId) &&
    Boolean(record.toolsByMessageId) &&
    Object.values(record.attachmentsByMessageId ?? {}).every(
      (attachments) => Array.isArray(attachments) && attachments.every(isLocalAttachmentOverlay)
    ) &&
    Object.values(record.terminalByMessageId ?? {}).every(isRecoveredTurnTerminal) &&
    Object.values(record.toolsByMessageId ?? {}).every(
      (tools) => Array.isArray(tools) && tools.every(isRecoveredToolPart)
    )
  )
}

function attachmentsByMessageIdFromUnknown(
  value: unknown
): Record<string, LocalAttachmentOverlay[]> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([messageId, attachments]) =>
      Array.isArray(attachments) && attachments.every(isLocalAttachmentOverlay)
        ? [[messageId, attachments]]
        : []
    )
  )
}

function localAttachmentOverlay(
  messages: readonly AttachmentOverlaySource[]
): Record<string, LocalAttachmentOverlay[]> {
  return Object.fromEntries(
    messages.flatMap((message) => {
      if (!message.id) return []
      const attachments = message.parts.flatMap(toLocalAttachmentOverlay)
      return attachments.length > 0 ? [[message.id, attachments]] : []
    })
  )
}

function localAttachmentOverlayFromUnknown(
  value: unknown
): Record<string, LocalAttachmentOverlay[]> {
  if (!Array.isArray(value)) return {}
  return Object.fromEntries(
    value.flatMap((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return []
      const candidate = message as { id?: unknown; parts?: unknown }
      if (typeof candidate.id !== 'string' || !Array.isArray(candidate.parts)) return []
      const attachments = candidate.parts.flatMap(toLocalAttachmentOverlay)
      return attachments.length > 0 ? [[candidate.id, attachments]] : []
    })
  )
}

function toLocalAttachmentOverlay(part: unknown): LocalAttachmentOverlay[] {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return []
  const candidate = part as Partial<LocalAttachmentOverlay>
  if (
    candidate.type !== 'file' ||
    (candidate.mediaType !== LOCAL_FILE_ATTACHMENT_MEDIA_TYPE &&
      candidate.mediaType !== LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE) ||
    typeof candidate.url !== 'string' ||
    (candidate.filename !== undefined && typeof candidate.filename !== 'string')
  ) {
    return []
  }
  return [
    {
      type: 'file',
      mediaType: candidate.mediaType,
      ...(candidate.filename === undefined ? {} : { filename: candidate.filename }),
      url: candidate.url
    }
  ]
}

function emptyRecoveryRecord(
  createdAt: unknown,
  attachmentsByMessageId: Record<string, LocalAttachmentOverlay[]>,
  now = Date.now()
): RecoveryRecord {
  return {
    createdAt: typeof createdAt === 'number' ? createdAt : now,
    baseRevision: null,
    attachmentsByMessageId,
    terminalByMessageId: {},
    toolsByMessageId: {},
    activeTextByMessageId: {}
  }
}

function activeTextByMessageIdFromMessages(
  messages: readonly ActiveTextRecoverySource[]
): Record<string, string> {
  return Object.fromEntries(
    messages.flatMap((message) => {
      if (message.role !== 'assistant' || !message.id) return []
      const text = message.parts
        .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
        .join('')
      return text ? [[message.id, text]] : []
    })
  )
}

function sameTextRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key])
}

function terminalByMessageIdFromMessages(
  messages: readonly TerminalRecoverySource[],
  excludedMessageIds = new Set<string>()
): Record<string, RecoveredTurnTerminal> {
  return Object.fromEntries(
    messages.flatMap((message) => {
      if (message.role !== 'assistant' || !message.id || excludedMessageIds.has(message.id)) {
        return []
      }
      const terminal = recoveredTerminalFromMessage(message)
      return terminal ? [[message.id, terminal]] : []
    })
  )
}

function recoveredTerminalFromMessage(
  message: TerminalRecoverySource
): RecoveredTurnTerminal | undefined {
  const terminal = terminalFromMetadata(message.metadata)
  if (!terminal) return undefined
  const partialText = message.parts
    .flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []))
    .join('')
  return partialText ? { ...terminal, partialText } : terminal
}

/**
 * A later assistant response means the live transcript has recovered from an
 * earlier terminal fallback. Keep only the latest unresolved failure: otherwise
 * a renderer-owned error can outlive a subsequent app-server success.
 */
function terminalMessageIdsSupersededByLaterAssistantMessage(
  messages: readonly TerminalRecoverySource[]
): Set<string> {
  const superseded = new Set<string>()
  let hasLaterSuccessfulAssistant = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isSuccessfulAssistantMessage(message)) {
      hasLaterSuccessfulAssistant = true
      continue
    }
    if (hasLaterSuccessfulAssistant && message.id && terminalFromMetadata(message.metadata)) {
      superseded.add(message.id)
    }
  }
  return superseded
}

/**
 * A crash can happen after app-server accepts a later response but before the
 * renderer persists the cleaned fallback. On hydration, compare the fallback
 * turn identity with canonical history and discard it when a later assistant
 * response already exists there.
 */
function terminalMessageIdsSupersededByCanonicalHistory(
  terminalByMessageId: Record<string, RecoveredTurnTerminal>,
  history: readonly UIMessage[]
): Set<string> {
  const superseded = new Set<string>()
  for (const [messageId, terminal] of Object.entries(terminalByMessageId)) {
    const terminalIndex = history.findLastIndex(
      (message) =>
        message.id === messageId ||
        (canonicalTurnId(message.metadata) === terminal.turnId &&
          terminalFromMetadata(message.metadata)?.turnId === terminal.turnId)
    )
    if (terminalIndex < 0) continue
    if (history.slice(terminalIndex + 1).some(isSuccessfulAssistantMessage)) {
      superseded.add(messageId)
    }
  }
  return superseded
}

function recoveryMessageIdsByCanonicalHistoryIndex(
  terminalByMessageId: Record<string, RecoveredTurnTerminal>,
  history: readonly UIMessage[]
): Map<number, string> {
  const recoveryMessageIds = new Map<number, string>()
  for (const [messageId, terminal] of Object.entries(terminalByMessageId)) {
    const index = history.findLastIndex(
      (message) =>
        message.id === messageId ||
        (canonicalTurnId(message.metadata) === terminal.turnId &&
          terminalFromMetadata(message.metadata)?.turnId === terminal.turnId)
    )
    if (index >= 0) recoveryMessageIds.set(index, messageId)
  }
  return recoveryMessageIds
}

function isSuccessfulAssistantMessage(
  message: Pick<TerminalRecoverySource, 'role' | 'metadata'>
): boolean {
  return message.role === 'assistant' && !terminalFromMetadata(message.metadata)
}

function canonicalTurnId(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined
  const codexTurn = metadata.codexTurn
  if (isRecord(codexTurn) && typeof codexTurn.turnId === 'string') return codexTurn.turnId
  const codexSource = metadata.codexSource
  return isRecord(codexSource) && typeof codexSource.turnId === 'string'
    ? codexSource.turnId
    : undefined
}

function withoutRecoveryMessageIds<T>(
  records: Record<string, T>,
  excludedMessageIds: ReadonlySet<string>
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(records).filter(([messageId]) => !excludedMessageIds.has(messageId))
  )
}

function toolsByMessageIdFromMessages(
  messages: readonly TerminalRecoverySource[],
  terminalByMessageId: Record<string, RecoveredTurnTerminal>
): Record<string, RecoveredToolPart[]> {
  return Object.fromEntries(
    messages.flatMap((message) => {
      if (!message.id || !terminalByMessageId[message.id]) return []
      const tools = message.parts.flatMap(toRecoveredToolPart)
      return tools.length > 0 ? [[message.id, tools]] : []
    })
  )
}

function terminalByMessageIdFromLegacy(value: unknown): Record<string, RecoveredTurnTerminal> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([messageId, terminal]) => {
      const recovered = recoveredTurnTerminal(terminal)
      return recovered ? [[messageId, recovered]] : []
    })
  )
}

function terminalByTurnIdFromLegacy(value: unknown): Record<string, RecoveredTurnTerminal> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([turnId, terminal]) => {
      const recovered = recoveredTurnTerminal(terminal, turnId)
      return recovered ? [[`assistant:${recovered.turnId}:terminal`, recovered]] : []
    })
  )
}

function terminalFromMetadata(metadata: unknown): RecoveredTurnTerminal | undefined {
  if (!isRecord(metadata)) return undefined
  return recoveredTurnTerminal(metadata.codexTurn)
}

function recoveredTurnTerminal(
  value: unknown,
  fallbackTurnId?: string
): RecoveredTurnTerminal | undefined {
  if (!isRecord(value)) return undefined
  const turnId = typeof value.turnId === 'string' ? value.turnId : fallbackTurnId
  if (!turnId || (value.status !== 'failed' && value.status !== 'interrupted')) return undefined
  const errorMessage =
    value.status === 'failed' && isRecord(value.error) && typeof value.error.message === 'string'
      ? safeRecoveryErrorMessage(value.error.message)
      : value.status === 'failed' && typeof value.error === 'string'
        ? safeRecoveryErrorMessage(value.error)
        : undefined
  const partialText = typeof value.partialText === 'string' ? value.partialText : undefined
  return {
    turnId,
    status: value.status,
    ...(partialText ? { partialText } : {}),
    ...(errorMessage ? { error: { message: errorMessage } } : {})
  }
}

function toRecoveredToolPart(part: unknown): RecoveredToolPart[] {
  if (!isRecord(part)) return []
  if (
    part.type !== 'dynamic-tool' ||
    part.state !== 'output-available' ||
    typeof part.toolCallId !== 'string' ||
    typeof part.toolName !== 'string'
  ) {
    return []
  }
  return [
    {
      type: 'dynamic-tool',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      state: 'output-available',
      input: null,
      output: null,
      ...(typeof part.providerExecuted === 'boolean'
        ? { providerExecuted: part.providerExecuted }
        : {})
    }
  ]
}

function mergeTerminalFallbackIntoMessage(
  message: UIMessage,
  recoveryMessageId: string | undefined,
  remainingTerminals: Record<string, RecoveredTurnTerminal>,
  remainingTools: Record<string, RecoveredToolPart[]>
): UIMessage {
  const terminal = recoveryMessageId ? remainingTerminals[recoveryMessageId] : undefined
  const tools = recoveryMessageId ? (remainingTools[recoveryMessageId] ?? []) : []
  const existingToolCallIds = new Set(
    message.parts.flatMap((part) =>
      'toolCallId' in part && typeof part.toolCallId === 'string' ? [part.toolCallId] : []
    )
  )
  const missingTools = tools.filter((tool) => !existingToolCallIds.has(tool.toolCallId))
  if (missingTools.length === 0 && tools.length > 0 && recoveryMessageId) {
    delete remainingTools[recoveryMessageId]
  }

  const partialText = terminal?.partialText
  const missingPartialText =
    partialText !== undefined &&
    !message.parts.some((part) => part.type === 'text' && part.text.includes(partialText))

  const canonicalTerminal = terminalFromMetadata(message.metadata)
  if (canonicalTerminal && recoveryMessageId) delete remainingTerminals[recoveryMessageId]

  if (missingTools.length === 0 && !missingPartialText && (!terminal || canonicalTerminal)) {
    return message
  }
  return {
    ...message,
    parts: [
      ...message.parts,
      ...(missingPartialText ? [{ type: 'text' as const, text: partialText }] : []),
      ...missingTools
    ],
    ...(terminal && !canonicalTerminal
      ? {
          metadata: {
            ...(isRecord(message.metadata) ? message.metadata : {}),
            codexTurn: terminal
          }
        }
      : {})
  }
}

function mergeActiveTextIntoCanonicalTerminal(
  message: UIMessage,
  remainingActiveText: Record<string, string>,
  canonicalHistory: readonly UIMessage[]
): UIMessage {
  const terminal = terminalFromMetadata(message.metadata)
  if (!terminal) return message

  const recoveredTexts = Object.entries(remainingActiveText).flatMap(([messageId, text]) => {
    if (turnIdFromAssistantSourceMessageId(messageId) !== terminal.turnId) return []
    delete remainingActiveText[messageId]
    const textIsCanonical = canonicalHistory.some(
      (candidate) =>
        candidate.role === 'assistant' &&
        (canonicalTurnId(candidate.metadata) === terminal.turnId ||
          turnIdFromAssistantSourceMessageId(candidate.id) === terminal.turnId) &&
        candidate.parts.some((part) => part.type === 'text' && part.text.includes(text))
    )
    return textIsCanonical ||
      message.parts.some((part) => part.type === 'text' && part.text.includes(text))
      ? []
      : [text]
  })
  return recoveredTexts.length === 0
    ? message
    : {
        ...message,
        parts: [...message.parts, { type: 'text' as const, text: recoveredTexts.join('') }]
      }
}

function turnIdFromAssistantSourceMessageId(messageId: string): string | undefined {
  const match = /^assistant:([^:]+):/u.exec(messageId)
  return match?.[1]
}

function recoveryFallbackMessage(
  messageId: string,
  terminal: RecoveredTurnTerminal,
  tools: readonly RecoveredToolPart[]
): UIMessage {
  return {
    id: messageId,
    role: 'assistant',
    parts: [
      ...(terminal.partialText ? [{ type: 'text' as const, text: terminal.partialText }] : []),
      ...tools
    ],
    metadata: { codexTurn: terminal }
  }
}

function sameRecoveryKeys(
  recovery: RecoveryRecord,
  remainingTerminals: Record<string, RecoveredTurnTerminal>,
  remainingTools: Record<string, RecoveredToolPart[]>
): boolean {
  return (
    sameKeys(recovery.terminalByMessageId, remainingTerminals) &&
    sameKeys(recovery.toolsByMessageId, remainingTools)
  )
}

function sameKeys(left: object, right: object): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  )
}

function safeRecoveryErrorMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return '模型响应未完成，请重试。'
  const redacted = trimmed
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/(\bapi[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
  return redacted.length <= 2_000 ? redacted : `${redacted.slice(0, 2_000)}…`
}

function pruneRecoveries(
  recoveries: Record<string, RecoveryRecord>,
  now: number
): Record<string, RecoveryRecord> {
  const candidates = Object.entries(recoveries)
    .filter(
      ([, record]) =>
        isRecoveryRecord(record) && now - record.createdAt <= TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS
    )
    .sort(([, left], [, right]) => right.createdAt - left.createdAt)
    .slice(0, TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS)
  const retained: Record<string, RecoveryRecord> = {}
  for (const [identity, record] of candidates) {
    const candidate = { ...retained, [identity]: record }
    if (
      serializedByteLength({ version: recoveryStorageVersion, recoveries: candidate }) >
      TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES
    ) {
      continue
    }
    retained[identity] = record
  }
  return retained
}

function serializedByteLength(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size
}

function cloneMessages(messages: readonly UIMessage[]): UIMessage[] | undefined {
  try {
    return JSON.parse(JSON.stringify(messages)) as UIMessage[]
  } catch {
    reportRecoveryDiagnostic('history-clone-failed')
    return undefined
  }
}

function samePart(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function reportRecoveryDiagnostic(reason: string): void {
  console.warn('[transcript-recovery]', { reason })
}

function safeLocalStorage(): StorageLike | undefined {
  try {
    return window.localStorage
  } catch {
    reportRecoveryDiagnostic('local-storage-unavailable')
    return undefined
  }
}
