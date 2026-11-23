// Webhook da Wiapy -> Firestore (projeto lp-receitas), coleção "sales"
// v2: lê o formato real da Wiapy (payment / customer / checkout / products / tracking)
// e grava os campos que a dashboard v4 e a análise das 23h usam.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const push = require('./_push'); // notificação de venda aprovada no celular

// ---- Identificação do produto (LP) ----
// 1) ?lp=slug na URL do webhook tem prioridade;
// 2) senão, pelo id do checkout (preencha conforme for criando checkouts);
// 3) senão, pelo nome do checkout/produto;
// 4) se nada bater, cai na LP original.
const PRODUCTS = ['lp-receitas', 'receitinhas-nanna', 'gostosuras-nanna'];
const CHECKOUTS = {
  '6ae18a5c00e69ea828e7eb71': 'receitinhas-nanna', // +365 Receitinhas da Nanna — Premium com Cardápio (R$ 18)
  '6ae189ec00e69ea828e7e3c1': 'receitinhas-nanna', // Receitinhas da Nanna — +365 Receitas para Bebês (R$ 10)
  '6ada6db6d032443944e97f29': 'lp-receitas',       // 365 Receitas Secretas da Chef Nanna Azuos (R$ 10)
  '6ada6e941ecf58111b4bc012': 'lp-receitas',       // 500 Receitas Secretas da Chef Nanna Azuos — Edição Premium (R$ 18)
  '6b0241bff6f34fd109a8f00e': 'gostosuras-nanna',  // Gostosuras da Chef Nanna — Completo (R$ 18)
  '6b02426d89843186c063b7c7': 'gostosuras-nanna',  // Gostosuras da Chef Nanna — Essencial (R$ 10)
};
// Atenção: os dois produtos têm "Nanna" no nome, então o nome só serve de reserva e usa palavras exclusivas.
const BY_NAME = [
  [/receitinhas/i, 'receitinhas-nanna'],
  [/receitas secretas/i, 'lp-receitas'],
];
// Checkouts de upsell/downsell (id do checkout da Wiapy). Também detecta "upsell"/"downsell" no nome.
const UPSELL_CHECKOUTS = [];

const cents = v => (v == null || v === '' || isNaN(v) ? null : Math.round(Number(v)) / 100); // Wiapy manda tudo em centavos
const low = v => String(v || '').toLowerCase();

function detectProduct(req, b) {
  const q = String(req.query.lp || '').trim();
  if (PRODUCTS.includes(q)) return q;
  const c = b.checkout || {};
  if (c.id && CHECKOUTS[c.id]) return CHECKOUTS[c.id];
  const names = [c.title, ...(b.products || []).map(p => p && p.title)].filter(Boolean).join(' | ');
  for (const [re, slug] of BY_NAME) if (re.test(names)) return slug;
  return 'lp-receitas';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (process.env.WEBHOOK_KEY && req.query.key !== process.env.WEBHOOK_KEY) {
    return res.status(401).send('unauthorized');
  }
  try {
    let b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (b.data && (b.data.payment !== undefined || b.data.checkout)) b = b.data; // por segurança, se vier embrulhado

    const p = b.payment || null, c = b.checkout || {}, t = b.tracking || {}, cu = b.customer || {};
    const product = detectProduct(req, b);
    const now = FV.serverTimestamp();
    const utm = {
      utm_source: t.utm_source || '', utm_medium: t.utm_medium || '', utm_campaign: t.utm_campaign || '',
      utm_content: t.utm_content || '', utm_term: t.utm_term || '',
    };

    // ---- Carrinho abandonado: Wiapy manda payment = null ----
    if (!p) {
      const id = 'ab_' + (c.id || 'x') + '_' + (cu.id || cu.email || Date.now());
      await db.collection('sales').doc(id).set({
        product, status: 'abandoned', isPaid: false,
        amount: cents(c.amount) || 0, offerName: c.title || '', checkoutId: c.id || '',
        customerName: cu.name || 'Cliente', ...utm,
        createdAt: now, abandonedAt: now,
      }, { merge: true });
      return res.status(200).send('ok');
    }

    const status = low(p.status);                       // paid | unpaid | credit_card_declined | refunded | chargedback
    const isPaid = status === 'paid';
    const ref = db.collection('sales').doc(String(p.id));
    const prev = await ref.get();
    const bumps = Array.isArray(c.orderbump) ? c.orderbump.map(x => ({ name: x.title || 'Order bump', amount: cents(x.amount) || 0 })) : [];
    const isUpsell = UPSELL_CHECKOUTS.includes(c.id) || /upsell|downsell|one.?click/i.test(c.title || '');

    const doc = {
      product, status, isPaid,
      amount: cents(p.amount) || 0,                    // valor total pago (já com bump)
      fee: cents(p.fee),                               // taxa real da Wiapy
      paymentMethod: low(p.payment_method) === 'credit_card' ? 'card' : low(p.payment_method || 'pix'),
      customerName: cu.name || 'Cliente',
      offerName: c.title || '', checkoutId: c.id || '', checkoutAmount: cents(c.amount),
      orderBumps: bumps, isUpsell,
      productName: (b.products || []).map(x => x && x.title).filter(Boolean).join(' + '),
      coupon: p.coupon || null,
      ...utm,
      createdAt: now,                                  // hora do último status (a venda paga fica com a hora do pagamento)
      updatedAt: now,
    };
    // guarda quando o PIX/boleto foi gerado: venda paga muito depois disso = recuperada
    if (status === 'unpaid' && !(prev.exists && prev.get('pendingAt'))) doc.pendingAt = now;
    if (isPaid) doc.paidAt = now;
    if (status === 'refunded' || status === 'chargedback') { doc.refundedAt = now; delete doc.createdAt; }
    // não deixa um "unpaid" atrasado desfazer uma venda já paga
    if (prev.exists && prev.get('isPaid') === true && !isPaid && !doc.refundedAt) return res.status(200).send('ok');

    await ref.set(doc, { merge: true });
    // venda acabou de ser aprovada (não avisa de novo se a Wiapy repetir o evento)
    if (isPaid && !(prev.exists && prev.get('isPaid') === true)) {
      await push.sendAll(db, push.saleMessage(doc)).catch(e => console.error('push', e));
    }
    return res.status(200).send('ok');
  } catch (e) {
    console.error(e);
    return res.status(200).send('erro registrado');
  }
};
