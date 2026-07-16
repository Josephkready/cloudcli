import assert from 'node:assert/strict';
import test from 'node:test';

import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';

const ENV = 'CLOUDCLI_DEFAULT_PERMISSION_MODE';

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[ENV];
  if (value === undefined) {
    delete process.env[ENV];
  } else {
    process.env[ENV] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = prev;
    }
  }
}

test('defaults to the baked-in mode when the override env is unset', () => {
  withEnv(undefined, () => {
    assert.equal(
      providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode,
      'default',
    );
  });
});

test('override env sets the default for every provider that supports the mode', () => {
  withEnv('bypassPermissions', () => {
    for (const caps of providerCapabilitiesService.listAllProviderCapabilities()) {
      assert.equal(
        caps.defaultPermissionMode,
        'bypassPermissions',
        `provider ${caps.provider} should default to bypassPermissions`,
      );
      // Sanity: the applied default is always a mode the provider actually lists.
      assert.ok(caps.permissionModes.includes(caps.defaultPermissionMode));
    }
  });
});

test('override is ignored for a provider that does not list the mode (clamped, never invalid)', () => {
  // codex lists ['default','acceptEdits','bypassPermissions'] — no 'plan'; claude has 'plan'.
  withEnv('plan', () => {
    const claude = providerCapabilitiesService.getProviderCapabilities('claude');
    const codex = providerCapabilitiesService.getProviderCapabilities('codex');
    assert.equal(claude.defaultPermissionMode, 'plan');
    assert.equal(codex.defaultPermissionMode, 'default');
    assert.ok(codex.permissionModes.includes(codex.defaultPermissionMode));
  });
});

test('unknown / garbage override value is ignored', () => {
  withEnv('totally-not-a-mode', () => {
    assert.equal(
      providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode,
      'default',
    );
  });
});

test('whitespace-only override is ignored', () => {
  withEnv('   ', () => {
    assert.equal(
      providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode,
      'default',
    );
  });
});

test('override returns a copy and does not mutate the shared matrix', () => {
  withEnv('bypassPermissions', () => {
    providerCapabilitiesService.getProviderCapabilities('claude');
  });
  // With the env cleared, the baked-in default must be intact (no mutation leaked).
  withEnv(undefined, () => {
    assert.equal(
      providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode,
      'default',
    );
  });
});
