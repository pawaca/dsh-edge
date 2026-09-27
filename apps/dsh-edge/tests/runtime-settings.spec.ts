import { describe, expect, it } from 'vitest'
import { parseRuntimeSettingsPatch } from '../src/runtime-settings.ts'

describe('runtime settings patch', () => {
  it('accepts each offered routing policy and sleep window', () => {
    expect(parseRuntimeSettingsPatch({})).toEqual({})
    expect(parseRuntimeSettingsPatch({ bashRouting: 'light', containerSleepMinutes: 30 }))
      .toEqual({ bashRouting: 'light', containerSleepMinutes: 30 })
    for (const bashRouting of ['auto', 'light', 'container']) {
      expect(parseRuntimeSettingsPatch({ bashRouting })).toEqual({ bashRouting })
    }
  })

  it('rejects values the Settings page does not offer and unknown keys', () => {
    expect(parseRuntimeSettingsPatch(null)).toMatch(/object/u)
    expect(parseRuntimeSettingsPatch([])).toMatch(/object/u)
    expect(parseRuntimeSettingsPatch({ bashRouting: 'sometimes' })).toMatch(/bashRouting/u)
    expect(parseRuntimeSettingsPatch({ containerSleepMinutes: 7 })).toMatch(/containerSleepMinutes/u)
    expect(parseRuntimeSettingsPatch({ containerSleepMinutes: '10' })).toMatch(/containerSleepMinutes/u)
    expect(parseRuntimeSettingsPatch({ bash: 'direct' })).toMatch(/unknown setting: bash/u)
  })
})
