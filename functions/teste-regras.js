const r = require("./regras"); const assert = require("assert");
assert.strictEqual(r.valorDaCobranca(50, "pix", 3.99, 0.39), 50);
const bruto = r.valorDaCobranca(50, "card", 3.99, 0.39);
assert.ok(Math.abs(bruto - bruto*0.0399 - 0.39 - 50) < 0.01, "no cartão o time recebe 50");
assert.strictEqual(r.centavos(52.48), 5248);
assert.deepStrictEqual(r.limparMeses(["2026-12","2026-11","2026-11","lixo","2026-13"]), ["2026-11","2026-12"]);
assert.strictEqual(r.nomeMes("2026-03"), "março de 2026");
console.log("regras ok · cartão de R$ 50 sai por R$", bruto);
