/* Discípulos United — pagamento da mensalidade pelo Stripe
   - criarPagamento: o atleta logado escolhe os meses e a forma (Pix ou cartão) e recebe o link do Stripe Checkout
   - webhookStripe:  o Stripe avisa que foi pago e os meses ficam marcados no app */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { valorDaCobranca, centavos, limparMeses, nomeMes } = require("./regras");

admin.initializeApp();
const db = admin.firestore();

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");          // sk_live_... (ou sk_test_... para testar)
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");  // whsec_...
const APP_URL = defineString("APP_URL", { default: "https://viniverk.github.io/discipulosunited/" });
const REGIAO = "southamerica-east1";
const stripeDe = () => new Stripe(STRIPE_SECRET_KEY.value());

exports.criarPagamento = onCall({ region: REGIAO, secrets: [STRIPE_SECRET_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Entre no app com sua senha.");
  const tipo = req.data?.tipo === "card" ? "card" : req.data?.tipo === "pix" ? "pix" : null;
  const meses = limparMeses(req.data?.meses);
  if (!tipo) throw new HttpsError("invalid-argument", "Escolha Pix ou cartão.");
  if (!meses.length) throw new HttpsError("invalid-argument", "Escolha pelo menos um mês.");

  // quem paga: o atleta vinculado a este aparelho (login com senha)
  const vinc = await db.doc(`vinculos/${req.auth.uid}`).get();
  const atletaId = vinc.exists ? vinc.get("atletaId") : null;
  if (!atletaId) throw new HttpsError("permission-denied", "Entre no app com sua senha para pagar.");
  const atleta = await db.doc(`atletas/${atletaId}`).get();
  if (!atleta.exists) throw new HttpsError("not-found", "Atleta não encontrado.");
  const situacao = atleta.get("situacao") || (atleta.get("ativo") === false ? "inativo" : "fixo");
  if (situacao !== "fixo") throw new HttpsError("failed-precondition", "Só atleta fixo paga mensalidade.");
  const desde = atleta.get("mensalDesde") || "";

  // tira meses já pagos ou anteriores ao início como mensalista
  const docs = await Promise.all(meses.map(m => db.doc(`mensalidades/${m}`).get()));
  const aPagar = meses.filter((m, i) => !(docs[i].exists && (docs[i].get("pagos") || {})[atletaId]) && (!desde || m >= desde));
  if (!aPagar.length) throw new HttpsError("already-exists", "Esses meses já estão pagos.");

  const cfg = (await db.doc("config/geral").get()).data() || {};
  if (!cfg.pagOnline) throw new HttpsError("failed-precondition", "Pagamento online desligado nos ajustes.");
  const unit = valorDaCobranca(cfg.valorMensalista ?? 50, tipo, cfg.cartaoPct ?? 3.99, cfg.cartaoFixo ?? 0.39);
  const grupo = cfg.nomeGrupo || "Discípulos United";

  const params = {
    mode: "payment",
    payment_method_types: [tipo],
    line_items: aPagar.map(m => ({ quantity: 1, price_data: { currency: "brl", unit_amount: centavos(unit),
      product_data: { name: `Mensalidade ${nomeMes(m)}`, description: `${grupo} — ${atleta.get("nome")}` } } })),
    client_reference_id: atletaId,
    metadata: { atletaId, meses: aPagar.join(","), tipo },
    payment_intent_data: { metadata: { atletaId, meses: aPagar.join(","), tipo }, description: `Mensalidade ${grupo}` },
    success_url: APP_URL.value() + "#pago=ok",
    cancel_url: APP_URL.value() + "#pago=cancelado",
    locale: "pt-BR"
  };
  if (tipo === "pix") params.payment_method_options = { pix: { expires_after_seconds: 3600 } };

  let sessao;
  try { sessao = await stripeDe().checkout.sessions.create(params); }
  catch (e) {
    logger.error("Stripe recusou", e?.message);
    if (tipo === "pix" && /pix/i.test(e?.message || ""))
      throw new HttpsError("failed-precondition", "O Pix ainda não está ativo na conta do Stripe. Use o cartão por enquanto.");
    throw new HttpsError("internal", "O Stripe não aceitou a cobrança: " + (e?.message || "erro desconhecido"));
  }
  await db.doc(`pagamentosStripe/${sessao.id}`).set({ atletaId, meses: aPagar, tipo, valor: unit * aPagar.length,
    status: "aberto", em: Date.now() });
  return { url: sessao.url, meses: aPagar, valor: unit * aPagar.length };
});

// marca os meses como pagos (mesmo formato que o admin usa na mão)
async function marcarPago(sessao, eventoId) {
  const atletaId = sessao.metadata?.atletaId, meses = (sessao.metadata?.meses || "").split(",").filter(Boolean);
  if (!atletaId || !meses.length) { logger.warn("Sessão sem metadados", sessao.id); return; }
  const agora = Date.now();
  const lote = db.batch();
  meses.forEach(m => lote.set(db.doc(`mensalidades/${m}`), {
    pagos: { [atletaId]: agora },
    online: { [atletaId]: { pagamento: sessao.id, forma: sessao.metadata?.tipo || "", valor: (sessao.amount_total || 0) / 100 / meses.length } }
  }, { merge: true }));
  lote.set(db.doc(`pagamentosStripe/${sessao.id}`), { status: "pago", pagoEm: agora, evento: eventoId }, { merge: true });
  await lote.commit();
  logger.info("Mensalidades pagas", atletaId, meses);
}

exports.webhookStripe = onRequest({ region: REGIAO, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] }, async (req, res) => {
  let evento;
  try { evento = stripeDe().webhooks.constructEvent(req.rawBody, req.get("stripe-signature"), STRIPE_WEBHOOK_SECRET.value()); }
  catch (e) { logger.warn("Assinatura inválida", e?.message); return res.status(400).send("assinatura inválida"); }
  try {
    // o Stripe pode reenviar o mesmo evento: cada id é processado uma vez só
    const marca = db.doc(`eventosStripe/${evento.id}`);
    if ((await marca.get()).exists) return res.status(200).send("ok (repetido)");
    const s = evento.data.object;
    if ((evento.type === "checkout.session.completed" && s.payment_status === "paid")
        || evento.type === "checkout.session.async_payment_succeeded") {
      await marcarPago(s, evento.id);
    } else if (["checkout.session.expired", "checkout.session.async_payment_failed"].includes(evento.type)) {
      await db.doc(`pagamentosStripe/${s.id}`).set({ status: evento.type.endsWith("expired") ? "expirado" : "falhou" }, { merge: true });
    }
    await marca.set({ tipo: evento.type, em: Date.now() });
    return res.status(200).send("ok");
  } catch (e) {
    logger.error("Falha no webhook", e);
    return res.status(500).send("erro");   // o Stripe tenta de novo
  }
});
