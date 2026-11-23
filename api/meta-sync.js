// api/meta-sync.js — puxa gasto, cliques, impressões e IC da Meta e grava em "meta_daily" (Firestore).
// Chamado pela dashboard a cada 10 min (e pelo resumo das 23h). Roda no servidor: o token da Meta nunca vai para o navegador.
//
// Variáveis de ambiente na Vercel:
//   META_TOKEN          token com permissão ads_read (usuário do sistema do Gerenciador de Negócios)
//   META_AD_ACCOUNTS    contas de anúncio separadas por vírgula, ex.: act_123456789,act_987654321
//   SYNC_KEY            (opcional) senha para forçar uma sincronização na hora com ?force=1&k=SENHA
//   META_CAMPAIGN_RULES (opcional) regra por nome de campanha, ex.: "nanna=receitinhas-nanna;secretas=lp-receitas"
//   FIREBASE_SERVICE_ACCOUNT (já existe, é a mesma do webhook)
const admin = require('firebase-admin');
if (!admin.apps.length) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();
const V = 'v25.0';
const TZ = -3; // São Paulo

const dk = d => new Date(d.getTime() + TZ * 36e5).toISOString().slice(0, 10);
const IC_TYPES = ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'];
const act = (arr, types) => { let best = 0; for (const t of types) { const a = (arr || []).find(x => x.action_type === t); if (a) best = Math.max(best, Number(a.value) || 0); } return best; };
const adIdFrom = s => { const m = String(s || '').match(/\|(\d{6,})/); return m ? m[1] : null; };

async function graph(path, params) {
  const out = []; let url = `https://graph.facebook.com/${V}/${path}?` + new URLSearchParams({ ...params, access_token: process.env.META_TOKEN });
  for (let i = 0; url && i < 30; i++) {
    const r = await fetch(url); const j = await r.json();
    if (j.error) throw new Error('Meta: ' + j.error.message);
    out.push(...(j.data || [])); url = j.paging && j.paging.next;
  }
  return out;
}

// anúncio -> oferta: aprendido das visitas/vendas (a UTM utm_content traz o id do anúncio) e guardado em cache
async function adMap(unknownIds) {
  const ref = db.doc('meta_sync/admap'); const snap = await ref.get(); const map = snap.exists ? snap.get('map') || {} : {};
  const missing = unknownIds.filter(id => !map[id]);
  const last = snap.exists ? snap.get('scannedAt') || 0 : 0;
  if (missing.length && Date.now() - last > 30 * 6e4) {
    const since = new Date(Date.now() - 3 * 864e5);
    const [ss, vs] = await Promise.all([
      db.collection('lp_sessions').where('lastActivity', '>=', since).select('product', 'utm_content').get(),
      db.collection('sales').where('createdAt', '>=', since).select('product', 'utm_content').get(),
    ]);
    [...ss.docs, ...vs.docs].forEach(d => { const id = adIdFrom(d.get('utm_content')); const p = d.get('product'); if (id && p && p !== 'teste') map[id] = p; });
    await ref.set({ map, scannedAt: Date.now() });
  }
  return map;
}
const rules = String(process.env.META_CAMPAIGN_RULES || '').split(';').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [new RegExp(k.trim(), 'i'), v.trim()]);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Sem senha: qualquer chamada só consegue pedir uma atualização (no máximo 1 a cada 4 min). Nada é devolvido além de um resumo.
  const forced = req.query.force && process.env.SYNC_KEY && req.query.k === process.env.SYNC_KEY;
  try {
    const st = db.doc('meta_sync/status'); const s = await st.get();
    if (s.exists && Date.now() - (s.get('at') || 0) < 4 * 6e4 && !forced) return res.json({ skip: 'sincronizado há menos de 4 min' });
    await st.set({ at: Date.now() }, { merge: true });

    const today = dk(new Date()), yest = dk(new Date(Date.now() - 864e5));
    const base = { level: 'ad', time_increment: '1', time_range: JSON.stringify({ since: yest, until: today }), limit: '500' };
    const F = 'ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions';
    const accounts = String(process.env.META_AD_ACCOUNTS || '').split(',').map(x => x.trim()).filter(Boolean);
    let rows = [], hrs = [];
    for (const a of accounts) {
      rows.push(...await graph(`${a}/insights`, { ...base, fields: F }));
      hrs.push(...await graph(`${a}/insights`, { ...base, fields: 'ad_id,spend,impressions,inline_link_clicks,actions', breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone' }));
    }
    const map = await adMap([...new Set(rows.map(r => r.ad_id))]);
    const prodOf = r => map[r.ad_id] || (rules.find(([re]) => re.test(r.campaign_name || '')) || [])[1] || 'sem-oferta';
    const adProd = {}; rows.forEach(r => adProd[r.ad_id] = prodOf(r));

    const docs = {};
    const D = (p, d) => docs[p + '_' + d] = docs[p + '_' + d] || { product: p, date: d, spend: 0, impressions: 0, clicks: 0, linkClicks: 0, ic: 0, lpv: 0, campaigns: {}, ads: {},
      hours: { spend: Array(24).fill(0), impressions: Array(24).fill(0), linkClicks: Array(24).fill(0), ic: Array(24).fill(0) } };
    for (const r of rows) {
      const o = D(adProd[r.ad_id], r.date_start), sp = Number(r.spend) || 0, ic = act(r.actions, IC_TYPES);
      o.spend += sp; o.impressions += +r.impressions || 0; o.clicks += +r.clicks || 0; o.linkClicks += +r.inline_link_clicks || 0; o.ic += ic; o.lpv += act(r.actions, ['landing_page_view']);
      const c = o.campaigns[r.campaign_id] = o.campaigns[r.campaign_id] || { name: r.campaign_name, spend: 0, ic: 0, linkClicks: 0 }; c.spend += sp; c.ic += ic; c.linkClicks += +r.inline_link_clicks || 0;
      o.ads[r.ad_id] = { name: r.ad_name, campaign: r.campaign_name, spend: sp, ic, linkClicks: +r.inline_link_clicks || 0, impressions: +r.impressions || 0 };
    }
    for (const h of hrs) {
      const p = adProd[h.ad_id] || 'sem-oferta', o = D(p, h.date_start), hr = parseInt(String(h.hourly_stats_aggregated_by_advertiser_time_zone).slice(0, 2), 10);
      if (isNaN(hr)) continue;
      o.hours.spend[hr] += Number(h.spend) || 0; o.hours.impressions[hr] += +h.impressions || 0; o.hours.linkClicks[hr] += +h.inline_link_clicks || 0; o.hours.ic[hr] += act(h.actions, IC_TYPES);
    }
    const batch = db.batch(), now = admin.firestore.FieldValue.serverTimestamp();
    const old = await db.collection('meta_daily').where('date', 'in', [yest, today]).get();
    old.docs.forEach(d => { if (!docs[d.id]) batch.delete(d.ref); }); // tira sobras (ex.: anúncio que mudou de oferta)
    Object.entries(docs).forEach(([id, d]) => batch.set(db.collection('meta_daily').doc(id), { ...d, updatedAt: now }));
    await batch.commit();
    res.json({ ok: true, anuncios: rows.length, documentos: Object.keys(docs).length, semOferta: rows.filter(r => adProd[r.ad_id] === 'sem-oferta').length });
  } catch (e) {
    console.error(e); res.status(500).json({ erro: String(e.message || e) });
  }
};
