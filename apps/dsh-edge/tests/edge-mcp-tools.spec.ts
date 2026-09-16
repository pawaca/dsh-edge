import { describe, expect, it } from 'vitest'
import { publicToolName, mapMcpResultToContentBlocks, scrubMcpErrorMessage, evaluateMcpToolPolicy } from '../src/edge-mcp-tools.ts'
import { assertSafeUrl } from '../src/edge-mcp-client.ts'

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

  describe('scrubMcpErrorMessage', () => {
    it('strips bearer tokens', () => {
      expect(scrubMcpErrorMessage('auth failed: Bearer sk-abc123xyz')).toBe('auth failed: Bearer ***')
    })

    it('strips URL query strings', () => {
      expect(scrubMcpErrorMessage('error at https://example.com/api?token=secret&key=val')).toBe('error at https://example.com/api?***')
    })

    it('strips control characters', () => {
      expect(scrubMcpErrorMessage('bad\x00data\x01here')).toBe('baddatahere')
    })

    it('truncates to 300 chars', () => {
      const long = 'x'.repeat(500)
      expect(scrubMcpErrorMessage(long)).toHaveLength(300)
    })

    it('passes through clean messages unchanged', () => {
      expect(scrubMcpErrorMessage('Connection refused')).toBe('Connection refused')
    })
  })

  describe('evaluateMcpToolPolicy', () => {
    it('allow_all always allows', () => {
      expect(evaluateMcpToolPolicy('place_order', 'allow_all')).toBe('allow')
      expect(evaluateMcpToolPolicy('place_order', 'allow_all', false)).toBe('allow')
    })

    it('approve_all always asks', () => {
      expect(evaluateMcpToolPolicy('get_quote', 'approve_all')).toBe('ask')
      expect(evaluateMcpToolPolicy('get_quote', 'approve_all', true)).toBe('ask')
    })

    it('defaults to approve_all when undefined', () => {
      expect(evaluateMcpToolPolicy('get_quote', undefined)).toBe('ask')
    })

    it('read_only with readOnlyHint=true allows', () => {
      expect(evaluateMcpToolPolicy('custom_tool', 'read_only', true)).toBe('allow')
    })

    it('read_only with readOnlyHint=false asks', () => {
      expect(evaluateMcpToolPolicy('get_data', 'read_only', false)).toBe('ask')
    })

    it('read_only with no hint uses name patterns', () => {
      expect(evaluateMcpToolPolicy('get_stock_quote', 'read_only')).toBe('allow')
      expect(evaluateMcpToolPolicy('list_accounts', 'read_only')).toBe('allow')
      expect(evaluateMcpToolPolicy('search_symbols', 'read_only')).toBe('allow')
      expect(evaluateMcpToolPolicy('place_order', 'read_only')).toBe('ask')
      expect(evaluateMcpToolPolicy('delete_item', 'read_only')).toBe('ask')
    })

    it('read_only hint overrides name pattern', () => {
      // get_ pattern would allow, but explicit hint=false overrides
      expect(evaluateMcpToolPolicy('get_and_delete', 'read_only', false)).toBe('ask')
      // non-read name would ask, but explicit hint=true overrides
      expect(evaluateMcpToolPolicy('execute_trade', 'read_only', true)).toBe('allow')
    })
  })

  describe('assertSafeUrl', () => {
    it('allows public HTTPS URLs', () => {
      expect(() => assertSafeUrl('https://mcp.example.com/api')).not.toThrow()
    })

    it('allows localhost for development', () => {
      expect(() => assertSafeUrl('http://localhost:8787')).not.toThrow()
      expect(() => assertSafeUrl('http://127.0.0.1:8787')).not.toThrow()
    })

    it('blocks private IPs', () => {
      expect(() => assertSafeUrl('http://10.0.0.1/mcp')).toThrow('private IP')
      expect(() => assertSafeUrl('http://172.16.0.1/mcp')).toThrow('private IP')
      expect(() => assertSafeUrl('http://192.168.1.1/mcp')).toThrow('private IP')
    })

    it('blocks internal hostnames', () => {
      expect(() => assertSafeUrl('http://service.internal/mcp')).toThrow('blocked')
      expect(() => assertSafeUrl('http://db.local/mcp')).toThrow('blocked')
    })

    it('blocks non-HTTP protocols', () => {
      expect(() => assertSafeUrl('ftp://example.com/mcp')).toThrow('protocol')
    })
  })
})
