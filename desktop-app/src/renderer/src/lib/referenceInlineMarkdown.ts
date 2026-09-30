import { defaultRehypePlugins, type StreamdownProps } from 'streamdown'

import { inlineCodeReference } from './referenceInlineCode'
import { classifyReferenceTarget, isMarkdownChatImageSource } from './referenceInlineTarget'

export const inlineReferenceCodeTagName = 'inline-reference-code'

const protectedReferenceHref = 'https://inline-reference.invalid/'
const protectedReferenceProperty = 'dataInlineReferenceHref'
const protectedImageSrc = 'https://chat-image.invalid/'
const protectedImageProperty = 'dataChatImageSource'

type SanitizeOptions = {
  attributes?: Record<string, readonly unknown[] | undefined>
}

type RehypePlugins = NonNullable<StreamdownProps['rehypePlugins']>
type RehypePlugin = Exclude<RehypePlugins[number], readonly unknown[] | { plugins?: unknown }>

const defaultSanitize = defaultRehypePlugins.sanitize as unknown as [RehypePlugin, SanitizeOptions]
const [sanitizePlugin, sanitizeOptions] = defaultSanitize

/**
 * The reference renderer classifies the raw Markdown href before falling back
 * to an ordinary link. Preserve that ordering around Streamdown's sanitizer
 * and hardener so local paths and semantic references reach our classifier.
 */
export const referenceInlineRehypePlugins: RehypePlugins = [
  defaultRehypePlugins.raw,
  protectInlineReferenceLinks,
  protectChatImageSources,
  [
    sanitizePlugin,
    {
      ...sanitizeOptions,
      attributes: {
        ...sanitizeOptions.attributes,
        a: [...(sanitizeOptions.attributes?.a ?? []), protectedReferenceProperty],
        img: [...(sanitizeOptions.attributes?.img ?? []), protectedImageProperty]
      }
    }
  ],
  defaultRehypePlugins.harden,
  restoreInlineReferenceLinks,
  restoreChatImageSources,
  decorateInlineCodeReferences
]

type HastNode = {
  children?: HastNode[]
  properties?: Record<string, unknown>
  tagName?: string
  type: string
  value?: string
}

function chatImageSourceNodes(node: HastNode, restore: boolean): void {
  if (node.type === 'element' && node.tagName === 'img' && node.properties) {
    const original = stringProperty(node.properties[protectedImageProperty])
    const src = stringProperty(node.properties.src)
    if (restore) {
      delete node.properties[protectedImageProperty]
      if (src === protectedImageSrc && original && isMarkdownChatImageSource(original)) {
        node.properties.src = original
      }
    } else if (src && isMarkdownChatImageSource(src)) {
      node.properties[protectedImageProperty] = src
      node.properties.src = protectedImageSrc
    }
  }
  for (const child of node.children ?? []) chatImageSourceNodes(child, restore)
}

function protectChatImageSources(): (tree: unknown) => void {
  return (tree) => chatImageSourceNodes(tree as HastNode, false)
}

function restoreChatImageSources(): (tree: unknown) => void {
  return (tree) => chatImageSourceNodes(tree as HastNode, true)
}

function protectInlineReferenceLinkNodes(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'a') {
    const href = stringProperty(node.properties?.href)
    if (href && isInlineReferenceHref(href, hastTextContent(node))) {
      node.properties = {
        ...node.properties,
        href: protectedReferenceHref,
        [protectedReferenceProperty]: href
      }
    }
  }

  for (const child of node.children ?? []) protectInlineReferenceLinkNodes(child)
}

function restoreInlineReferenceLinkNodes(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'a' && node.properties) {
    const originalHref = stringProperty(node.properties[protectedReferenceProperty])
    const currentHref = stringProperty(node.properties.href)
    delete node.properties[protectedReferenceProperty]

    if (
      currentHref === protectedReferenceHref &&
      originalHref &&
      isInlineReferenceHref(originalHref, hastTextContent(node))
    ) {
      node.properties.href = originalHref
      delete node.properties.rel
      delete node.properties.target
    }
  }

  for (const child of node.children ?? []) restoreInlineReferenceLinkNodes(child)
}

function decorateInlineCodeReferenceNodes(node: HastNode, parentTagName?: string): void {
  if (node.type === 'element' && node.tagName === 'code') {
    if (parentTagName !== 'pre' && inlineCodeReference(hastTextContent(node))) {
      node.tagName = inlineReferenceCodeTagName
    }
    return
  }

  const childParentTagName = node.type === 'element' ? node.tagName : undefined
  for (const child of node.children ?? []) {
    decorateInlineCodeReferenceNodes(child, childParentTagName)
  }
}

function hastTextContent(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastTextContent).join('')
}

function isInlineReferenceHref(href: string, label: string): boolean {
  const descriptor = classifyReferenceTarget({ href, label })
  return Boolean(
    descriptor && descriptor.kind !== 'external-url' && descriptor.kind !== 'unsupported'
  )
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function protectInlineReferenceLinks(): (tree: unknown) => void {
  return (tree) => protectInlineReferenceLinkNodes(tree as HastNode)
}

function restoreInlineReferenceLinks(): (tree: unknown) => void {
  return (tree) => restoreInlineReferenceLinkNodes(tree as HastNode)
}

function decorateInlineCodeReferences(): (tree: unknown) => void {
  return (tree) => decorateInlineCodeReferenceNodes(tree as HastNode)
}
