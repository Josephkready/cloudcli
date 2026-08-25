import { createHash, timingSafeEqual } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../modules/database/index.js';
import { IS_PLATFORM, AUTH_DISABLED } from '../constants/config.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

export function apiKeysMatch(providedKey, expectedKey) {
  const provided = typeof providedKey === 'string' ? providedKey : '';
  const expected = typeof expectedKey === 'string' ? expectedKey : '';
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  const digestMatches = timingSafeEqual(providedDigest, expectedDigest);
  return typeof providedKey === 'string'
    && typeof expectedKey === 'string'
    && expectedKey.length > 0
    && digestMatches;
}

export function readRequestBearerToken(req) {
  const authHeader = req?.headers?.authorization;
  return typeof authHeader === 'string' ? authHeader.split(' ')[1] || null : null;
}

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (!apiKeysMatch(apiKey, process.env.API_KEY)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

export function tokenVersionMatches(decoded, user) {
  return Number.isSafeInteger(decoded?.tokenVersion)
    && Number.isSafeInteger(user?.token_version)
    && decoded.tokenVersion === user.token_version;
}

// Generate JWT token. A persisted per-user version makes every issued token
// revocable without rotating the installation-wide signing secret.
const generateToken = (user) => {
  if (!Number.isSafeInteger(user?.token_version)) {
    throw new TypeError('Cannot issue a token without a valid token version');
  }
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tokenVersion: user.token_version,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// JWT authentication middleware
export function createAuthenticateToken(dependencies = {}) {
  const users = dependencies.users || userDb;
  const bypassAuth = dependencies.bypassAuth ?? (IS_PLATFORM || AUTH_DISABLED);
  const verifyToken = dependencies.verifyToken || ((token) => jwt.verify(token, JWT_SECRET));
  const createToken = dependencies.createToken || generateToken;
  const clock = dependencies.clock || Date.now;
  const onError = dependencies.onError || ((error) => console.error('Token verification error:', error));

  return async (req, res, next) => {
    // Platform mode or auth-disabled: use the single default database user
    if (bypassAuth) {
      try {
        const user = users.getFirstUser();
        if (!user) {
          return res.status(500).json({ error: 'No user found in database' });
        }
        req.user = user;
        return next();
      } catch (error) {
        console.error('Auth bypass error:', error);
        return res.status(500).json({ error: 'Failed to fetch user' });
      }
    }

    const token = readRequestBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    try {
      const decoded = verifyToken(token);
      const user = users.getUserById(decoded?.userId);

      // Missing tokenVersion means the JWT predates server-side revocation.
      // Reject it rather than silently grandfathering a leaked session in.
      if (!user || !tokenVersionMatches(decoded, user)) {
        return res.status(401).json({ error: 'Invalid or revoked token' });
      }

      // Auto-refresh only a token whose persisted version is still current.
      if (decoded.exp && decoded.iat) {
        const now = Math.floor(clock() / 1000);
        const halfLife = (decoded.exp - decoded.iat) / 2;
        if (now > decoded.iat + halfLife) {
          res.setHeader('X-Refreshed-Token', createToken(user));
        }
      }

      req.user = user;
      next();
    } catch (error) {
      onError(error);
      return res.status(403).json({ error: 'Invalid token' });
    }
  };
}

const authenticateToken = createAuthenticateToken();

// WebSocket authentication function
export function createAuthenticateWebSocket(dependencies = {}) {
  const users = dependencies.users || userDb;
  const bypassAuth = dependencies.bypassAuth ?? (IS_PLATFORM || AUTH_DISABLED);
  const verifyToken = dependencies.verifyToken || ((token) => jwt.verify(token, JWT_SECRET));
  const onError = dependencies.onError
    || ((error) => console.error('WebSocket token verification error:', error));

  return (token) => {
    // Platform mode or auth-disabled: bypass token validation, return first user
    if (bypassAuth) {
      try {
        const user = users.getFirstUser();
        if (user) {
          return { id: user.id, userId: user.id, username: user.username };
        }
        return null;
      } catch (error) {
        console.error('Auth bypass WebSocket error:', error);
        return null;
      }
    }

    if (!token) {
      return null;
    }

    try {
      const decoded = verifyToken(token);
      const user = users.getUserById(decoded?.userId);
      if (!user || !tokenVersionMatches(decoded, user)) {
        return null;
      }
      return { userId: user.id, username: user.username };
    } catch (error) {
      onError(error);
      return null;
    }
  };
}

const authenticateWebSocket = createAuthenticateWebSocket();

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
