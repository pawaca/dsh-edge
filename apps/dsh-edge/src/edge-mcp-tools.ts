/** MCP tool naming and result mapping for the DSH tool runtime. */

import { createHash } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { MCP_LIMITS } from './edge-mcp-limits.ts'

export interface CachedMcpTool {
  name: string
  publicName: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown> | undefined
  annotations?: { readOnlyHint?: boolean } | undefined
}

export type McpToolPolicyMode = 'allow_all' | 'read_only' | 'approve_all'

export const DEFAULT_READ_ONLY_PATTERNS: readonly string[] = [
  'get_*', 'list_*', 'read_*', 'search_*', 'find_*', 'fetch_*', 'describe_*',
]

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/gu, ch => ch === '*' ? '\0' : `\\${ch}`)
  return new RegExp(`^${escaped.replaceAll('\0', '.*')}$`)
}

export function evaluateMcpToolPolicy(
  rawName: string,
  mode: McpToolPolicyMode | undefined,
  readOnlyHint?: boolean,
): 'allow' | 'ask' {
  const effective = mode ?? 'approve_all'
  if (effective === 'allow_all') return 'allow'
  if (effective === 'approve_all') return 'ask'
  if (readOnlyHint === true) return 'allow'
  if (readOnlyHint === false) return 'ask'
  return DEFAULT_READ_ONLY_PATTERNS.some(p => globToRegExp(p).test(rawName)) ? 'allow' : 'ask'
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  name?: string
  uri?: string
  resource?: { uri?: string; text?: string; mimeType?: string; blob?: string } | undefined
}

export interface McpCallResult {
  content: McpContentBlock[]
  structuredContent?: unknown
  isError?: boolean
}

/** Strip bearer tokens, URL query strings, and control chars from MCP error text. */
export function scrubMcpErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s"']+/giu, 'Bearer ***')
    .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/giu, '$1?***')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu, '')
    .slice(0, MCP_LIMITS.maxErrorMessageChars)
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized === joined && normalized.length <= MCP_LIMITS.maxPublicNameLength) {
    return normalized
  }
  const hash = hashSuffix(serverName, rawName)
  const maxPrefix = MCP_LIMITS.maxPublicNameLength - hash.length - 1
  return `${normalized.slice(0, maxPrefix)}_${hash}`
}

function hashSuffix(serverName: string, rawName: string): string {
  return createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
}

/** Validate an MCP outputSchema against the DSH supported subset; return undefined if unsupported. */
export function supportedOutputSchema(candidate: unknown): Record<string, unknown> | undefined {
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') return undefined
  try {
    assertSupportedJsonSchema(candidate)
    return candidate as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Raster formats the Edge attachment backends can persist (png + jpeg only). */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg'])
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

export function isImageMediaType(mimeType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mimeType)
}

export function decodeImageBlock(block: McpContentBlock): { data: Uint8Array; mediaType: string } | undefined {
  if (block.type !== 'image' || block.data === undefined || block.mimeType === undefined) return undefined
  if (!isImageMediaType(block.mimeType)) return undefined
  if (!CANONICAL_BASE64.test(block.data)) return undefined
  const bytes = Uint8Array.from(atob(block.data), c => c.charCodeAt(0))
  return { data: bytes, mediaType: block.mimeType }
}

export function containsImage(content: McpContentBlock[]): boolean {
  return content.some(b => b.type === 'image' && b.data !== undefined)
}

export function mapMcpResultToContentBlocks(result: McpCallResult): ContentBlock[] {
  if (result.isError) {
    const text = result.content
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n')
    return [{ type: 'text', text: text || 'MCP tool returned an error.' }]
  }
  const blocks: ContentBlock[] = []
  const textParts: string[] = []
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (block.type === 'resource_link' && block.uri !== undefined) {
      textParts.push(`Resource: ${block.name ?? 'unnamed'} (${block.uri})`)
    } else if (block.type === 'image' && block.data !== undefined) {
      textParts.push(`![image](data:${block.mimeType ?? 'image/png'};base64,${block.data})`)
    } else if (block.type === 'image') {
      textParts.push(`[image: ${block.mimeType ?? 'unknown type'}]`)
    } else if (block.type === 'audio') {
      textParts.push('[audio result unsupported on Cloudflare Workers]')
    } else if (block.type === 'resource' && block.resource?.text !== undefined) {
      const label = block.resource.uri ?? 'embedded resource'
      textParts.push(`--- ${label} ---\n${block.resource.text}`)
    } else if (block.type === 'resource') {
      textParts.push('[embedded resource: binary content not displayed]')
    } else {
      textParts.push(`[unsupported MCP content type: ${block.type}]`)
    }
  }
  if (textParts.length > 0) {
    blocks.push({ type: 'text', text: textParts.join('\n') })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(empty MCP result)' }]
}
