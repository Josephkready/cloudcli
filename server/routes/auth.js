import express from 'express';
import bcrypt from 'bcrypt';

import { userDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

import { LoginAttemptLimiter } from './login-attempt-limiter.js';

const router = express.Router();
const db = getConnection();
const loginAttemptLimiter = new LoginAttemptLimiter();

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

  return async (req, res) => {
    let activeUsername = null;
    try {
      const { username, password } = req.body || {};

      // Validate input
      if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const decision = limiter.beginAttempt(readLoginClientAddress(req), username);
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      }
      activeUsername = username;

      // Get user from database
      const user = users.getUserByUsername(username);
      if (!user) {
        limiter.recordFailure(username);
        activeUsername = null;
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.password_hash);
      if (!isValidPassword) {
        limiter.recordFailure(username);
        activeUsername = null;
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      limiter.recordSuccess(username);
      activeUsername = null;

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
      if (activeUsername !== null) {
        limiter.cancelAttempt(activeUsername);
      }
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
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

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
