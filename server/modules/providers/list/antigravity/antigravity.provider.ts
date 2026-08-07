import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

import { AntigravityProviderAuth } from './antigravity-auth.provider.js';
import { AntigravityMcpProvider } from './antigravity-mcp.provider.js';
import { AntigravityProviderModels } from './antigravity-models.provider.js';
import { AntigravitySessionSynchronizer } from './antigravity-session-synchronizer.provider.js';
import { AntigravitySessionsProvider } from './antigravity-sessions.provider.js';
import { AntigravitySkillsProvider } from './antigravity-skills.provider.js';

export class AntigravityProvider extends AbstractProvider {
  readonly models: IProviderModels = new AntigravityProviderModels();
  readonly mcp = new AntigravityMcpProvider();
  readonly auth: IProviderAuth = new AntigravityProviderAuth();
  readonly skills: IProviderSkills = new AntigravitySkillsProvider();
  readonly sessions: IProviderSessions = new AntigravitySessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AntigravitySessionSynchronizer();

  constructor() {
    super('antigravity');
  }
}
