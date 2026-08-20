# Fut dos Filhos — app da pelada

Página única (`index.html`), sem build, sem servidor. Roda no GitHub Pages e guarda os dados no Firestore.

---

## Testar agora, sem configurar nada

Abra o `index.html` no navegador. Ele já sobe em **modo demonstração**: 16 atletas, 4 rodadas, pagamentos e caixa de exemplo. Dá para clicar em tudo — só não salva. Serve para você ver se o formato serve antes de mexer no Firebase.

A senha de admin na demonstração é `1234` (botão 🔒 no topo).

---

## 1. Criar o projeto no Firebase

1. Acesse `console.firebase.google.com` → **Adicionar projeto**. Nome: `fut-dos-filhos`. Pode desativar o Google Analytics.
2. Menu **Criar** → **Firestore Database** → **Criar banco de dados** → modo de produção → região `southamerica-east1` (São Paulo).
3. Menu **Criar** → **Authentication** → **Vamos começar** → aba **Sign-in method** → ative **Anônimo**.
   Sem isso as regras do passo 3 bloqueiam tudo.
4. Ícone de engrenagem → **Configurações do projeto** → role até **Seus apps** → ícone `</>` (Web) → registre o app → copie o bloco `firebaseConfig`.

## 2. Colar a configuração — **já feito**

O `index.html` já aponta para o projeto `futfilhos`. Este passo só interessa se um dia você trocar de projeto: procure `firebaseConfig` (por volta da linha 268) e substitua o bloco pelo que o Firebase te der.

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "fut-dos-filhos.firebaseapp.com",
  projectId: "fut-dos-filhos",
  storageBucket: "fut-dos-filhos.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123"
};
```

Com o `apiKey` preenchido, o modo demonstração está desligado: o app lê e grava de verdade. Os 16 atletas de exemplo não existem mais — a tela abre vazia até você cadastrar o pessoal.

> Essa `apiKey` fica visível no código-fonte da página, e tudo bem: no Firebase Web ela identifica o projeto, não autentica ninguém. Quem protege os dados são as regras abaixo.

## 3. Regras do Firestore

Firestore → aba **Regras** → cole e publique:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}
```

**O que isso protege e o que não protege.** Bloqueia acesso anônimo de fora do app (robôs varrendo a internet, por exemplo). Não impede que alguém com o link do site escreva no banco — o login anônimo é automático para qualquer visitante. A senha de admin trava a interface, não o banco: ela fica salva no próprio Firestore e alguém que abra o DevTools consegue ler.

Para uma pelada de amigos isso costuma bastar. Se um dia incomodar, o caminho é trocar o login anônimo por login com Google e liberar escrita só para UIDs de uma lista — dá umas 30 linhas a mais no app.

## 4. Publicar no GitHub Pages

1. Crie um repositório público, por exemplo `fut-dos-filhos`.
2. Suba o `index.html` na raiz (dá para arrastar pelo próprio site do GitHub, em **Add file → Upload files**).
   O escudo está embutido dentro do próprio HTML, então o site funciona só com esse arquivo. O `logo.png` é opcional: suba junto se quiser o ícone certo quando alguém adicionar o site à tela inicial do celular.
3. **Settings** → **Pages** → em *Source* escolha **Deploy from a branch** → branch `main`, pasta `/ (root)` → **Save**.
4. Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/fut-dos-filhos/`.

Cada `index.html` novo que você subir republica sozinho.

## 5. Primeiro uso

1. Abra o site, clique em 🔒 e entre com a senha `1234`.
2. **Caixa → Ajustes da pelada**: chave Pix, favorecido, dia e hora da pelada, custo padrão da quadra, vagas por rodada e — importante — **troque a senha**. O dia escolhido vira o padrão ao marcar um jogo novo e aparece embaixo do escudo.
3. **Atletas**: cadastre a galera. Cada um entra como **fixo**, **convidado** (aí você indica quem trouxe) ou **inativo**.
4. **Agenda → Marcar jogo**: data, local e custo.
5. Mande o link no grupo do WhatsApp.

Cada um escolhe o próprio nome no topo e toca em **Vou jogar**. Quem passar do número de vagas cai na lista de espera automaticamente.

## 6. Fechar a rodada depois que o jogo acontece

Na **Agenda**, toque em qualquer rodada — passada ou futura — para abrir a lista dela. Em modo admin aparece o botão **Fechar a rodada**, que abre o painel com todos os atletas e dois botões por linha:

- **jogou / fora** — quem realmente apareceu, independente do que confirmou antes
- **pago / a pagar** — só fica ativo para quem jogou

O topo do painel mostra ao vivo quantos jogaram, quanto ficou por cabeça e quanto já entrou. No rateio o valor por cabeça muda a cada pessoa que você inclui — 180 divididos por 9 dá 20, por 10 dá 18. Tem também **Todos pagaram**, para quando a rodada fecha redonda.

Nada disso mexe no caixa até você tocar em **Salvar rodada**.

Para voltar à próxima partida, use o botão na faixa preta do topo ou toque na aba *A lista*.

### Link direto por atleta

Quando alguém escolhe o nome, a URL vira `.../#eu=a-xxxx`. Se a pessoa salvar esse link, ela já entra com o nome selecionado. Serve para mandar no privado de quem esquece toda semana.

