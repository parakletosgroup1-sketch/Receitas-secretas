// api/_push.js — notificações no celular (Web Push). Arquivo com "_" não vira rota na Vercel.
// As chaves VAPID são criadas sozinhas na primeira vez e ficam guardadas no Firestore (push_config/vapid),
// que só o servidor lê. Os celulares inscritos ficam em push_subs.
const webpush = require('web-push');
const crypto = require('crypto');

const SUBJECT = 'https://dashboard-receitas-three.vercel.app';
const brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

async function keys(db) {
  const ref = db.doc('push_config/vapid');
  let s = await ref.get();
  if (!s.exists) {
    const k = webpush.generateVAPIDKeys();
    await ref.create({ ...k, createdAt: Date.now() }).catch(() => {}); // se duas chamadas criarem juntas, vale a primeira
    s = await ref.get();
  }
  const k = s.data();
  webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey);
  return k;
}

const subId = endpoint => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 40);

async function sendTo(db, docs, payload) {
  await keys(db);
  const body = JSON.stringify(payload);
  const out = await Promise.allSettled(docs.map(d =>
    webpush.sendNotification(d.get('sub'), body, { TTL: 6 * 3600, urgency: 'high' })
      .catch(async e => { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete(); throw e; })));
  return { enviados: out.filter(x => x.status === 'fulfilled').length, falhas: out.filter(x => x.status === 'rejected').length };
}

async function sendAll(db, payload) {
  const snap = await db.collection('push_subs').get();
  if (snap.empty) return { enviados: 0, falhas: 0 };
  return sendTo(db, snap.docs, payload);
}

// texto da notificação de venda aprovada
function saleMessage(d) {
  const top = (Number(d.amount) || 0) > 40;
  const net = d.fee != null ? (Number(d.amount) || 0) - Number(d.fee) : null;
  const name = d.offerName || d.productName || 'Venda';
  const extra = [];
  if (d.orderBumps && d.orderBumps.length) extra.push('+ ' + d.orderBumps.length + (d.orderBumps.length > 1 ? ' bumps' : ' bump'));
  if (d.isUpsell) extra.push('upsell');
  extra.push(d.paymentMethod === 'card' ? 'Cartão' : 'Pix');
  if (net != null) extra.push('líquido ' + brl(net));
  return {
    title: (top ? '🏆 Venda TOP aprovada · ' : '💰 Venda aprovada · ') + brl(d.amount),
    body: name + '\n' + extra.join(' · '),
    tag: 'venda-' + Date.now(),
    url: '/',
  };
}

module.exports = { keys, subId, sendTo, sendAll, saleMessage };
