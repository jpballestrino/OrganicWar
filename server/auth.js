import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Placeholder value stored in password_hash for OAuth-only users (no real password)
export const OAUTH_PLACEHOLDER = 'OAUTH_NO_PASSWORD';

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('[WARNING] JWT_SECRET is not set in environment variables. Using a temporary random secret. Sessions will be invalidated on server restart.');
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
