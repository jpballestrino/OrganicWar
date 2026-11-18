// Local SMTP server that catches the game's emails, for the account tests
// (scripts/e2e-accounts.mjs, scripts/smoke-accounts.mjs). Not a project
// dependency — install its two packages without saving them:
//
//   npm i --no-save smtp-server@3 mailparser@3
//   node scripts/mail-catcher.mjs          # SMTP on :2525, mails as JSON on :2526
//   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USER=test SMTP_PASS=test npm start
//
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import http from 'http';

const mails = [];
const smtp = new SMTPServer({
  disabledCommands: ['STARTTLS'],
  authOptional: true,
  allowInsecureAuth: true,
  onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
  onData(stream, session, cb) {
    simpleParser(stream).then((m) => {
      mails.push({ to: m.to?.text, subject: m.subject, html: m.html || '', from: m.from?.text, at: Date.now() });
      cb();
    }).catch(cb);
  },
});
smtp.listen(2525, '127.0.0.1');
http.createServer((req, res) => {
  if (req.method === 'DELETE') mails.length = 0;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(mails));
}).listen(2526, '127.0.0.1');
console.log('mail catcher on :2525 (smtp) / :2526 (http)');
