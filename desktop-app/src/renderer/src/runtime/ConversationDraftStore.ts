import type { ApprovalModeKind } from '../../../shared/codexIpcApi'

const draftStorageKey = 'das-cowork.conversation-drafts.v4'
const previousDraftStorageKey = 'das-cowork.conversation-drafts.v3'
const v2DraftStorageKey = 'das-cowork.conversation-drafts.v2'
const legacyDraftStorageKey = 'das-cowork.conversation-drafts.v1'

export type ConversationComposerModeKind = 'default' | 'plan'
export type ConversationApprovalModeKind = ApprovalModeKind

export type ConversationDraftAttachment =
  | {
      artifactPreviewToken?: string
      capabilityToken?: string
      fileUrl: string
      kind: 'file' | 'folder'
      label: string
      path: string
    }
  | {
      kind: 'artifact'
      label: string
      sourceId: string
    }

type ConversationDraftRecord = {
  approvalModeKind: ConversationApprovalModeKind
  attachments: ConversationDraftAttachment[]
  composerModeKind: ConversationComposerModeKind
  text: string
}

type DraftStoragePayload = {
  version: 4
  drafts: Record<string, ConversationDraftRecord>
}

type PreviousConversationDraftRecord = Omit<ConversationDraftRecord, 'approvalModeKind'>

type PreviousDraftStoragePayload = {
  version: 3
  drafts: Record<string, PreviousConversationDraftRecord>
}

type V2ConversationDraftRecord = Omit<PreviousConversationDraftRecord, 'composerModeKind'>

type V2DraftStoragePayload = {
  version: 2
  drafts: Record<string, V2ConversationDraftRecord>
}

type LegacyDraftStoragePayload = {
  version: 1
  drafts: Record<string, string>
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export class ConversationDraftStore {
  private readonly storage: StorageLike | undefined
  private drafts: Record<string, ConversationDraftRecord>

  constructor(storage: StorageLike | undefined = safeLocalStorage()) {
    this.storage = storage
    this.drafts = readDrafts(storage)
  }

  get(identity: string): string {
    return this.drafts[identity]?.text ?? ''
  }

  getAttachments(identity: string): readonly ConversationDraftAttachment[] {
    return this.drafts[identity]?.attachments ?? []
  }

  getComposerModeKind(identity: string): ConversationComposerModeKind {
    return this.drafts[identity]?.composerModeKind ?? 'default'
  }

  getApprovalModeKind(identity: string): ConversationApprovalModeKind {
    return this.drafts[identity]?.approvalModeKind ?? 'request-approval'
  }

  set(identity: string, text: string): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text,
      attachments: current?.attachments ?? [],
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind: current?.approvalModeKind ?? 'request-approval'
    })
  }

  setAttachments(identity: string, attachments: readonly ConversationDraftAttachment[]): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: dedupeAttachments(attachments),
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind: current?.approvalModeKind ?? 'request-approval'
    })
  }

  setComposerModeKind(identity: string, composerModeKind: ConversationComposerModeKind): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: current?.attachments ?? [],
      composerModeKind,
      approvalModeKind: current?.approvalModeKind ?? 'request-approval'
    })
  }

  setApprovalModeKind(identity: string, approvalModeKind: ConversationApprovalModeKind): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: current?.attachments ?? [],
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind
    })
  }

  clear(identity: string): void {
    if (!(identity in this.drafts)) return
    const nextDrafts = { ...this.drafts }
    delete nextDrafts[identity]
    this.drafts = nextDrafts
    this.persist()
  }

  migrate(fromIdentity: string, toIdentity: string): string {
    if (fromIdentity === toIdentity) return this.get(toIdentity)

    const sourceDraft = this.drafts[fromIdentity]
    const targetDraft = this.drafts[toIdentity]
    if (sourceDraft === undefined) return targetDraft?.text ?? ''

    const nextDrafts = { ...this.drafts }
    delete nextDrafts[fromIdentity]
    if (targetDraft === undefined) nextDrafts[toIdentity] = sourceDraft
    this.drafts = nextDrafts
    this.persist()
    return nextDrafts[toIdentity]?.text ?? ''
  }

  private setRecord(identity: string, record: ConversationDraftRecord): void {
    const current = this.drafts[identity]
    if (
      record.text.length === 0 &&
      record.attachments.length === 0 &&
      record.composerModeKind === 'default' &&
      record.approvalModeKind === 'request-approval'
    ) {
      this.clear(identity)
      return
    }
    if (current && sameRecord(current, record)) return
    this.drafts = { ...this.drafts, [identity]: record }
    this.persist()
  }

  private persist(): void {
    if (!this.storage) return
    const payload: DraftStoragePayload = { version: 4, drafts: this.drafts }
    try {
      this.storage.setItem(draftStorageKey, JSON.stringify(payload))
    } catch {
      // Draft persistence is best effort and must never block the chat runtime.
    }
  }
}

function readDrafts(storage: StorageLike | undefined): Record<string, ConversationDraftRecord> {
  if (!storage) return {}
  try {
    const current = readCurrentDrafts(storage)
    if (current) return current

    const previous = readPreviousDrafts(storage)
    if (previous) return previous

    const v2 = readV2Drafts(storage)
    if (v2) return v2

    const legacyRaw = storage.getItem(legacyDraftStorageKey)
    if (!legacyRaw) return {}
    const legacy = JSON.parse(legacyRaw) as Partial<LegacyDraftStoragePayload>
    if (legacy.version !== 1 || !isLegacyDraftRecord(legacy.drafts)) return {}
    return Object.fromEntries(
      Object.entries(legacy.drafts).map(([identity, text]) => [
        identity,
        {
          text,
          attachments: [],
          composerModeKind: 'default',
          approvalModeKind: 'request-approval'
        }
      ])
    )
  } catch {
    return {}
  }
}

