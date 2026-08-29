/** Edge skill provider backed by Durable Object KV storage. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill'

const STORAGE_KEY_PREFIX = 'dsh-edge:skill:'
const PROVIDER_NAME = 'edge'

interface StoredSkill {
  name: string
  description: string
  content: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  metadata?: Record<string, unknown>
}

export interface EdgeSkillProviderConfig {
  storage: DurableObjectStorage
}

export const name = 'edge-skill-provider'
export const inject = ['skills']

export function apply(ctx: Context, config: EdgeSkillProviderConfig): void {
  const { storage } = config
  ctx.skills.registerProvider((_control: SkillProviderControl): SkillProvider => ({
    name: PROVIDER_NAME,

    async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      const entries = await storage.list<StoredSkill>({ prefix: STORAGE_KEY_PREFIX })
      const candidates: SkillCandidate[] = []
      for (const [, stored] of entries) {
        if (typeof stored !== 'object' || stored === null) continue
        candidates.push(toCandidate(stored))
      }
      return candidates
    },

    async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const stored = await storage.get<StoredSkill>(storageKey(candidate.name))
      if (stored === undefined) return undefined
      return {
        name: stored.name,
        description: stored.description,
        content: stored.content,
        invocation: {
          modelInvocable: stored.modelInvocable ?? true,
          userInvocable: stored.userInvocable ?? true,
        },
        source: 'custom',
        provider: PROVIDER_NAME,
        ...(stored.whenToUse !== undefined ? { whenToUse: stored.whenToUse } : {}),
        ...(stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
      }
    },
  }))
}

function toCandidate(stored: StoredSkill): SkillCandidate {
  return {
    name: stored.name,
    description: stored.description,
    invocation: {
      modelInvocable: stored.modelInvocable ?? true,
      userInvocable: stored.userInvocable ?? true,
    },
    source: 'custom',
    provider: PROVIDER_NAME,
    rank: BUNDLED_SKILL_RANK,
    locator: stored.name,
    ...(stored.whenToUse !== undefined ? { whenToUse: stored.whenToUse } : {}),
    ...(stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
  }
}

function storageKey(skillName: string): string {
  return `${STORAGE_KEY_PREFIX}${skillName}`
}

/** Write or overwrite a skill in Durable Object storage. */
export async function putSkill(
  storage: DurableObjectStorage,
  skill: StoredSkill,
): Promise<void> {
  await storage.put(storageKey(skill.name), skill)
}

/** Remove a skill from Durable Object storage. */
export async function deleteSkill(
  storage: DurableObjectStorage,
  skillName: string,
): Promise<boolean> {
  return await storage.delete(storageKey(skillName))
}

/** List all stored skill names. */
export async function listSkillNames(
  storage: DurableObjectStorage,
): Promise<string[]> {
  const entries = await storage.list<StoredSkill>({ prefix: STORAGE_KEY_PREFIX })
  const names: string[] = []
  for (const [key] of entries) {
    names.push(key.slice(STORAGE_KEY_PREFIX.length))
  }
  return names
}
