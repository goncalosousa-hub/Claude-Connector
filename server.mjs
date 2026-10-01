// Protótipo: serviço REST que liga uma app OutSystems à API do Claude.
//
// A app OutSystems chama POST /v1/chat com a mensagem do utilizador e a lista
// de ações (Server Actions) que o Claude pode pedir para executar. O serviço
// devolve uma resposta de texto ou um pedido de ação; a app executa a ação e
// volta a chamar /v1/chat com o resultado. A conversa viaja como um texto
// opaco ("conversation") para a app não ter de modelar blocos da API.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env.PORT ?? 8787);
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const PROXY_KEY = process.env.PROXY_KEY ?? ""; // segredo partilhado com o OutSystems
const DEFAULT_SYSTEM =
  "És um assistente integrado numa aplicação OutSystems. Responde em português. " +
  "Quando precisares de dados ou quiseres fazer algo na aplicação, usa as ações disponíveis.";

// MOCK=1 responde sem chamar a API (grátis), para montar o lado OutSystems.
const MOCK = process.env.MOCK === "1";
const client = MOCK ? null : new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

// Imita a API: pede a primeira ação disponível e, quando recebe o resultado, responde.
function mockResponse({ messages, tools }) {
  const last = messages.at(-1).content;
  if (Array.isArray(last) && last[0].type === "tool_result") {
    return { stop_reason: "end_turn", content: [{ type: "text", text: `[MOCK] A ação devolveu: ${last[0].content}` }] };
  }
  if (tools?.length) {
    const tool = tools[0];
    const input = Object.fromEntries(Object.keys(tool.input_schema.properties).map((k) => [k, "exemplo"]));
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: `toolu_mock_${Date.now()}`, name: tool.name, input }] };
  }
  return { stop_reason: "end_turn", content: [{ type: "text", text: `[MOCK] Recebi: ${last}` }] };
}

// Converte a lista simples de ações (fácil de montar no OutSystems) em tools.
function toTools(actions = []) {
  return actions.map((a) => {
    const properties = {};
    const required = [];
    for (const p of a.parameters ?? []) {
      properties[p.name] = { type: p.type ?? "string", description: p.description ?? "" };
      if (p.required) required.push(p.name);
    }
    return {
      name: a.name,
      description: a.description ?? "",
      input_schema: { type: "object", properties, required },
    };
  });
}

export async function chat(body) {
  const messages = body.conversation ? JSON.parse(body.conversation) : [];

  if (body.toolResult) {
    const r = body.toolResult;
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: r.toolUseId,
          content: String(r.result ?? ""),
          is_error: Boolean(r.isError),
        },
      ],
    });
  } else if (body.message) {
    messages.push({ role: "user", content: body.message });
  } else {
    throw Object.assign(new Error("Indique 'message' ou 'toolResult'."), { status: 400 });
  }

  const tools = toTools(body.actions);
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: body.system || DEFAULT_SYSTEM,
    messages,
    // Uma ação de cada vez: a app executa-a e devolve o resultado na chamada seguinte.
    ...(tools.length ? { tools, tool_choice: { type: "auto", disable_parallel_tool_use: true } } : {}),
    output_config: { effort: "medium" },
    // Se o modelo recusar por política, a API tenta automaticamente outro modelo.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
  const response = MOCK ? mockResponse(params) : await client.beta.messages.create(params);

  // Guarda a resposta completa (inclui blocos de thinking) para a próxima volta.
  messages.push({ role: "assistant", content: response.content });
  const conversation = JSON.stringify(messages);
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (response.stop_reason === "refusal") {
    return { status: "refused", text, conversation };
  }
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (response.stop_reason === "tool_use" && toolUse) {
    return {
      status: "action_required",
      text,
      action: { toolUseId: toolUse.id, name: toolUse.name, inputJson: JSON.stringify(toolUse.input) },
      conversation,
    };
  }
  return { status: "answer", text, conversation };
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, model: MODEL });
  if (req.method !== "POST" || req.url !== "/v1/chat") return send(res, 404, { error: "Not found" });
  if (PROXY_KEY && req.headers["x-proxy-key"] !== PROXY_KEY) return send(res, 401, { error: "Unauthorized" });

  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    send(res, 200, await chat(JSON.parse(raw || "{}")));
  } catch (err) {
    if (err instanceof SyntaxError) return send(res, 400, { error: "JSON inválido" });
    if (err instanceof Anthropic.APIError) {
      console.error("Erro da API do Claude:", err.status, err.message);
      return send(res, err.status === 429 ? 429 : 502, { error: err.message });
    }
    console.error(err);
    send(res, err.status ?? 500, { error: err.message });
  }
});

// Arranca o servidor só quando o ficheiro é executado diretamente (não nos testes).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`OutSystems ↔ Claude a ouvir em :${PORT} (${MOCK ? "modo MOCK, sem chamar a API" : `modelo ${MODEL}`})`));
}
