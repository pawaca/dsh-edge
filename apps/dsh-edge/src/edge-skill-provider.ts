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

const META_PREFIX = 'dsh-edge:skill:'
const CONTENT_PREFIX = 'dsh-edge:skill-content:'
const PROVIDER_NAME = 'edge'

interface StoredSkillMeta {
  name: string
  description: string
  whenToUse?: string
  modelInvocable?: boolean
  userInvocable?: boolean
  metadata?: Record<string, unknown>
}

export interface StoredSkill extends StoredSkillMeta {
  content: string
}

export interface EdgeSkillProviderConfig {
  storage: DurableObjectStorage
}

export const name = 'edge-skill-provider'
export const inject = ['skills']

export function apply(ctx: Context, config: EdgeSkillProviderConfig): void {
  const { storage } = config
  ctx.effect(() => ctx.skills.registerProvider((_control: SkillProviderControl): SkillProvider => ({
    name: PROVIDER_NAME,

    async list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      const entries = await storage.list<StoredSkillMeta>({ prefix: META_PREFIX })
      const candidates: SkillCandidate[] = []
      for (const [, meta] of entries) {
        if (typeof meta !== 'object' || meta === null) continue
        candidates.push(toCandidate(meta))
      }
      return candidates
    },

    async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const meta = await storage.get<StoredSkillMeta>(metaKey(candidate.name))
      if (meta === undefined) return undefined
      const content = await storage.get<string>(contentKey(candidate.name))
      return {
        name: meta.name,
        description: meta.description,
        content: content ?? '',
        invocation: {
          modelInvocable: meta.modelInvocable ?? true,
          userInvocable: meta.userInvocable ?? true,
        },
        source: 'custom',
        provider: PROVIDER_NAME,
        ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
        ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
      }
    },
  })))
}

function toCandidate(meta: StoredSkillMeta): SkillCandidate {
  return {
    name: meta.name,
    description: meta.description,
    invocation: {
      modelInvocable: meta.modelInvocable ?? true,
      userInvocable: meta.userInvocable ?? true,
    },
    source: 'custom',
    provider: PROVIDER_NAME,
    rank: BUNDLED_SKILL_RANK,
    locator: meta.name,
    ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
    ...(meta.metadata !== undefined ? { metadata: meta.metadata } : {}),
  }
}

function metaKey(skillName: string): string {
  return `${META_PREFIX}${skillName}`
}

function contentKey(skillName: string): string {
  return `${CONTENT_PREFIX}${skillName}`
}

/** Write or overwrite a skill in Durable Object storage. */
export async function putSkill(
  storage: DurableObjectStorage,
  skill: StoredSkill,
): Promise<void> {
  const { content, ...meta } = skill
  await storage.put({
    [metaKey(skill.name)]: meta,
    [contentKey(skill.name)]: content,
  } as Record<string, unknown>)
}

/** Remove a skill from Durable Object storage. */
export async function deleteSkill(
  storage: DurableObjectStorage,
  skillName: string,
): Promise<boolean> {
  const count = await storage.delete([metaKey(skillName), contentKey(skillName)])
  return count > 0
}

/** List all stored skill names. */
export async function listSkillNames(
  storage: DurableObjectStorage,
): Promise<string[]> {
  const entries = await storage.list<StoredSkillMeta>({ prefix: META_PREFIX })
  const names: string[] = []
  for (const [key] of entries) {
    names.push(key.slice(META_PREFIX.length))
  }
  return names
}
