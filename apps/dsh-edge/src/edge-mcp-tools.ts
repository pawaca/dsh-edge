/** MCP tool naming and result mapping for the DSH tool runtime. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

const MAX_PUBLIC_NAME_LENGTH = 64

export interface CachedMcpTool {
  name: string
  publicName: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  name?: string
  uri?: string
}

export interface McpCallResult {
  content: McpContentBlock[]
  isError?: boolean
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/gu, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized
  }
  const hash = hashSuffix(serverName, rawName)
  const maxPrefix = MAX_PUBLIC_NAME_LENGTH - hash.length - 1
  return `${normalized.slice(0, maxPrefix)}_${hash}`
}

function hashSuffix(serverName: string, rawName: string): string {
  const input = `${serverName}\0${rawName}`
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 12)
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
    } else if (block.type === 'image') {
      textParts.push(`[image: ${block.mimeType ?? 'unknown type'}]`)
    } else if (block.type === 'audio') {
      textParts.push('[audio result unsupported on Cloudflare Workers]')
    } else if (block.type === 'resource') {
      textParts.push('[embedded resource unsupported on Cloudflare Workers]')
    } else {
      textParts.push(`[unsupported MCP content type: ${block.type}]`)
    }
  }
  if (textParts.length > 0) {
    blocks.push({ type: 'text', text: textParts.join('\n') })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(empty MCP result)' }]
}
