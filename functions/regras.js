/* Regras de negócio puras (sem Firebase): fáceis de testar. */

// valor cobrado: Pix sai pelo valor da mensalidade (o time absorve a taxa);
// no cartão a taxa do Asaas é somada para o atleta, de forma que o time receba o valor cheio.
function valorDaCobranca(valorMensal, tipo, cartaoPct = 0, cartaoFixo = 0) {
  const v = Number(valorMensal) || 0;
  if (tipo !== "CREDIT_CARD") return arred(v);
  const pct = (Number(cartaoPct) || 0) / 100;
  // valor bruto que, depois de descontada a taxa (pct do bruto + fixo), deixa v líquido
  return arred((v + (Number(cartaoFixo) || 0)) / (1 - pct));
}
const arred = n => Math.round(n * 100) / 100;

const refDe = (mes, atletaId) => `mensalidade|${mes}|${atletaId}`;
function lerRef(ref) {
  const p = String(ref || "").split("|");
  if (p.length !== 3 || p[0] !== "mensalidade" || !/^\d{4}-\d{2}$/.test(p[1]) || !p[2]) return null;
  return { mes: p[1], atletaId: p[2] };
}

// eventos do Asaas que contam como "pago": Pix chega como RECEIVED; cartão como CONFIRMED (e depois RECEIVED)
const EVENTOS_PAGO = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

const soDigitos = s => String(s || "").replace(/\D/g, "");
function cpfValido(cpf) {
  const c = soDigitos(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

module.exports = { valorDaCobranca, refDe, lerRef, EVENTOS_PAGO, cpfValido, soDigitos };
