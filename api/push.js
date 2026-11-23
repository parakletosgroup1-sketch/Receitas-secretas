// api/push.js — inscreve o celular/computador para receber notificação de venda aprovada.
//   GET               -> { key } chave pública para o navegador se inscrever
//   POST {sub,device} -> guarda a inscrição
//   POST {sub,test:1} -> manda uma notificação de teste só para esse aparelho
//   POST {sub,off:1}  -> remove a inscrição
const admin = require('firebase-admin');
if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const { keys, subId, sendTo } = require('./_push');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') return res.json({ key: (await keys(db)).publicKey });
    if (req.method !== 'POST') return res.status(405).json({ erro: 'método' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const sub = b.sub || {};
    const ok = typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
      sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
    if (!ok) return res.status(400).json({ erro: 'inscrição inválida' });
    const ref = db.collection('push_subs').doc(subId(sub.endpoint));

    if (b.off) { await ref.delete(); return res.json({ ok: true, removido: true }); }
    await ref.set({ sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      device: String(b.device || '').slice(0, 120), updatedAt: Date.now() }, { merge: true });
    if (b.test) {
      const r = await sendTo(db, [await ref.get()], { title: '🔔 Notificações ligadas', body: 'Você vai receber um aviso a cada venda aprovada, com o produto e o valor.', tag: 'teste', url: '/' });
      return res.json({ ok: true, ...r });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e); return res.status(500).json({ erro: String(e.message || e) });
  }
};
