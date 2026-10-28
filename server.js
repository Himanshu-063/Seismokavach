require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const SMS_FROM = process.env.TWILIO_SMS_FROM;                 // e.g. +1415XXXXXXX
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;             // e.g. whatsapp:+14155238886 (sandbox)
const COOLDOWN_MS = (Number(process.env.ALERT_COOLDOWN_MIN) || 10) * 60 * 1000;

// Only numbers listed here can ever receive alerts (prevents abuse of the endpoint)
const ALLOWED = (process.env.ALLOWED_RECIPIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const lastSent = new Map(); // key -> timestamp (anti-spam cooldown)

function buildMessage(defects, health) {
  const top = defects[0];
  const lines = defects.map((d, i) =>
    `${i + 1}. ${d.title} (${d.sensorId}) - Stress ${d.metrics.stress}, SF ${d.metrics.safetyFactor}`);
  return (
    `SEISMOKAVACH ALERT - KIT BOYS HOSTEL\n` +
    `Building Health: ${health}\n` +
    `Critical anomalies: ${defects.length}\n\n` +
    lines.join('\n') +
    `\n\nRecommended action: ${top.action}`
  );
}

app.post('/api/alerts', async (req, res) => {
  const { recipients = [], defects = [], health = '84%', force = false } = req.body || {};

  if (!defects.length) return res.status(400).json({ error: 'No defects supplied' });

  const body = buildMessage(defects, health);
  const defectKey = defects.map(d => d.id).sort().join(',');
  const results = [];

  for (const r of recipients) {
    const phone = String(r.phone || '').replace(/[^\d+]/g, '');
    if (!ALLOWED.includes(phone)) {
      results.push({ name: r.name, phone, skipped: 'not in allowlist' });
      continue;
    }

    const key = `${phone}:${defectKey}`;
    if (!force && Date.now() - (lastSent.get(key) || 0) < COOLDOWN_MS) {
      results.push({ name: r.name, phone, skipped: 'cooldown active' });
      continue;
    }

    const entry = { name: r.name, phone };
    try {
      const sms = await client.messages.create({ from: SMS_FROM, to: phone, body });
      entry.sms = { ok: true, sid: sms.sid };
    } catch (e) {
      entry.sms = { ok: false, error: e.message };
    }
    try {
      const wa = await client.messages.create({ from: WA_FROM, to: `whatsapp:${phone}`, body });
      entry.whatsapp = { ok: true, sid: wa.sid };
    } catch (e) {
      entry.whatsapp = { ok: false, error: e.message };
    }

    if (entry.sms.ok || entry.whatsapp.ok) lastSent.set(key, Date.now());
    results.push(entry);
  }

  res.json({ results });
});

app.get('/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Seismokavach alert server on :${PORT}`));