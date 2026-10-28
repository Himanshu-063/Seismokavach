require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

// TEST MODE: if Twilio keys are missing, nothing is really sent.
// The message is only printed in this terminal. The server never crashes.
const DRY_RUN = !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN;
let client = null;
if (!DRY_RUN) {
  client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

const SMS_FROM = process.env.TWILIO_SMS_FROM;
const WA_FROM = process.env.TWILIO_WHATSAPP_FROM;
const COOLDOWN_MS = (Number(process.env.ALERT_COOLDOWN_MIN) || 10) * 60 * 1000;

// Optional allowlist. If empty, any number sent from the page is accepted.
const ALLOWED = (process.env.ALLOWED_RECIPIENTS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const lastSent = new Map();

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

    if (ALLOWED.length && !ALLOWED.includes(phone)) {
      results.push({ name: r.name, phone, skipped: 'number not in allowlist' });
      continue;
    }

    const key = `${phone}:${defectKey}`;
    if (!force && Date.now() - (lastSent.get(key) || 0) < COOLDOWN_MS) {
      results.push({ name: r.name, phone, skipped: 'already alerted recently' });
      continue;
    }

    const entry = { name: r.name, phone };

    if (DRY_RUN) {
      console.log('\n================ TEST MODE (nothing really sent) ================');
      console.log(`To: ${r.name} (${phone})  via SMS + WhatsApp`);
      console.log(body);
      console.log('=================================================================\n');
      entry.sms = { ok: true };
      entry.whatsapp = { ok: true };
      entry.dry = true;
      lastSent.set(key, Date.now());
      results.push(entry);
      continue;
    }

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

app.get('/health', (_, res) => res.json({ ok: true, testMode: DRY_RUN }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Seismokavach alert server running on http://localhost:${PORT}`);
  console.log(DRY_RUN
    ? 'MODE: TEST (no Twilio keys found - messages are only printed here)'
    : 'MODE: LIVE (sending real SMS + WhatsApp via Twilio)');
});