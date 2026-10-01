// Testa o ciclo pergunta → ação → resultado → resposta contra uma API do Claude falsa.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const requests = [];
const fake = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push(body);
  const last = body.messages.at(-1);
  const isToolResult = Array.isArray(last.content) && last.content[0].type === "tool_result";
  const content = isToolResult
    ? [{ type: "text", text: `Há ${last.content[0].content} encomendas pendentes.` }]
    : [{ type: "tool_use", id: "toolu_1", name: "GetPendingOrders", input: { customerId: "42" } }];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: body.model, content,
    stop_reason: isToolResult ? "end_turn" : "tool_use", stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
});

let chat;
before(async () => {
  await new Promise((r) => fake.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test";
  ({ chat } = await import("./server.mjs"));
});
after(() => fake.close());

const actions = [{
  name: "GetPendingOrders",
  description: "Devolve o número de encomendas pendentes de um cliente.",
  parameters: [{ name: "customerId", type: "string", description: "Id do cliente", required: true }],
}];

test("pede uma ação e depois responde com o resultado", async () => {
  const first = await chat({ message: "Quantas encomendas pendentes tem o cliente 42?", actions });
  assert.equal(first.status, "action_required");
  assert.equal(first.action.name, "GetPendingOrders");
  assert.deepEqual(JSON.parse(first.action.inputJson), { customerId: "42" });

  const sent = requests[0];
  assert.equal(sent.tools[0].input_schema.required[0], "customerId");
  assert.equal(sent.fallbacks, "default");
  assert.equal(sent.tool_choice.disable_parallel_tool_use, true);

  const second = await chat({
    toolResult: { toolUseId: first.action.toolUseId, result: "3" },
    conversation: first.conversation,
    actions,
  });
  assert.equal(second.status, "answer");
  assert.equal(second.text, "Há 3 encomendas pendentes.");
  assert.equal(JSON.parse(second.conversation).length, 4);
});

test("rejeita pedidos sem mensagem", async () => {
  await assert.rejects(chat({}), /message/);
});
