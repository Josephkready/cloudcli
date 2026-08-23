import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialUser } from './auth.js';

test('createInitialUser keeps the existence check and insert in one synchronous transaction', () => {
  const events: string[] = [];
  let existingUser = false;
  const database = {
    transaction: (operation: () => unknown) => () => {
      events.push('begin');
      const result = operation();
      events.push('commit');
      return result;
    },
  };
  const users = {
    hasUsers: () => {
      events.push('check');
      return existingUser;
    },
    createUser: (username: string, passwordHash: string) => {
      events.push('create');
      existingUser = true;
      return { id: 1, username, password_hash: passwordHash };
    },
  };

  const created = createInitialUser('joseph', 'hashed', { database, users });
  const duplicate = createInitialUser('other', 'hashed-again', { database, users });

  assert.deepEqual(created, { id: 1, username: 'joseph', password_hash: 'hashed' });
  assert.equal(duplicate, null);
  assert.deepEqual(events, [
    'begin', 'check', 'create', 'commit',
    'begin', 'check', 'commit',
  ]);
});
