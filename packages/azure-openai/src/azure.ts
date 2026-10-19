import type { ModelPresetSpec } from "@tomradex/plugin-sdk";

/** Profiles store it. The manifest's namespace, `azure`, lets it carry the dash. */
export const PROVIDER = "azure-openai";

/** The hosts a resource's API lives on: Azure OpenAI's own, a Foundry resource's, and older Cognitive Services ones. */
const AZURE = /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i;

/**
 * What a person pastes, completed to the resource's GA v1 API (no `api-version`):
 * a resource name (`myres`) or any address on an Azure host
 * (`https://myres.openai.azure.com`, `…/openai`, `…/openai/v1/?api-version=…`)
 * becomes `https://{host}/openai/v1`. Another host, such as a gateway, is used as typed.
 */
export function address(input: string | undefined): string {
  const text = (input ?? "").trim();
  if (!text) return "";
  if (/^[a-z0-9][a-z0-9-]*$/i.test(text)) return `https://${text.toLowerCase()}.openai.azure.com/openai/v1`;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return text;
  }
  return AZURE.test(url.hostname) ? `https://${url.host}/openai/v1` : url.origin + url.pathname.replace(/\/+$/, "");
}

/** Microsoft's REST docs send the key in `api-key`; the v1 API also takes it as a bearer token. */
export const auth = (apiKey: string): Record<string, string> => ({ "api-key": apiKey });

/** Why the listing fails without an address; plain English, as other providers' details are. */
export const NO_ADDRESS =
  "No address yet: put the Azure resource's endpoint (Azure portal → the resource → Keys and Endpoint, such as https://myres.openai.azure.com) or its name in the profile's address";

/**
 * The one preset, on the resource `AZURE_OPENAI_ENDPOINT` names when it is
 * exported. Its key is offered only then: without an address it cannot connect.
 */
export function presets(endpoint: string): ModelPresetSpec[] {
  return [
    {
      id: PROVIDER,
      title: "Azure OpenAI",
      baseURL: endpoint,
      // a deployment's name, which only the person knows; a listed model named like one is the guess
      model: "",
      prefer: [/^gpt-5/, /^gpt-4\.1/, /^gpt-4o/, /^o\d/],
      // Foundry shows the key, the endpoint and the deployments' names on one resource's page
      keyPage: "https://ai.azure.com",
      ...(endpoint ? { env: "AZURE_OPENAI_API_KEY" } : {}),
      hint: { en: "Microsoft Azure; the address is your resource's endpoint, the model a deployment's name", zh: "微软 Azure；地址填资源的终结点，模型填部署名称" }
    }
  ];
}

/** What the listing has besides chat models: embeddings, speech, images, video, moderation and the completions-only ones. */
const NOT_CHAT = /embed|tts|whisper|transcribe|dall-e|gpt-image|sora|moderation|realtime|davinci|babbage/i;

/** The chat models of the listing, which is the models the resource can deploy, not its deployments. */
export const usable = (listed: string[]): string[] => listed.filter((id) => !NOT_CHAT.test(id));

/** Azure's reasoning models take only `max_completion_tokens`, and the others take it too. */
export function shape(json: Record<string, unknown>): Record<string, unknown> {
  if (!("max_tokens" in json)) return json;
  const { max_tokens: tokens, ...out } = json;
  return { ...out, max_completion_tokens: tokens };
}
