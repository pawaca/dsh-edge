import { describe, expect, it, vi } from 'vitest'
import { EdgeSessionStore } from '../src/session-store.ts'

const note = (store: object, zone: string) => EdgeSessionStore.prototype.noteOwnerTimeZone.call(store as never, zone)

describe('owner time zone for the current-date context', () => {
  it('writes only a changed zone, durably before memory', async () => {
    const put = vi.fn(async () => {})
    const store = { ready: Promise.resolve(), ownerTimeZone: 'UTC', doStorage: { put } }
    await note(store, 'UTC')
    expect(put).not.toHaveBeenCalled()
    await note(store, 'Asia/Tokyo')
    expect(put).toHaveBeenCalledWith('dsh-edge:owner-time-zone', 'Asia/Tokyo')
    expect(store.ownerTimeZone).toBe('Asia/Tokyo')
  })

  it('keeps the previous zone when the write fails, so a retry writes it again', async () => {
    const put = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce(undefined)
    const store = { ready: Promise.resolve(), ownerTimeZone: 'UTC', doStorage: { put } }
    await expect(note(store, 'Asia/Tokyo')).rejects.toThrow('storage unavailable')
    expect(store.ownerTimeZone).toBe('UTC')
    await note(store, 'Asia/Tokyo')
    expect(put).toHaveBeenCalledTimes(2)
    expect(store.ownerTimeZone).toBe('Asia/Tokyo')
  })
})
