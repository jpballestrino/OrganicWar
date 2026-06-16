import express from 'express';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { createUser, findUserByEmail, findUserByUsername, findUserById, updateLastLogin, findUserByOAuth, createOAuthUser, linkOAuthToUser, createPasswordResetToken, findValidResetToken, markResetTokenUsed, updateUserPassword, findGuildById } from '../database.js';
import { generateToken, verifyToken, hashPassword, comparePassword, OAUTH_PLACEHOLDER } from '../auth.js';
import { sendPasswordResetEmail } from '../email.js';

const authRouter = express.Router();
const googleOAuthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

authRouter.post('/register', (req, res) => {
  const { username, email, password, displayName } = req.body;
    
  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 15 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username. 3-15 chars, alphanumeric + underscores only.' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (displayName && (typeof displayName !== 'string' || displayName.length < 2 || displayName.length > 20 || /[<>]/.test(displayName))) {
    return res.status(400).json({ error: 'Display name must be 2-20 characters and cannot contain < or >.' });
  }

  if (findUserByUsername(username)) {
    return res.status(400).json({ error: 'Username already taken.' });
  }
  if (findUserByEmail(email)) {
    return res.status(400).json({ error: 'Email already registered.' });
  }

  try {
    const hashedPassword = hashPassword(password);
    const finalDisplayName = displayName || username;
    const user = createUser(username, email, hashedPassword, finalDisplayName);
    const token = generateToken(user);
        
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        eloRating: user.elo_rating,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body;
    
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const user = findUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  if (!comparePassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  updateLastLogin(user.id);
  const token = generateToken(user);
    
  let guildName = null;
  let guildTag = null;
  if (user.guild_id) {
    const guild = findGuildById(user.guild_id);
    if (guild) {
      guildName = guild.name;
      guildTag = guild.tag;
    }
  }
    
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      eloRating: user.elo_rating,
      guildId: user.guild_id,
      guildName,
      guildTag,
    },
  });
});

authRouter.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token.' });
  }
    
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
    
  if (!payload || !payload.userId) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  const user = findUserById(payload.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const safeUser = { ...user };
  delete safeUser.password_hash;
    
  if (safeUser.guild_id) {
    const guild = findGuildById(safeUser.guild_id);
    if (guild) {
      safeUser.guildName = guild.name;
      safeUser.guildTag = guild.tag;
    }
  }
    
  res.json({ user: safeUser });
});

// ---------- OAUTH HELPERS ----------
function generateOAuthUsername(rawName) {
  let base = (rawName || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 12);
  if (base.length < 3) {base = base + '_' + 'usr';}
  let candidate = base;
  while (findUserByUsername(candidate)) {
    const suffix = String(Math.floor(Math.random() * 900) + 100);
    candidate = base.substring(0, 12) + suffix;
  }
  return candidate;
}

function handleOAuthUser(res, provider, providerId, email, displayName) {
  try {
    let user = findUserByOAuth(provider, providerId);
    if (user) {
      updateLastLogin(user.id);
      const token = generateToken(user);
      const userPayload = encodeURIComponent(JSON.stringify({
        id: user.id, username: user.username,
        displayName: user.display_name, eloRating: user.elo_rating, guildId: user.guild_id,
      }));
      return res.redirect(`/?token=${token}&user=${userPayload}`);
    }

    if (email) {
      const existingByEmail = findUserByEmail(email);
      if (existingByEmail) {
        linkOAuthToUser(existingByEmail.id, provider, providerId);
        updateLastLogin(existingByEmail.id);
        const token = generateToken(existingByEmail);
        const userPayload = encodeURIComponent(JSON.stringify({
          id: existingByEmail.id, username: existingByEmail.username,
          displayName: existingByEmail.display_name, eloRating: existingByEmail.elo_rating,
          guildId: existingByEmail.guild_id,
        }));
        return res.redirect(`/?token=${token}&user=${userPayload}`);
      }
    }

    const username = generateOAuthUsername(displayName || (email ? email.split('@')[0] : 'player'));
    const safeName = (displayName || username).substring(0, 20);
    const safeEmail = email || `${provider}_${providerId}@oauth.local`;

    user = createOAuthUser(username, safeEmail, safeName, provider, providerId);
    updateLastLogin(user.id);
    const token = generateToken(user);
    const userPayload = encodeURIComponent(JSON.stringify({
      id: user.id, username: user.username,
      displayName: user.display_name, eloRating: user.elo_rating, guildId: user.guild_id,
    }));
    return res.redirect(`/?token=${token}&user=${userPayload}`);
  } catch (err) {
    console.error(`[OAUTH] ${provider} callback error:`, err);
    return res.redirect('/?oauth_error=' + encodeURIComponent('Authentication failed. Please try again.'));
  }
}

