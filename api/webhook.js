// Webhook da Wiapy -> Firestore (projeto lp-receitas), coleção "sales"
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => (a == null ? undefined : a[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (process.env.WEBHOOK_KEY && req.query.key !== process.env.WEBHOOK_KEY) {
    return res.status(401).send('unauthorized');
  }
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const status = String(pick(b, ['status', 'data.status', 'payment.status', 'transaction.status']) || '').toLowerCase();
    const isPaid = ['paid', 'pago', 'approved', 'aprovado', 'completed', 'confirmed', 'confirmado'].includes(status);
    let amount = Number(pick(b, ['amount', 'value', 'total', 'price', 'data.amount', 'payment.amount', 'transaction.amount']) || 0);
    if (Number.isInteger(amount) && amount >= 500) amount = amount / 100; // veio em centavos

    const id = String(pick(b, ['id', 'transaction_id', 'transactionId', 'order_id', 'data.id', 'transaction.id']) || Date.now());
    await db.collection('sales').doc(id).set({
      product: 'lp-receitas',
      status,
      isPaid,
      amount,
      paymentMethod: String(pick(b, ['paymentMethod', 'payment_method', 'method', 'payment.method']) || 'pix').toLowerCase(),
      customerName: pick(b, ['customerName', 'customer.name', 'client.name', 'buyer.name', 'name', 'data.customer.name']) || 'Cliente',
      productName: pick(b, ['product.name', 'productName', 'product_name', 'offer.name']) || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      raw: JSON.stringify(b).slice(0, 8000),
    }, { merge: true });
    return res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    return res.status(200).send('erro registrado');
  }
};