function readCurrentDrafts(
  storage: StorageLike
): Record<string, ConversationDraftRecord> | undefined {
  const raw = storage.getItem(draftStorageKey)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<DraftStoragePayload>
  return parsed.version === 4 && isDraftRecordMap(parsed.drafts)
    ? cloneDrafts(parsed.drafts)
    : undefined
}

function readPreviousDrafts(
  storage: StorageLike
): Record<string, ConversationDraftRecord> | undefined {
  const raw = storage.getItem(previousDraftStorageKey)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<PreviousDraftStoragePayload>
  if (parsed.version !== 3 || !isPreviousDraftRecordMap(parsed.drafts)) return undefined
  return Object.fromEntries(
    Object.entries(parsed.drafts).map(([identity, draft]) => [
      identity,
      {
        text: draft.text,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
        composerModeKind: draft.composerModeKind,
        approvalModeKind: 'request-approval'
      }
    ])
  )
}

function readV2Drafts(storage: StorageLike): Record<string, ConversationDraftRecord> | undefined {
  const raw = storage.getItem(v2DraftStorageKey)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<V2DraftStoragePayload>
  if (parsed.version !== 2 || !isV2DraftRecordMap(parsed.drafts)) return undefined
  return Object.fromEntries(
    Object.entries(parsed.drafts).map(([identity, draft]) => [
      identity,
      {
        text: draft.text,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
        composerModeKind: 'default',
        approvalModeKind: 'request-approval'
      }
    ])
  )
}

function cloneDrafts(
  drafts: Record<string, ConversationDraftRecord>
): Record<string, ConversationDraftRecord> {
  return Object.fromEntries(
    Object.entries(drafts).map(([identity, draft]) => [
      identity,
      {
        text: draft.text,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
        composerModeKind: draft.composerModeKind,
        approvalModeKind: normalizeApprovalModeKind(draft.approvalModeKind)
      }
    ])
  )
}

function isDraftRecordMap(value: unknown): value is Record<string, ConversationDraftRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(isDraftRecord)
}

function isDraftRecord(value: unknown): value is ConversationDraftRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ConversationDraftRecord>
  return (
    typeof record.text === 'string' &&
    Array.isArray(record.attachments) &&
    record.attachments.every(isDraftAttachment) &&
    (record.composerModeKind === 'default' || record.composerModeKind === 'plan')
  )
}

function isPreviousDraftRecordMap(
  value: unknown
): value is Record<string, PreviousConversationDraftRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false
    const record = draft as Partial<PreviousConversationDraftRecord>
    return (
      typeof record.text === 'string' &&
      Array.isArray(record.attachments) &&
      record.attachments.every(isDraftAttachment) &&
      (record.composerModeKind === 'default' || record.composerModeKind === 'plan')
    )
  })
}

function isV2DraftRecordMap(value: unknown): value is Record<string, V2ConversationDraftRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false
    const record = draft as Partial<V2ConversationDraftRecord>
    return (
      typeof record.text === 'string' &&
      Array.isArray(record.attachments) &&
      record.attachments.every(isDraftAttachment)
    )
  })
}

function normalizeApprovalModeKind(value: unknown): ConversationApprovalModeKind {
  return value === 'request-approval' || value === 'approve-for-me' || value === 'full-access'
    ? value
    : 'request-approval'
}

function isDraftAttachment(value: unknown): value is ConversationDraftAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<ConversationDraftAttachment>
  if (
    attachment.kind === 'artifact' &&
    typeof attachment.label === 'string' &&
    typeof attachment.sourceId === 'string' &&
    /^[A-Za-z0-9_-]{16,256}$/u.test(attachment.sourceId)
  ) {
    return true
  }
  return (
    (attachment.kind === 'file' || attachment.kind === 'folder') &&
    typeof attachment.path === 'string' &&
    typeof attachment.label === 'string' &&
    typeof attachment.fileUrl === 'string' &&
    (attachment.capabilityToken === undefined ||
      (typeof attachment.capabilityToken === 'string' && attachment.capabilityToken.length > 0)) &&
    (attachment.artifactPreviewToken === undefined ||
      (typeof attachment.artifactPreviewToken === 'string' &&
        attachment.artifactPreviewToken.length >= 16)) &&
    attachment.fileUrl.startsWith('file:')
  )
}

function isLegacyDraftRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((draft) => typeof draft === 'string')
}

function dedupeAttachments(
  attachments: readonly ConversationDraftAttachment[]
): ConversationDraftAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment) => {
    const key =
      attachment.kind === 'artifact'
        ? `artifact:${attachment.sourceId}`
        : `${attachment.kind}:${attachment.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sameRecord(left: ConversationDraftRecord, right: ConversationDraftRecord): boolean {
  return (
    left.text === right.text &&
    left.composerModeKind === right.composerModeKind &&
    left.approvalModeKind === right.approvalModeKind &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments)
  )
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export const conversationDraftStorageKey = draftStorageKey
export const previousConversationDraftStorageKey = previousDraftStorageKey
export const v2ConversationDraftStorageKey = v2DraftStorageKey
export const legacyConversationDraftStorageKey = legacyDraftStorageKey