// ---------- GOOGLE OAUTH ----------
authRouter.get('/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {return res.status(500).json({ error: 'Google OAuth not configured on this server.' });}

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies?.oauth_state;

  if (!code || !state || state !== savedState) {
    return res.redirect('/?oauth_error=' + encodeURIComponent('Invalid OAuth state. Please try again.'));
  }
  res.clearCookie('oauth_state');

  try {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) {
      console.error('[GOOGLE] Token exchange failed:', tokenData);
      return res.redirect('/?oauth_error=' + encodeURIComponent('Google authentication failed.'));
    }

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: tokenData.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      console.error('[GOOGLE] id_token verification returned no payload');
      return res.redirect('/?oauth_error=' + encodeURIComponent('Google authentication failed.'));
    }
    const googleId = payload.sub;
    const email = payload.email_verified ? payload.email : null;
    const name = payload.name || payload.email?.split('@')[0] || 'Player';

    handleOAuthUser(res, 'google', googleId, email, name);
  } catch (err) {
    console.error('[GOOGLE] Callback error:', err);
    res.redirect('/?oauth_error=' + encodeURIComponent('Google authentication failed.'));
  }
});

// ---------- DISCORD OAUTH ----------
authRouter.get('/discord', (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {return res.status(500).json({ error: 'Discord OAuth not configured on this server.' });}

  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 300000, sameSite: 'lax' });

  const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify email',
    state,
    prompt: 'consent',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

authRouter.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies?.oauth_state;

  if (!code || !state || state !== savedState) {
    return res.redirect('/?oauth_error=' + encodeURIComponent('Invalid OAuth state. Please try again.'));
  }
  res.clearCookie('oauth_state');

  try {
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/discord/callback`;

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[DISCORD] Token exchange failed:', tokenData);
      return res.redirect('/?oauth_error=' + encodeURIComponent('Discord authentication failed.'));
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();
    const discordId = discordUser.id;
    const email = discordUser.email || null;
    const name = discordUser.global_name || discordUser.username || 'Player';

    handleOAuthUser(res, 'discord', discordId, email, name);
  } catch (err) {
    console.error('[DISCORD] Callback error:', err);
    res.redirect('/?oauth_error=' + encodeURIComponent('Discord authentication failed.'));
  }
});

// ---------- FORGOT / RESET PASSWORD ----------
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const genericMsg = 'If an account with that email exists, a reset link has been sent.';

  if (!email || typeof email !== 'string') {
    return res.json({ message: genericMsg });
  }

  try {
    const user = findUserByEmail(email);
    if (!user) {return res.json({ message: genericMsg });}

    if (user.password_hash === OAUTH_PLACEHOLDER) {
      return res.json({ message: genericMsg });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').replace('Z', '');
    createPasswordResetToken(user.id, token, expiresAt);

    await sendPasswordResetEmail(email, token);
    res.json({ message: genericMsg });
  } catch (err) {
    console.error('[AUTH] forgot-password error:', err);
    res.json({ message: genericMsg });
  }
});

authRouter.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const resetRow = findValidResetToken(token);
  if (!resetRow) {
    return res.status(400).json({ error: 'Invalid or expired reset link.' });
  }

  const hashedPassword = hashPassword(newPassword);
  updateUserPassword(resetRow.user_id, hashedPassword);
  markResetTokenUsed(resetRow.id);

  res.json({ message: 'Password updated successfully. You can now log in.' });
});

export default authRouter;