---

## QR Code e baixa de pagamento

O botão **QR Code**, na caixa do jogo, monta um BR Code no padrão EMV do Banco Central com chave, valor da diária, nome, cidade e um identificador (`FUT` + data + nome do atleta). Quem escaneia já vê o valor preenchido no app do banco. Abaixo do código vem o **copia e cola**, para quem prefere colar.

Se o atleta tiver dívida de rodadas anteriores, aparecem duas opções: pagar só a rodada ou tudo em aberto.

Depois de pagar, ele toca em **Já fiz o Pix**. Isso não dá baixa — marca a linha dele como *avisou o Pix* (selo âmbar). O organizador confere o extrato e confirma tocando no selo. Se o atleta não estiver escalado na rodada aberta, o aviso cai automaticamente na pendência mais antiga dele.

### Por que a baixa não é automática

Para o site marcar "pago" sozinho, alguém precisa avisá-lo de que o dinheiro caiu — e só o banco sabe disso. Isso exige três coisas que uma página estática no GitHub Pages não tem:

1. Uma conta com **API Pix** (bancos como Inter, Sicredi, Efí, ou gateways como Mercado Pago e Asaas). Boa parte exige CNPJ.
2. Um **servidor** para receber o webhook do banco e guardar o certificado/segredo. Não dá para deixar isso no JavaScript da página: qualquer visitante leria as credenciais.
3. Cobranças com identificador único por atleta, para casar o Pix recebido com a pessoa certa.

O caminho natural, já que o projeto usa Firebase, seria uma **Cloud Function** recebendo o webhook e escrevendo `pago: true` no Firestore. Funciona bem, mas exige o plano Blaze (pré-pago, com cota gratuita) e uma conta habilitada na API do banco. Se um dia você quiser seguir por aí, o identificador que já vai dentro do QR (`FUT2308GUSTAVO`) é exatamente o que amarra o Pix recebido ao atleta.

Enquanto isso, o fluxo *avisou → organizador confirma* resolve o essencial: você para de garimpar mensagem no grupo e passa a olhar só quem levantou a mão.

## Como as contas funcionam

- **Rateio (padrão)**: o custo da quadra é dividido pelos confirmados daquela rodada. Vieram 12, a quadra custou 180 → R$ 15 cada. Vieram 8 → R$ 22,50 cada.
- **Valor fixo**: preenchendo *Valor fixo por cabeça* no jogo, todo mundo paga aquele valor e o rateio é ignorado.
- **Caixa** = tudo que os atletas pagaram − (custo das rodadas já jogadas + despesas avulsas).

Um detalhe que aparece rápido: no rateio puro o caixa nunca sobra, porque a arrecadação é exatamente igual ao custo. Se você quer formar caixa para bola, colete ou a confraternização de fim de ano, use valor fixo um pouco acima do rateio — R$ 20 numa quadra que sai a R$ 15 por cabeça deixa R$ 60 por rodada no caixa.

Só entram na conta os jogos com data igual ou anterior a hoje. Rodada futura já confirmada não vira dívida antes de acontecer.

## Custo

Zero, na prática. O plano gratuito do Firebase dá 50 mil leituras e 20 mil gravações por dia; uma pelada de 25 pessoas usa uma fração disso. O GitHub Pages é gratuito para repositório público.

## Limitações conhecidas

- Sem histórico de quem alterou o quê.
- Remover um atleta apaga o histórico de presença dele junto. Para tirar alguém da lista mantendo o histórico, marque como **inativo**.
- Convidado é uma situação do cadastro, não um tipo de cobrança: ele paga a mesma diária dos fixos. Se na sua pelada o convidado paga mais, cadastre a rodada com *valor fixo por cabeça* e acerte a diferença por fora.
- Um pagamento avulso (adiantar três rodadas de uma vez) precisa ser marcado rodada a rodada, no painel de cada uma.
