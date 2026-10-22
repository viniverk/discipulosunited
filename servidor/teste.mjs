// Teste rápido das regras do servidor: node servidor/teste.mjs
import worker from "./worker.js";
const { valorDaCobranca, limparMeses, assinaturaStripeOk } = worker._teste;
import assert from "node:assert";
assert.strictEqual(valorDaCobranca(50, "pix", 3.99, 0.39), 50);
assert.strictEqual(valorDaCobranca(50, "card", 3.99, 0.39), 52.48);
assert.deepStrictEqual(limparMeses(["2026-12","2026-11","2026-11","x","2026-13"]), ["2026-11","2026-12"]);
const t = Math.floor(Date.now()/1000), corpo = '{"id":"evt"}';
const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("whsec_x"), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
const v1 = Buffer.from(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${corpo}`))).toString("hex");
assert.strictEqual(await assinaturaStripeOk(corpo, `t=${t},v1=${v1}`, "whsec_x"), true);
assert.strictEqual(await assinaturaStripeOk(corpo, `t=${t},v1=${v1}`, "whsec_y"), false);
console.log("servidor ok");
