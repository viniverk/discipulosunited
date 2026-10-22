/* Regras de negócio puras (sem Firebase nem Stripe): fáceis de testar. */

// Pix sai pelo valor da mensalidade (o time absorve a taxa).
// No cartão a taxa é somada: o atleta paga o bruto e o time recebe o valor cheio.
function valorDaCobranca(valorMensal, tipo, cartaoPct = 0, cartaoFixo = 0) {
  const v = Number(valorMensal) || 0;
  if (tipo !== "card") return arred(v);
  const pct = (Number(cartaoPct) || 0) / 100;
  return arred((v + (Number(cartaoFixo) || 0)) / (1 - pct));
}
const arred = n => Math.round(n * 100) / 100;
const centavos = reais => Math.round(Number(reais) * 100);

const mesValido = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
// lista de meses enviada pelo app: sem repetição, ordenada, no máximo 12 por vez
function limparMeses(lista) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.map(String).filter(mesValido))].sort().slice(0, 12);
}
const nomeMes = m => {
  const [a, n] = m.split("-").map(Number);
  return ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][n - 1] + " de " + a;
};

module.exports = { valorDaCobranca, centavos, limparMeses, mesValido, nomeMes };
