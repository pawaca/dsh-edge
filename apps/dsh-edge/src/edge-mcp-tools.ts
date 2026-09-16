/** MCP tool naming and result mapping for the DSH tool runtime. */

import { createHash } from 'node:crypto'
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
  resource?: { uri?: string; text?: string; mimeType?: string; blob?: string } | undefined
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
  return createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
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
