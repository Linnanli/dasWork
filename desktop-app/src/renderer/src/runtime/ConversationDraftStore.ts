import type { ApprovalModeKind, Personality } from '../../../shared/codexIpcApi'

const draftStorageKey = 'das-cowork.conversation-drafts.v5'
const previousDraftStorageKey = 'das-cowork.conversation-drafts.v4'
const v3DraftStorageKey = 'das-cowork.conversation-drafts.v3'
const v2DraftStorageKey = 'das-cowork.conversation-drafts.v2'
const legacyDraftStorageKey = 'das-cowork.conversation-drafts.v1'

export type ConversationComposerModeKind = 'default' | 'plan'
export type ConversationApprovalModeKind = ApprovalModeKind
export type ConversationPersonality = Personality

export type ConversationDraftAttachment = {
  capabilityToken?: string
  fileUrl: string
  kind: 'file' | 'folder'
  label: string
  path: string
}

type ConversationDraftRecord = {
  approvalModeKind: ConversationApprovalModeKind
  attachments: ConversationDraftAttachment[]
  composerModeKind: ConversationComposerModeKind
  personality: ConversationPersonality
  text: string
}

type DraftStoragePayload = {
  version: 5
  drafts: Record<string, ConversationDraftRecord>
}

type PreviousConversationDraftRecord = Omit<ConversationDraftRecord, 'personality'>

type PreviousDraftStoragePayload = {
  version: 4
  drafts: Record<string, PreviousConversationDraftRecord>
}

type V3ConversationDraftRecord = Omit<PreviousConversationDraftRecord, 'approvalModeKind'>

type V3DraftStoragePayload = {
  version: 3
  drafts: Record<string, V3ConversationDraftRecord>
}

type V2ConversationDraftRecord = Omit<V3ConversationDraftRecord, 'composerModeKind'>

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

  getPersonality(identity: string): ConversationPersonality {
    return this.drafts[identity]?.personality ?? 'none'
  }

  set(identity: string, text: string): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text,
      attachments: current?.attachments ?? [],
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind: current?.approvalModeKind ?? 'request-approval',
      personality: current?.personality ?? 'none'
    })
  }

  setAttachments(identity: string, attachments: readonly ConversationDraftAttachment[]): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: dedupeAttachments(attachments),
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind: current?.approvalModeKind ?? 'request-approval',
      personality: current?.personality ?? 'none'
    })
  }

  setComposerModeKind(identity: string, composerModeKind: ConversationComposerModeKind): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: current?.attachments ?? [],
      composerModeKind,
      approvalModeKind: current?.approvalModeKind ?? 'request-approval',
      personality: current?.personality ?? 'none'
    })
  }

  setApprovalModeKind(identity: string, approvalModeKind: ConversationApprovalModeKind): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: current?.attachments ?? [],
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind,
      personality: current?.personality ?? 'none'
    })
  }

  setPersonality(identity: string, personality: ConversationPersonality): void {
    const current = this.drafts[identity]
    this.setRecord(identity, {
      text: current?.text ?? '',
      attachments: current?.attachments ?? [],
      composerModeKind: current?.composerModeKind ?? 'default',
      approvalModeKind: current?.approvalModeKind ?? 'request-approval',
      personality
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
      record.approvalModeKind === 'request-approval' &&
      record.personality === 'none'
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
    const payload: DraftStoragePayload = { version: 5, drafts: this.drafts }
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

    const v3 = readV3Drafts(storage)
    if (v3) return v3

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
          approvalModeKind: 'request-approval',
          personality: 'none'
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
  return parsed.version === 5 && isDraftRecordMap(parsed.drafts)
    ? cloneDrafts(parsed.drafts)
    : undefined
}

function readPreviousDrafts(
  storage: StorageLike
): Record<string, ConversationDraftRecord> | undefined {
  const raw = storage.getItem(previousDraftStorageKey)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<PreviousDraftStoragePayload>
  if (parsed.version !== 4 || !isPreviousDraftRecordMap(parsed.drafts)) return undefined
  return Object.fromEntries(
    Object.entries(parsed.drafts).map(([identity, draft]) => [
      identity,
      {
        text: draft.text,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
        composerModeKind: draft.composerModeKind,
        approvalModeKind: normalizeApprovalModeKind(draft.approvalModeKind),
        personality: 'none'
      }
    ])
  )
}

function readV3Drafts(storage: StorageLike): Record<string, ConversationDraftRecord> | undefined {
  const raw = storage.getItem(v3DraftStorageKey)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Partial<V3DraftStoragePayload>
  if (parsed.version !== 3 || !isV3DraftRecordMap(parsed.drafts)) return undefined
  return Object.fromEntries(
    Object.entries(parsed.drafts).map(([identity, draft]) => [
      identity,
      {
        text: draft.text,
        attachments: draft.attachments.map((attachment) => ({ ...attachment })),
        composerModeKind: draft.composerModeKind,
        approvalModeKind: 'request-approval',
        personality: 'none'
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
        approvalModeKind: 'request-approval',
        personality: 'none'
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
        approvalModeKind: normalizeApprovalModeKind(draft.approvalModeKind),
        personality: normalizePersonality(draft.personality)
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

function isV3DraftRecordMap(value: unknown): value is Record<string, V3ConversationDraftRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((draft) => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false
    const record = draft as Partial<V3ConversationDraftRecord>
    return (
      typeof record.text === 'string' &&
      Array.isArray(record.attachments) &&
      record.attachments.every(isDraftAttachment) &&
      (record.composerModeKind === 'default' || record.composerModeKind === 'plan')
    )
  })
}

function normalizeApprovalModeKind(value: unknown): ConversationApprovalModeKind {
  return value === 'request-approval' || value === 'approve-for-me' || value === 'full-access'
    ? value
    : 'request-approval'
}

function normalizePersonality(value: unknown): ConversationPersonality {
  return value === 'friendly' || value === 'pragmatic' || value === 'none' ? value : 'none'
}

function isDraftAttachment(value: unknown): value is ConversationDraftAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attachment = value as Partial<ConversationDraftAttachment>
  return (
    (attachment.kind === 'file' || attachment.kind === 'folder') &&
    typeof attachment.path === 'string' &&
    typeof attachment.label === 'string' &&
    typeof attachment.fileUrl === 'string' &&
    (attachment.capabilityToken === undefined ||
      (typeof attachment.capabilityToken === 'string' && attachment.capabilityToken.length > 0)) &&
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
    const key = `${attachment.kind}:${attachment.path}`
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
    left.personality === right.personality &&
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
export const v3ConversationDraftStorageKey = v3DraftStorageKey
export const v2ConversationDraftStorageKey = v2DraftStorageKey
export const legacyConversationDraftStorageKey = legacyDraftStorageKey
