// apps/api/src/openai.ts
type Json = Record<string, any>;

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function llmJson<T extends Json>(args: {
  system: string;
  user: string;
  schemaHint?: string; // optional: describe expected JSON keys
  model?: string;
  temperature?: number;
}): Promise<T> {
  const apiKey = mustEnv("OPENAI_API_KEY");
  const model = args.model || "gpt-4o-mini";
  const temperature = args.temperature ?? 0.2;

  const schemaBlock = args.schemaHint
    ? `\n\nReturn ONLY valid JSON. Schema:\n${args.schemaHint}\n`
    : `\n\nReturn ONLY valid JSON.\n`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: args.system + schemaBlock },
        { role: "user", content: args.user },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 400)}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI: missing message content");

  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error(`OpenAI content not JSON: ${String(content).slice(0, 400)}`);
  }
}
