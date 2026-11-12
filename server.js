const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SECRET = process.env.SECRET || 'dev-secret-change-me';
const LIMIT = 100; // Nachrichten pro Nutzer und Tag
const DB = path.join(__dirname, 'data.json');
const SYSTEM = 'Du bist Dona, eine KI, die Webseiten erstellt (HTML, CSS, JavaScript). ' +
  'Antworte in der Sprache des Nutzers. Liefere vollstaendigen Code in einem Codeblock. ' +
  'Verwende nur eigene oder frei lizenzierte Inhalte (Unsplash, Pexels, Lucide, Google Fonts), ' +
  'niemals fremde Logos, Marken oder urheberrechtlich geschuetzte Texte.';

let db = { usage: {} };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const today = () => new Date().toISOString().slice(0, 10);
const save = () => {
  for (const k of Object.keys(db.usage)) if (!k.endsWith(today())) delete db.usage[k];
  fs.writeFile(DB, JSON.stringify(db), () => {});
};
const usageKey = e => e + '|' + today();

const codes = new Map(); // email -> { code, exp, tries, sent }
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const makeToken = email => {
  const p = email + '|' + (Date.now() + 30 * 864e5);
  return Buffer.from(p).toString('base64url') + '.' + sign(p);
};

function auth(req, res, next) {
  try {
    const [b, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
    const p = Buffer.from(b, 'base64url').toString();
    const [email, exp] = p.split('|');
    const ok = sig && sig.length === 64 &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(p)));
    if (ok && Date.now() < Number(exp)) { req.email = email; return next(); }
  } catch {}
  res.status(401).json({ error: 'auth' });
}

async function sendMail(to, code) {
  if (!process.env.RESEND_API_KEY) { console.log(`[DEV] Code fuer ${to}: ${code}`); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Dona <onboarding@resend.dev>',
      to, subject: 'Dona: ' + code,
      html: `<p>Dein Code: <b style="font-size:22px">${code}</b></p><p>Gueltig 10 Minuten.</p>`
    })
  });
  if (!r.ok) throw new Error('mail failed');
}

app.post('/api/request-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'email' });
  const old = codes.get(email);
  if (old && Date.now() - old.sent < 60000) return res.status(429).json({ error: 'wait' });
  const code = String(crypto.randomInt(100000, 1000000));
  codes.set(email, { code, exp: Date.now() + 600000, tries: 0, sent: Date.now() });
  try { await sendMail(email, code); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'mail' }); }
});

app.post('/api/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const c = codes.get(email);
  if (!c || Date.now() > c.exp || c.tries >= 5) return res.status(400).json({ error: 'code' });
  c.tries++;
  if (String(req.body.code).trim() !== c.code) return res.status(400).json({ error: 'code' });
  codes.delete(email);
  res.json({ token: makeToken(email), email });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ email: req.email, used: db.usage[usageKey(req.email)] || 0, limit: LIMIT });
});

app.post('/api/chat', auth, async (req, res) => {
  const k = usageKey(req.email);
  if ((db.usage[k] || 0) >= LIMIT) return res.status(429).json({ error: 'limit', limit: LIMIT });
  const messages = (req.body.messages || []).slice(-20)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 8000) }));
  let reply;
  try {
    if (process.env.LLM_URL) {
      const r = await fetch(process.env.LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.LLM_KEY },
        body: JSON.stringify({ model: process.env.LLM_MODEL, messages: [{ role: 'system', content: SYSTEM }, ...messages] })
      });
      const j = await r.json();
      reply = j.choices[0].message.content;
    } else {
      reply = 'Dona laeuft. Das Sprachmodell ist noch nicht verbunden (LLM_URL, LLM_KEY, LLM_MODEL in Render eintragen).';
    }
  } catch { return res.status(502).json({ error: 'model' }); }
  db.usage[k] = (db.usage[k] || 0) + 1;
  save();
  res.json({ reply, used: db.usage[k], limit: LIMIT });
});

app.listen(process.env.PORT || 3000, () => console.log('Dona laeuft'));
