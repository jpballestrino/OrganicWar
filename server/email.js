// Email utility for password reset (Server-Side)
import nodemailer from 'nodemailer';

let transporter = null;

/**
 * Lazily initialise the SMTP transporter.
 * Returns null when SMTP credentials are not configured so callers can
 * gracefully skip sending and log a warning instead of crashing.
 */
function getTransporter() {
  if (transporter) {return transporter;}

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[EMAIL] SMTP_USER / SMTP_PASS not set – email sending is disabled.');
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
                <p style="font-size: 12px; color: #888; text-align: center;">This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
                <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0;">
                <p style="font-size: 11px; color: #555; text-align: center;">OrganicWar.io — Blank Starter Template</p>
            </div>
        `,
  });
}
