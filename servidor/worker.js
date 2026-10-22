/* Discípulos United — servidor de pagamento (Cloudflare Workers, plano grátis)
   POST /pagar    → o atleta logado escolhe meses + forma; devolve o link do Stripe Checkout
   POST /webhook  → o Stripe avisa que foi pago; os meses ficam marcados no Firestore
   Segredos (Settings → Variables and Secrets):
     STRIPE_SECRET_KEY      sk_live_...            (ou sk_test_... para testar)
     STRIPE_WEBHOOK_SECRET  whsec_...
     FIREBASE_SA            o JSON inteiro da conta de serviço do Firebase
     MP_ACCESS_TOKEN        (opcional) APP_USR-... do Mercado Pago — com ele, o Pix sai pelo Mercado Pago
   POST /webhook-mp → o Mercado Pago avisa; o servidor confere o pagamento na API dele antes de marcar
   Variáveis opcionais: APP_URL (padrão: https://viniverk.github.io/discipulosunited/) */

const APP_URL_PADRAO = "https://viniverk.github.io/discipulosunited/";
const STRIPE_VERSAO = "2025-03-31.basil";
const MESES_NOMES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

class Erro extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export default {
  // só para os testes automáticos (node servidor/teste.mjs)
  get _teste() { return { valorDaCobranca, limparMeses, assinaturaStripeOk }; },
  async fetch(req, env) {
    const appUrl = env.APP_URL || APP_URL_PADRAO;
    const cors = { "Access-Control-Allow-Origin": new URL(appUrl).origin, "Access-Control-Allow-Methods": "POST, OPTIONS",
                   "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (pathname === "/" && req.method === "GET") return new Response("Servidor de pagamento do Discípulos United: ok");
      if (pathname === "/pagar" && req.method === "POST") return json(await criarPagamento(req, env, appUrl));
      if (pathname === "/webhook" && req.method === "POST") return await webhook(req, env);
      if (pathname === "/webhook-mp" && req.method === "POST") return await webhookMP(req, env);
      return new Response("não encontrado", { status: 404 });
    } catch (e) {
      if (e instanceof Erro) return json({ erro: e.message }, e.status);
      console.error(e && e.stack || e);
      return json({ erro: "Erro no servidor de pagamento." }, 500);
    }
  }
};

/* ---------- regras ---------- */
const arred = n => Math.round(n * 100) / 100;
function valorDaCobranca(valorMensal, tipo, cartaoPct = 0, cartaoFixo = 0) {
  const v = Number(valorMensal) || 0;
  if (tipo !== "card") return arred(v);
  return arred((v + (Number(cartaoFixo) || 0)) / (1 - (Number(cartaoPct) || 0) / 100));
}
const limparMeses = l => Array.isArray(l)
  ? [...new Set(l.map(String).filter(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m)))].sort().slice(0, 12) : [];
const nomeMes = m => { const [a, n] = m.split("-").map(Number); return `${MESES_NOMES[n - 1]} de ${a}`; };

