import { describe, expect, it } from 'vitest'
import { publicToolName, mapMcpResultToContentBlocks } from '../src/edge-mcp-tools.ts'

describe('edge-mcp-tools', () => {
  describe('publicToolName', () => {
    it('joins serverName and rawName with mcp__ prefix', () => {
      expect(publicToolName('github', 'search')).toBe('mcp__github__search')
    })

    it('replaces invalid characters with underscores and appends hash', () => {
      const name = publicToolName('my-server', 'tool.name')
      expect(name).toMatch(/^mcp__my-server__tool_name_[0-9a-f]+$/)
    })

    it('preserves hyphens and underscores', () => {
      expect(publicToolName('my_server', 'my-tool')).toBe('mcp__my_server__my-tool')
    })

    it('truncates and appends hash for long names', () => {
      const longName = 'a'.repeat(60)
      const result = publicToolName('server', longName)
      expect(result.length).toBeLessThanOrEqual(64)
      expect(result).toContain('_')
    })

    it('produces stable names for the same input', () => {
      const a = publicToolName('github', 'create_issue')
      const b = publicToolName('github', 'create_issue')
      expect(a).toBe(b)
    })

    it('produces different names for different servers', () => {
      const a = publicToolName('github', 'search')
      const b = publicToolName('linear', 'search')
      expect(a).not.toBe(b)
    })
  })

  describe('mapMcpResultToContentBlocks', () => {
    it('maps text content', () => {
      const blocks = mapMcpResultToContentBlocks({
        content: [{ type: 'text', text: 'hello' }],
      })
      expect(blocks).toEqual([{ type: 'text', text: 'hello' }])
    })

    it('joins multiple text blocks', () => {
      const blocks = mapMcpResultToContentBlocks({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      })
      expect(blocks).toEqual([{ type: 'text', text: 'line 1\nline 2' }])
    })

    it('maps error results', () => {
      const blocks = mapMcpResultToContentBlocks({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      })
      expect((blocks[0] as { text: string }).text).toBe('something went wrong')
    })

    it('maps resource links as text', () => {
      const blocks = mapMcpResultToContentBlocks({
        content: [{ type: 'resource_link', name: 'file', uri: 'https://example.com/file' }],
      })
      expect((blocks[0] as { text: string }).text).toContain('Resource: file (https://example.com/file)')
    })

    it('maps unsupported types as diagnostic text', () => {
      const blocks = mapMcpResultToContentBlocks({
        content: [{ type: 'audio' }],
      })
      expect((blocks[0] as { text: string }).text).toContain('audio result unsupported')
    })

    it('handles empty content', () => {
      const blocks = mapMcpResultToContentBlocks({ content: [] })
      expect((blocks[0] as { text: string }).text).toBe('(empty MCP result)')
    })
  })
})
