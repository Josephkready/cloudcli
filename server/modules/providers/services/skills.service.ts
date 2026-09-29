import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { ProviderSkill, ProviderSkillListOptions } from '@/shared/types.js';

/**
 * How long a `(provider, workspacePath)` skills listing is served from memory
 * before the filesystem is walked again.
 *
 * Skill files are user-editable while the app is running, so this is a short
 * TTL rather than the multi-day disk cache `provider-models.service.ts` uses
 * for the (much more stable) model catalog: skills is UI-facing, not
 * correctness-critical, and a few seconds is enough to collapse the repeated
 * `GET /:provider/skills` calls a picker open/project switch fires without
 * making an edited skill file wait long to show up.
 */
export const SKILLS_CACHE_TTL_MS = 5000;

type CacheEntry = {
  expiresAt: number;
  skills: ProviderSkill[];
};

const cache = new Map<string, CacheEntry>();

const cacheKey = (providerName: string, options?: ProviderSkillListOptions): string =>
  `${providerName}::${options?.workspacePath ?? ''}`;

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   *
   * Cached in memory per `(provider, workspacePath)` for `SKILLS_CACHE_TTL_MS`
   * so repeat picker opens in the same session don't re-walk and re-parse
   * every `SKILL.md` (and, for Claude, every plugin config) on each call.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const key = cacheKey(providerName, options);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        return cached.skills;
      }
      // Sweep the expired entry now rather than leaving it in the map forever:
      // the cache is only ever read lazily (no background timer), so without
      // this an entry for every distinct (provider, workspacePath) a session
      // ever visits would sit in memory for the life of the process.
      cache.delete(key);
    }

    const provider = providerRegistry.resolveProvider(providerName);
    const skills = await provider.skills.listSkills(options);
    cache.set(key, { expiresAt: now + SKILLS_CACHE_TTL_MS, skills });
    return skills;
  },
};
