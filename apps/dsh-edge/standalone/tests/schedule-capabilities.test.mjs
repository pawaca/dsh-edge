import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { RRule } from '@deepseek-ai/dsh-util-time'
const require = createRequire(import.meta.url)
const web = createRequire(require.resolve('@deepseek-ai/dsh-web-app/package.json'))
test('patched schedule tools advertise only current-session delivery', () => {
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-tool-schedule'), 'utf8')
  assert.match(source, /const TARGET_CHOICES = \[\s*"this_session"\s*\]/)
  assert.ok(!source.includes('use new_once or new for independent work'))
})
test('patched task editor offers no automatic Session targets or unsupported manual create', () => {
  const source = readFileSync(join(dirname(web.resolve('@deepseek-ai/dsh-client-ui-schedule/package.json')), 'lib/client.js'), 'utf8')
  assert.ok(!source.includes('...["new_once", "new"].map'))
  assert.match(source, /disabled: true,\s*title: "请在会话中让助手创建日程/)
})
test('RRULE namespace import works in the standalone Node closure', () => {
  const result = RRule.parse('DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY;COUNT=1')
  assert.equal(result.kind, 'accepted')
  assert.equal(result.rule.next(Date.parse('2098-12-01')), '2099-01-01T00:00:00.000Z')
})