/* ---------- POST /pagar ---------- */
async function criarPagamento(req, env, appUrl) {
  const sa = contaServico(env);
  const uid = await verificarLogin(req.headers.get("Authorization"), sa.project_id);
  const corpo = await req.json().catch(() => ({}));
  const tipo = corpo.tipo === "card" ? "card" : corpo.tipo === "pix" ? "pix" : null;
  const meses = limparMeses(corpo.meses);
  if (!tipo) throw new Erro("Escolha Pix ou cartão.");
  if (!meses.length) throw new Erro("Escolha pelo menos um mês.");

  const fs = await firestore(env);
  const vinculo = await fs.get(`vinculos/${uid}`);
  const atletaId = vinculo && vinculo.atletaId;
  if (!atletaId) throw new Erro("Entre no app com sua senha para pagar.", 403);
  const atleta = await fs.get(`atletas/${atletaId}`);
  if (!atleta) throw new Erro("Atleta não encontrado.", 404);
  const situacao = atleta.situacao || (atleta.ativo === false ? "inativo" : "fixo");
  if (situacao !== "fixo") throw new Erro("Só atleta fixo paga mensalidade.");
  const desde = atleta.mensalDesde || "";

  const docs = await Promise.all(meses.map(m => fs.get(`mensalidades/${m}`)));
  const aPagar = meses.filter((m, i) => !((docs[i] && docs[i].pagos) || {})[atletaId] && (!desde || m >= desde));
  if (!aPagar.length) throw new Erro("Esses meses já estão pagos.");

  const cfg = (await fs.get("config/geral")) || {};
  if (!cfg.pagOnline) throw new Erro("Pagamento online desligado nos ajustes.");
  const unit = valorDaCobranca(cfg.valorMensalista ?? 50, tipo, cfg.cartaoPct ?? 3.99, cfg.cartaoFixo ?? 0.39);
  const grupo = cfg.nomeGrupo || "Discípulos United";
  const meta = { atletaId, meses: aPagar.join(","), tipo };
  if (tipo === "pix" && env.MP_ACCESS_TOKEN)
    return await pixMercadoPago(env, fs, { atletaId, nome: atleta.nome || "", meses: aPagar, unit, grupo, origem: new URL(req.url).origin });

  const params = {
    mode: "payment", locale: "pt-BR", "payment_method_types[0]": tipo,
    client_reference_id: atletaId,
    success_url: appUrl + "#pago=ok", cancel_url: appUrl + "#pago=cancelado",
    ...achatar({ metadata: meta, payment_intent_data: { metadata: meta, description: `Mensalidade ${grupo}` } })
  };
  aPagar.forEach((m, i) => Object.assign(params, achatar({ [`line_items[${i}]`]: { quantity: 1, price_data: {
    currency: "brl", unit_amount: Math.round(unit * 100),
    product_data: { name: `Mensalidade ${nomeMes(m)}`, description: `${grupo} — ${atleta.nome || ""}` } } } })));
  if (tipo === "pix") params["payment_method_options[pix][expires_after_seconds]"] = "3600";

  const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST",
    // versão fixa da API: a 2026-09-30 tirou o payment_method_types do Checkout, e é ele que separa Pix de cartão
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded",
               "Stripe-Version": STRIPE_VERSAO },
    body: new URLSearchParams(params) });
  const sessao = await resp.json();
  if (!resp.ok) {
    const msg = (sessao.error && sessao.error.message) || "erro desconhecido";
    console.error("Stripe recusou:", msg);
    if (tipo === "pix" && /pix/i.test(msg)) throw new Erro("O Pix ainda não está ativo na conta do Stripe. Use o cartão por enquanto. (Stripe: " + msg + ")");
    throw new Erro("O Stripe não aceitou a cobrança: " + msg, 502);
  }
  await fs.set(`pagamentosStripe/${sessao.id}`, { atletaId, meses: aPagar, tipo, valor: arred(unit * aPagar.length), status: "aberto", em: Date.now() });
  return { url: sessao.url, meses: aPagar, valor: arred(unit * aPagar.length) };
}
// {a:{b:1}} → {"a[b]": "1"} (formato que a API do Stripe espera)
function achatar(obj, prefixo = "", saida = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const chave = prefixo ? `${prefixo}[${k}]` : k;
    if (v && typeof v === "object") achatar(v, chave, saida); else saida[chave] = String(v);
  }
  return saida;
}

/* ---------- POST /webhook ---------- */
async function webhook(req, env) {
  const bruto = await req.text();
  if (!(await assinaturaStripeOk(bruto, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET)))
    return new Response("assinatura inválida", { status: 400 });
  const evento = JSON.parse(bruto);
  const fs = await firestore(env);
  // o Stripe pode reenviar o mesmo evento: cada id é processado uma vez só
  const novo = await fs.criarSeNaoExiste(`eventosStripe/${evento.id}`, { tipo: evento.type, em: Date.now() });
  if (!novo) return new Response("ok (repetido)");
  const s = evento.data && evento.data.object || {};
  try {
    if ((evento.type === "checkout.session.completed" && s.payment_status === "paid") || evento.type === "checkout.session.async_payment_succeeded") {
      await marcarPago(fs, s, evento.id);
    } else if (evento.type === "checkout.session.expired" || evento.type === "checkout.session.async_payment_failed") {
      await fs.set(`pagamentosStripe/${s.id}`, { status: evento.type.endsWith("expired") ? "expirado" : "falhou" }, true);
    }
  } catch (e) {
    await fs.apagar(`eventosStripe/${evento.id}`).catch(() => {});   // libera para o Stripe tentar de novo
    throw e;
  }
  return new Response("ok");
}
async function marcarPago(fs, s, eventoId) {
  const md = s.metadata || {};
  const atletaId = md.atletaId, meses = String(md.meses || "").split(",").filter(Boolean);
  if (!atletaId || !meses.length) { console.warn("Sessão sem metadados", s.id); return; }
  await marcarMeses(fs, atletaId, meses, { pagamento: s.id, forma: md.tipo || "", valor: arred((s.amount_total || 0) / 100 / meses.length) });
  await fs.set(`pagamentosStripe/${s.id}`, { status: "pago", pagoEm: Date.now(), evento: eventoId }, true);
}
async function marcarMeses(fs, atletaId, meses, online) {
  const agora = Date.now();
  for (const m of meses)
    await fs.set(`mensalidades/${m}`, { pagos: { [atletaId]: agora }, online: { [atletaId]: online } }, true);
}

