import express from 'express';
import bcrypt from 'bcrypt';

import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { closeWebSocketsForUser } from '../modules/websocket/services/websocket-session-revocation.service.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

import { LoginAttemptLimiter } from './login-attempt-limiter.js';

const router = express.Router();
const db = getConnection();
const loginAttemptLimiter = new LoginAttemptLimiter();
const LOGIN_THROTTLE_LOG_INTERVAL_MS = 60_000;

export function createLoginThrottleLogger(dependencies = {}) {
  const clock = dependencies.clock || Date.now;
  const warn = dependencies.warn || console.warn;
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;

  return (reason) => {
    const now = clock();
    if (now - lastLoggedAt < LOGIN_THROTTLE_LOG_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    warn('[Auth] Login attempts rate limited', { reason, suppressed });
    lastLoggedAt = now;
    suppressed = 0;
  };
}

const logLoginThrottle = createLoginThrottleLogger();

/** Atomically creates the one allowed user, or returns null once setup is complete. */
export function createInitialUser(username, passwordHash, dependencies = {}) {
  const database = dependencies.database || db;
  const users = dependencies.users || userDb;
  return database.transaction(() => {
    if (users.hasUsers()) {
      return null;
    }
    return users.createUser(username, passwordHash);
  })();
}

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({ 
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration (setup) - only allowed if no users exist
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }
    
    // Hash outside the shared SQLite connection's transaction. bcrypt yields
    // to the event loop, and holding BEGIN across that await would pull every
    // unrelated write on the singleton connection into this request.
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = createInitialUser(username, passwordHash);
    if (!user) {
      return res.status(403).json({ error: 'User already exists. This is a single-user system.' });
    }

    const token = generateToken(user);

    // Update last login (non-fatal, outside transaction)
    userDb.updateLastLogin(user.id);

    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      token
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

export function readLoginClientAddress(req) {
  const remoteAddress = req?.socket?.remoteAddress;
  return typeof remoteAddress === 'string' ? remoteAddress : '<unknown>';
}

export function createLoginHandler(dependencies = {}) {
  const users = dependencies.users || userDb;
  const comparePassword = dependencies.comparePassword || bcrypt.compare;
  const createToken = dependencies.createToken || generateToken;
  const limiter = dependencies.limiter || loginAttemptLimiter;
  const onRateLimited = dependencies.onRateLimited || logLoginThrottle;

  return async (req, res) => {
    let activeAttemptId = null;
    try {
      const { username, password } = req.body || {};

      // Validate input
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const decision = limiter.beginAttempt(readLoginClientAddress(req), username);
      if (!decision.allowed) {
        onRateLimited(decision.reason);
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      }
      activeAttemptId = decision.attemptId;

      // Get user from database
      const user = users.getUserByUsername(username);
      if (!user) {
        limiter.recordFailure(activeAttemptId);
        activeAttemptId = null;
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.password_hash);
      if (!isValidPassword) {
        limiter.recordFailure(activeAttemptId);
        activeAttemptId = null;
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      limiter.recordSuccess(activeAttemptId);
      activeAttemptId = null;

      // Generate token
      const token = createToken(user);

      // Update last login
      users.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username },
        token
      });

    } catch (error) {
      if (activeAttemptId !== null) {
        limiter.cancelAttempt(activeAttemptId);
      }
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export function createLogoutHandler(dependencies = {}) {
  const users = dependencies.users || userDb;
  const closeUserWebSockets = dependencies.closeUserWebSockets || closeWebSocketsForUser;

  return (req, res) => {
    try {
      const userId = req.user?.id;
      if (!Number.isSafeInteger(userId) || !users.revokeTokens(userId)) {
        return res.status(401).json({ error: 'Invalid or revoked token' });
      }
      // authenticateToken may have refreshed an old-but-current JWT before
      // this handler revoked it. Never send that now-stale token to the client.
      res.removeHeader('X-Refreshed-Token');
      const webSocketServer = req.app?.locals?.wss;
      let failedConnections = 0;
      if (webSocketServer) {
        failedConnections = closeUserWebSockets(webSocketServer, userId).failed;
      }
      return res.json({
        success: true,
        message: 'Logged out successfully',
        ...(failedConnections > 0 ? { connectionCleanupFailed: failedConnections } : {}),
      });
    } catch (error) {
      console.error('Logout error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// User login
router.post('/login', createLoginHandler());

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout revokes every JWT issued for this user by advancing token_version.
router.post('/logout', authenticateToken, createLogoutHandler());

export default router;
