// Email utility for auth emails and user feedback (Server-Side)
import nodemailer from 'nodemailer';

let transporter = null;

/**
 * Lazily initialise the SMTP transporter.
 * Returns null when SMTP credentials are not configured so callers can
 * gracefully skip sending and log a warning instead of crashing.
 */
function getTransporter() {
  if (transporter) {return transporter;}

  // Accept both naming conventions (SMTP_USER/SMTP_PASS and EMAIL_USER/EMAIL_PASS).
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn('[EMAIL] SMTP credentials not set (SMTP_USER/SMTP_PASS or EMAIL_USER/EMAIL_PASS) – email sending is disabled.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // STARTTLS
    auth: { user, pass },
  });

  return transporter;
}

/**
 * Send an email-verification link.
 * Returns true if the mail was dispatched, false if SMTP is not configured.
 * @param {string} toEmail – recipient address
 * @param {string} verifyToken – the one-time token embedded in the link
 */
export async function sendVerificationEmail(toEmail, verifyToken) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[EMAIL] Would send verification email to ${toEmail} – but SMTP is not configured.`);
    return false;
  }

  const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/verify-email?token=${verifyToken}`;

  await t.sendMail({
    from: process.env.SMTP_FROM || '"OrganicWar.io" <noreply@organicwar.io>',
    to: toEmail,
    subject: '✅ OrganicWar.io — Verify Your Email',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 30px; border-radius: 10px; border: 1px solid rgba(255,193,7,0.3);">
        <h1 style="color: #ffc107; text-align: center; font-family: 'Segoe UI', sans-serif; letter-spacing: 2px;">ORGANICWAR<span style="color:#fff;">.io</span></h1>
        <p style="text-align:center; color:#ccc;">Thanks for registering! Click below to verify your email address and activate your account.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyUrl}" style="background: #ffc107; color: #000; padding: 14px 36px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">Verify Email</a>
        </div>
        <p style="font-size: 12px; color: #888; text-align: center;">This link expires in <strong>24 hours</strong>. If you didn't register, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0;">
        <p style="font-size: 11px; color: #555; text-align: center;">OrganicWar.io</p>
      </div>
    `,
  });
  return true;
}

/**
 * Send a player feedback / bug-report email to the developer.
 * Returns true if dispatched, false if SMTP is not configured.
 */
export async function sendFeedbackEmail({ type, subject, description, userEmail, username }) {
  const t = getTransporter();
  if (!t) {
    console.warn('[EMAIL] Would send feedback email – SMTP not configured.');
    return false;
  }

  const typeLabel = { bug: '🐛 Bug Report', suggestion: '💡 Suggestion', other: '💬 Other' }[type] || type;
  const fromLine = [username, userEmail].filter(Boolean).join(' · ');
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  await t.sendMail({
    from: process.env.SMTP_FROM || '"OrganicWar.io" <noreply@organicwar.io>',
    to: process.env.FEEDBACK_EMAIL || 'juanpballestrino@gmail.com',
    replyTo: userEmail || undefined,
    subject: `[OrganicWar.io ${typeLabel}] ${subject}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#1a1a2e;color:#fff;padding:30px;border-radius:10px;border:1px solid rgba(255,193,7,0.3);">
        <h1 style="color:#ffc107;text-align:center;font-family:'Segoe UI',sans-serif;letter-spacing:2px;margin-top:0;">ORGANICWAR<span style="color:#fff;">.io</span></h1>
        <div style="background:rgba(255,193,7,0.08);border:1px solid rgba(255,193,7,0.2);border-radius:8px;padding:14px 18px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:16px;font-weight:bold;color:#ffc107;">${typeLabel}</span>
          <span style="font-size:12px;color:#888;">From: ${esc(fromLine)}</span>
        </div>
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Subject</div>
          <div style="font-size:15px;color:#fff;background:rgba(255,255,255,0.05);padding:10px 14px;border-radius:6px;">${esc(subject)}</div>
        </div>
        <div style="margin-bottom:20px;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Description</div>
          <div style="font-size:14px;color:#ccc;background:rgba(255,255,255,0.05);padding:12px 14px;border-radius:6px;white-space:pre-wrap;line-height:1.6;">${esc(description)}</div>
        </div>
        <hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:20px 0;">
        <p style="font-size:11px;color:#555;text-align:center;margin:0;">OrganicWar.io Feedback System</p>
      </div>
    `,
  });
  return true;
}

/**
 * Send a password-reset email with a branded HTML template.
 * @param {string} toEmail – recipient address
 * @param {string} resetToken – the one-time token embedded in the link
 */
export async function sendPasswordResetEmail(toEmail, resetToken) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[EMAIL] Would send reset email to ${toEmail} – but SMTP is not configured.`);
    return;
  }

  const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

  await t.sendMail({
    from: process.env.SMTP_FROM || '"OrganicWar.io" <noreply@organicwar.io>',
    to: toEmail,
    subject: '🔑 OrganicWar.io — Password Reset Request',
    html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1a2e; color: #fff; padding: 30px; border-radius: 10px; border: 1px solid rgba(255,193,7,0.3);">
                <h1 style="color: #ffc107; text-align: center; font-family: 'Segoe UI', sans-serif; letter-spacing: 2px;">ORGANICWAR<span style="color:#fff;">.io</span></h1>
                <p style="text-align:center; color:#ccc;">You requested a password reset for your account.</p>
                <div style="text-align: center; margin: 30px 0;">
                     <a href="${resetUrl}" style="background: #ffc107; color: #000; padding: 14px 36px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 16px;">Reset Password</a>
                </div>
                <p style="font-size: 12px; color: #888; text-align: center;">This link expires in <strong>30 minutes</strong>. If you didn't request this, you can safely ignore this email.</p>
                <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0;">
                <p style="font-size: 11px; color: #555; text-align: center;">OrganicWar.io</p>
            </div>
        `,
  });
}