/* ---------- Pix pelo Mercado Pago ---------- */
// cria a cobrança Pix e devolve o QR code para o app mostrar
async function pixMercadoPago(env, fs, { atletaId, nome, meses, unit, grupo, origem }) {
  const total = arred(unit * meses.length);
  const expira = new Date(Date.now() + 60 * 60e3 - 3 * 3600e3).toISOString().replace("Z", "-03:00");   // 1 hora, no horário de Brasília
  const resp = await fetch("https://api.mercadopago.com/v1/payments", { method: "POST",
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`, "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      transaction_amount: total, payment_method_id: "pix",
      description: `Mensalidade ${grupo} — ${meses.map(nomeMes).join(", ")}`,
      external_reference: `mensalidade|${atletaId}|${meses.join(",")}`,
      notification_url: `${origem}/webhook-mp`,
      date_of_expiration: expira,
      payer: { email: emailPagador(atletaId), first_name: (nome.split(" ")[0] || "Atleta").slice(0, 40) }
    }) });
  const pg = await resp.json().catch(() => ({}));
  if (!resp.ok || !pg.id) {
    console.error("Mercado Pago recusou:", JSON.stringify(pg));
    throw new Erro("O Mercado Pago não aceitou a cobrança: " + (pg.message || pg.error || resp.status), 502);
  }
  const td = (pg.point_of_interaction && pg.point_of_interaction.transaction_data) || {};
  await fs.set(`pagamentosMP/${pg.id}`, { atletaId, meses, tipo: "pix", valor: total, status: pg.status || "pending", em: Date.now() });
  return { pix: true, id: String(pg.id), meses, valor: total, qr: td.qr_code_base64 || "", copiaCola: td.qr_code || "", link: td.ticket_url || "" };
}
// o Mercado Pago exige um e-mail do pagador; usamos um endereço fixo por atleta (não recebe nada)
const emailPagador = id => String(id).normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 40) + "@pagamentos.discipulosunited.com.br";

// aviso do Mercado Pago: só traz o id; o status é conferido direto na API dele (aviso falso não marca nada)
async function webhookMP(req, env) {
  const url = new URL(req.url);
  const corpo = await req.json().catch(() => ({}));
  const tipo = corpo.type || corpo.topic || url.searchParams.get("type") || url.searchParams.get("topic") || "";
  const id = String((corpo.data && corpo.data.id) || url.searchParams.get("data.id") || url.searchParams.get("id") || "");
  if (!/payment/.test(tipo) || !/^\d+$/.test(id) || !env.MP_ACCESS_TOKEN) return new Response("ok");
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, { headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` } });
  if (r.status === 404) return new Response("ok (pagamento desconhecido)");
  if (!r.ok) { console.error("Mercado Pago: erro ao consultar", id, r.status); return new Response("erro ao consultar", { status: 500 }); }
  const pg = await r.json();
  const fs = await firestore(env);
  const ref = String(pg.external_reference || "").split("|");
  if (pg.status !== "approved" || ref[0] !== "mensalidade" || !ref[1] || !ref[2]) {
    if (ref[0] === "mensalidade") await fs.set(`pagamentosMP/${id}`, { status: pg.status || "?" }, true);
    return new Response("ok");
  }
  // cada pagamento aprovado é processado uma vez só
  if (!(await fs.criarSeNaoExiste(`eventosMP/${id}`, { em: Date.now() }))) return new Response("ok (repetido)");
  const meses = ref[2].split(",").filter(Boolean);
  try {
    await marcarMeses(fs, ref[1], meses, { pagamento: `mp_${id}`, forma: "pix", valor: arred((pg.transaction_amount || 0) / meses.length) });
    await fs.set(`pagamentosMP/${id}`, { status: "pago", pagoEm: Date.now() }, true);
  } catch (e) {
    await fs.apagar(`eventosMP/${id}`).catch(() => {});
    throw e;
  }
  return new Response("ok");
}
async function assinaturaStripeOk(bruto, cabecalho, segredo, agoraSeg = Math.floor(Date.now() / 1000)) {
  if (!cabecalho || !segredo) return false;
  const partes = Object.fromEntries(cabecalho.split(",").map(p => p.split("=")).map(([k, ...v]) => [k.trim(), v.join("=")]));
  const t = Number(partes.t);
  if (!t || Math.abs(agoraSeg - t) > 300) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(`${t}.${bruto}`)));
  const esperado = [...mac].map(b => b.toString(16).padStart(2, "0")).join("");
  const recebidos = cabecalho.split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  return recebidos.some(v => v.length === esperado.length && [...v].reduce((d, c, i) => d | (c.charCodeAt(0) ^ esperado.charCodeAt(i)), 0) === 0);
}

