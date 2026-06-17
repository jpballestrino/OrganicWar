import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Placeholder value stored in password_hash for OAuth-only users (no real password)
export const OAUTH_PLACEHOLDER = 'OAUTH_NO_PASSWORD';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET must be set via environment variable in production. Refusing to start.');
}

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[WARNING] JWT_SECRET not set — using a random secret. Sessions will be lost on restart.');
  return crypto.randomBytes(64).toString('hex');
})();

export function generateToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function comparePassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}
