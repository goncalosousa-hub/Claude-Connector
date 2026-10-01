# OutSystems ↔ Claude (protótipo)

Um serviço REST pequeno que deixa uma app OutSystems falar com o Claude e dar-lhe acesso às suas ações. A app diz ao Claude que Server Actions existem; o Claude decide quando precisa de uma, a app executa-a e devolve o resultado, e o Claude responde.

Porquê um serviço intermédio em vez de chamar `api.anthropic.com` diretamente do OutSystems: a chave da API fica fora do OutSystems, a conversa (que inclui blocos internos da API) viaja como um único texto opaco, e as ações descrevem-se com estruturas simples fáceis de montar no Service Studio / ODC Studio.

## Correr

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... PROXY_KEY=um-segredo npm start   # porta 8787
npm test                                                     # testa o ciclo com uma API falsa
```

Variáveis: `ANTHROPIC_API_KEY` (obrigatória), `PROXY_KEY` (segredo que o OutSystems envia no header `X-Proxy-Key`), `CLAUDE_MODEL` (por omissão `claude-opus-5-5`), `PORT`.

O OutSystems Cloud precisa de chegar ao serviço por HTTPS público (por exemplo num serviço como o Render, ou com um túnel tipo ngrok durante testes).

## O ciclo

```
OutSystems                         Serviço                     Claude
 Chat(message, actions)  ───────▶  /v1/chat  ─────────────────▶
                         ◀───────  status=action_required, action{name, inputJson}
 executa a Server Action
 Chat(toolResult, conversation) ─▶ /v1/chat  ─────────────────▶
                         ◀───────  status=answer, text
```

Exemplo da primeira chamada:

```json
{
  "message": "Quantas encomendas pendentes tem o cliente 42?",
  "actions": [{
    "name": "GetPendingOrders",
    "description": "Devolve o número de encomendas pendentes de um cliente.",
    "parameters": [{ "name": "customerId", "type": "string", "description": "Id do cliente", "required": true }]
  }]
}
```

Resposta: `status: "action_required"`, `action.name: "GetPendingOrders"`, `action.inputJson: "{\"customerId\":\"42\"}"` e `conversation`. A segunda chamada envia `toolResult: { toolUseId, result: "3" }`, a mesma `conversation` e as mesmas `actions`; a resposta traz `status: "answer"` e o texto final.

## No OutSystems

1. **Integrations → Consume REST API → Add all methods**, e importar `openapi.yaml` (ou colar o URL do ficheiro). Fica um método `Chat` com as estruturas `ChatRequest`, `Action`, `ToolResult` e `ChatResponse`. Mudar o Base URL para o endereço do serviço e guardar o `X-Proxy-Key` numa Site Property / Setting.
2. Criar uma Server Action `AskClaude(Question) → Answer` que:
   - monta a lista `Actions` com as Server Actions que o Claude pode usar (nome, descrição e parâmetros);
   - chama `Chat` com `message = Question`;
   - **enquanto** `Response.status = "action_required"`: faz um **Switch** em `Response.action.name`, faz `JSON Deserialize` de `inputJson` para a estrutura dos parâmetros dessa ação, chama a Server Action correspondente, serializa o resultado com `JSON Serialize` e volta a chamar `Chat` com `toolResult` e `conversation = Response.conversation`;
   - devolve `Response.text`.
3. Para conversas com várias perguntas, guardar `conversation` (Text) numa entidade ou variável de sessão e enviá-la juntamente com a próxima `message`.

Só as ações que constam da lista `Actions` ficam visíveis para o Claude, e é sempre a app que as executa, por isso as permissões do utilizador continuam a aplicar-se. Ações que alteram dados devem pedir confirmação ao utilizador antes de correr.

## Limitações do protótipo

- Sem streaming: o pedido espera pela resposta completa.
- A conversa vai e volta em cada chamada, por isso cresce com o histórico.
- O Claude pede uma ação de cada vez (sem chamadas em paralelo), o que simplifica o ciclo mas acrescenta voltas.