/* ---------- login do Firebase (token do aparelho) ---------- */
let chavesGoogle = null;
async function verificarLogin(cabecalho, projeto) {
  const token = String(cabecalho || "").replace(/^Bearer\s+/i, "");
  const [h64, p64, s64] = token.split(".");
  if (!s64) throw new Erro("Entre no app com sua senha.", 401);
  const cab = JSON.parse(b64urlTexto(h64)), dados = JSON.parse(b64urlTexto(p64));
  const agora = Math.floor(Date.now() / 1000);
  if (cab.alg !== "RS256" || dados.aud !== projeto || dados.iss !== `https://securetoken.google.com/${projeto}`
      || !(dados.exp > agora) || !(dados.iat <= agora + 60) || !dados.sub) throw new Erro("Login expirado. Abra o app de novo.", 401);
  if (!chavesGoogle || chavesGoogle.validade < Date.now()) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    chavesGoogle = { lista: (await r.json()).keys || [], validade: Date.now() + 3600e3 };
  }
  const jwk = chavesGoogle.lista.find(k => k.kid === cab.kid);
  if (!jwk) { chavesGoogle = null; throw new Erro("Login expirado. Abra o app de novo.", 401); }
  const chave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, b64urlBytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
  if (!ok) throw new Erro("Login inválido.", 401);
  return dados.sub;
}

/* ---------- Firestore pela API REST, com a conta de serviço ---------- */
function contaServico(env) {
  try { const sa = JSON.parse(env.FIREBASE_SA); if (sa.client_email && sa.private_key && sa.project_id) return sa; } catch (_) {}
  throw new Erro("Servidor sem a chave do Firebase (FIREBASE_SA).", 500);
}
let tokenGoogle = null;
async function tokenDoGoogle(sa) {
  if (tokenGoogle && tokenGoogle.validade > Date.now() + 60e3) return tokenGoogle.valor;
  const agora = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const corpo = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 })}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const assin = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(corpo))));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${corpo}.${assin}` }) });
  const j = await r.json();
  if (!r.ok) throw new Error("Google recusou a conta de serviço: " + JSON.stringify(j));
  tokenGoogle = { valor: j.access_token, validade: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenGoogle.valor;
}
async function firestore(env) {
  const sa = contaServico(env);
  const base = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/`;
  const cab = async () => ({ Authorization: `Bearer ${await tokenDoGoogle(sa)}`, "Content-Type": "application/json" });
  const urlDoc = p => base + p.split("/").map(encodeURIComponent).join("/");
  return {
    async get(caminho) {
      const r = await fetch(urlDoc(caminho), { headers: await cab() });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Firestore get ${caminho}: ${r.status} ${await r.text()}`);
      return decodificarCampos((await r.json()).fields || {});
    },
    // juntar=true: só os campos enviados mudam (como merge); mapas viram caminhos campo.`chave`
    async set(caminho, dados, juntar = false) {
      const qs = juntar ? caminhosDe(dados).map(c => "updateMask.fieldPaths=" + encodeURIComponent(c)).join("&") : "";
      const r = await fetch(urlDoc(caminho) + (qs ? "?" + qs : ""), { method: "PATCH", headers: await cab(),
        body: JSON.stringify({ fields: codificarCampos(dados) }) });
      if (!r.ok) throw new Error(`Firestore set ${caminho}: ${r.status} ${await r.text()}`);
    },
    async criarSeNaoExiste(caminho, dados) {
      const r = await fetch(urlDoc(caminho) + "?currentDocument.exists=false", { method: "PATCH", headers: await cab(),
        body: JSON.stringify({ fields: codificarCampos(dados) }) });
      if (r.ok) return true;
      if (r.status === 409 || r.status === 400 || r.status === 412) return false;
      throw new Error(`Firestore criar ${caminho}: ${r.status} ${await r.text()}`);
    },
    async apagar(caminho) { await fetch(urlDoc(caminho), { method: "DELETE", headers: await cab() }); }
  };
}
const nomeCampo = k => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : "`" + k.replace(/[`\\]/g, m => "\\" + m) + "`";
function caminhosDe(obj, prefixo = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    const c = prefixo ? `${prefixo}.${nomeCampo(k)}` : nomeCampo(k);
    return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && prefixo === "" && ["pagos","online"].includes(k)
      ? caminhosDe(v, c) : [c];
  });
}
function codificar(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(codificar) } };
  return { mapValue: { fields: codificarCampos(v) } };
}
const codificarCampos = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, codificar(v)]));
function decodificar(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodificar);
  if ("mapValue" in v) return decodificarCampos(v.mapValue.fields || {});
  return null;
}
const decodificarCampos = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decodificar(v)]));

/* ---------- base64url ---------- */
function b64url(bytes) { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlBytes(t) { const s = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); }
const b64urlTexto = t => new TextDecoder().decode(b64urlBytes(t));
