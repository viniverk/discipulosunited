/* Discípulos United — pagamento da mensalidade pelo Asaas
   - criarCobranca: o atleta logado pede uma cobrança (Pix ou cartão) de um mês
   - webhookAsaas:  o Asaas avisa que foi pago e a mensalidade fica marcada no app */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { valorDaCobranca, refDe, lerRef, EVENTOS_PAGO, cpfValido, soDigitos } = require("./regras");

admin.initializeApp();
const db = admin.firestore();

const ASAAS_API_KEY = defineSecret("ASAAS_API_KEY");
const ASAAS_WEBHOOK_TOKEN = defineSecret("ASAAS_WEBHOOK_TOKEN");
// produção: https://api.asaas.com/v3 · testes: https://api-sandbox.asaas.com/v3
const ASAAS_URL = defineString("ASAAS_URL", { default: "https://api.asaas.com/v3" });
const REGIAO = "southamerica-east1";

async function asaas(caminho, opcoes = {}) {
  const resp = await fetch(ASAAS_URL.value() + caminho, {
    ...opcoes,
    headers: { "Content-Type": "application/json", "User-Agent": "discipulos-united/1.0",
               access_token: ASAAS_API_KEY.value(), ...(opcoes.headers || {}) }
  });
  const corpo = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    logger.error("Asaas recusou", caminho, resp.status, corpo);
    const msg = corpo?.errors?.[0]?.description || `Asaas respondeu ${resp.status}`;
    throw new HttpsError("failed-precondition", msg);
  }
  return corpo;
}

const hojeSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const somarDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

exports.criarCobranca = onCall({ region: REGIAO, secrets: [ASAAS_API_KEY] }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Entre no app com sua senha.");
  const { mes, tipo, cpf } = req.data || {};
  if (!/^\d{4}-\d{2}$/.test(String(mes))) throw new HttpsError("invalid-argument", "Mês inválido.");
  if (!["PIX", "CREDIT_CARD"].includes(tipo)) throw new HttpsError("invalid-argument", "Forma de pagamento inválida.");

  // quem está pagando: o atleta vinculado a este aparelho (login com senha)
  const vinc = await db.doc(`vinculos/${req.auth.uid}`).get();
  const atletaId = vinc.exists ? vinc.get("atletaId") : null;
  if (!atletaId) throw new HttpsError("permission-denied", "Entre no app com sua senha para pagar.");
  const atleta = await db.doc(`atletas/${atletaId}`).get();
  if (!atleta.exists) throw new HttpsError("not-found", "Atleta não encontrado.");
  const situacao = atleta.get("situacao") || (atleta.get("ativo") === false ? "inativo" : "fixo");
  if (situacao !== "fixo") throw new HttpsError("failed-precondition", "Só atleta fixo paga mensalidade.");

  const mens = await db.doc(`mensalidades/${mes}`).get();
  if (mens.exists && (mens.get("pagos") || {})[atletaId]) throw new HttpsError("already-exists", "Esse mês já está pago.");

  const cfg = (await db.doc("config/geral").get()).data() || {};
  if (!cfg.pagOnline) throw new HttpsError("failed-precondition", "Pagamento online desligado nos ajustes.");
  const valor = valorDaCobranca(cfg.valorMensalista ?? 50, tipo, cfg.cartaoPct, cfg.cartaoFixo);

  // reaproveita a cobrança em aberto do mesmo mês e forma, para não gerar duas
  const abertas = await db.collection("cobrancas")
    .where("atletaId", "==", atletaId).where("mes", "==", mes).where("tipo", "==", tipo)
    .where("status", "==", "PENDING").limit(1).get();
  let cobranca = abertas.empty ? null : { id: abertas.docs[0].id, ...abertas.docs[0].data() };
  if (cobranca && Math.abs(cobranca.valor - valor) > 0.009) cobranca = null;   // valor mudou: faz outra

  if (!cobranca) {
    // cliente no Asaas: guardamos só o id; o CPF fica apenas no Asaas
    const cli = await db.doc(`asaasClientes/${atletaId}`).get();
    let customer = cli.exists ? cli.get("customer") : null;
    if (!customer) {
      if (!cpf) return { precisaCpf: true };
      if (!cpfValido(cpf)) throw new HttpsError("invalid-argument", "CPF inválido.");
      const novo = await asaas("/customers", { method: "POST", body: JSON.stringify({
        name: atleta.get("nome"), cpfCnpj: soDigitos(cpf), externalReference: atletaId,
        notificationDisabled: true }) });
      customer = novo.id;
      await db.doc(`asaasClientes/${atletaId}`).set({ customer, em: Date.now() });
    }
    const pg = await asaas("/payments", { method: "POST", body: JSON.stringify({
      customer, billingType: tipo, value: valor, dueDate: somarDias(hojeSP(), 3),
      description: `Mensalidade ${mes} — ${cfg.nomeGrupo || "Discípulos United"}`,
      externalReference: refDe(mes, atletaId) }) });
    cobranca = { id: pg.id, atletaId, mes, tipo, valor, status: "PENDING", invoiceUrl: pg.invoiceUrl || "", em: Date.now() };
    await db.doc(`cobrancas/${pg.id}`).set(cobranca);
  }

  const resposta = { id: cobranca.id, valor: cobranca.valor, tipo, invoiceUrl: cobranca.invoiceUrl };
  if (tipo === "PIX") {
    const qr = await asaas(`/payments/${cobranca.id}/pixQrCode`);
    resposta.qr = qr.encodedImage; resposta.copiaCola = qr.payload;
  }
  return resposta;
});

exports.webhookAsaas = onRequest({ region: REGIAO, secrets: [ASAAS_WEBHOOK_TOKEN] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("use POST");
  if (req.get("asaas-access-token") !== ASAAS_WEBHOOK_TOKEN.value()) return res.status(401).send("token inválido");
  const ev = req.body || {};
  const pg = ev.payment || {};
  try {
    // o Asaas pode mandar o mesmo evento mais de uma vez: cada id de evento é processado uma vez só
    if (ev.id) {
      const marca = db.doc(`eventosAsaas/${ev.id}`);
      const ja = await marca.get();
      if (ja.exists) return res.status(200).send("ok (repetido)");
      await marca.set({ event: ev.event || "", payment: pg.id || "", em: Date.now() });
    }
    const ref = lerRef(pg.externalReference);
    if (ref && EVENTOS_PAGO.has(ev.event)) {
      await db.doc(`mensalidades/${ref.mes}`).set({
        pagos: { [ref.atletaId]: Date.now() },
        online: { [ref.atletaId]: { pagamento: pg.id || "", forma: pg.billingType || "", valor: pg.value || 0 } }
      }, { merge: true });
      if (pg.id) await db.doc(`cobrancas/${pg.id}`).set({ status: "PAGO", pagoEm: Date.now(), evento: ev.event }, { merge: true });
      logger.info("Mensalidade paga", ref, ev.event);
    } else if (pg.id && ["PAYMENT_DELETED", "PAYMENT_REFUNDED", "PAYMENT_OVERDUE"].includes(ev.event)) {
      await db.doc(`cobrancas/${pg.id}`).set({ status: ev.event.replace("PAYMENT_", "") }, { merge: true });
    }
    return res.status(200).send("ok");
  } catch (e) {
    logger.error("Falha no webhook", e);
    return res.status(500).send("erro");   // o Asaas tenta de novo
  }
});
