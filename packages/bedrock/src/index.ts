import { definePlugin } from "@tomradex/plugin-sdk";
import { DEFAULT_REGION, address, listModels, media, runtime, usable } from "./bedrock.js";
import { cliCredentials, cliRegion } from "./credentials.js";
import { BedrockModel } from "./model.js";

/** Claude Sonnet through the global profile, else the newest Claude, then Nova. */
const PREFER = [/^global\.anthropic\.claude-sonnet/, /^[a-z-]+\.anthropic\.claude-sonnet/, /anthropic\.claude-sonnet/, /anthropic\.claude/, /amazon\.nova/];

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    const fallback = runtime((await cliRegion()) ?? DEFAULT_REGION);
    const credentials = cliCredentials();
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "Amazon Bedrock", zh: "Amazon Bedrock" },
      // the AWS CLI's credentials stand in for a key
      keyRequired: false,
      baseURL: { default: fallback },
      presets: [
        {
          id: "bedrock",
          title: "Amazon Bedrock",
          model: "global.anthropic.claude-sonnet-5-5",
          prefer: PREFER,
          local: true,
          hint: { en: "With the AWS CLI's credentials (aws configure or aws sso login); no key to paste", zh: "使用 AWS CLI 的凭证（aws configure 或 aws sso login），无需粘贴 Key" }
        },
        {
          id: "bedrock-key",
          title: "Amazon Bedrock (API key)",
          model: "global.anthropic.claude-sonnet-5-5",
          prefer: PREFER,
          keyPage: "https://console.aws.amazon.com/bedrock/home#/api-keys",
          env: "AWS_BEARER_TOKEN_BEDROCK",
          keyShapes: [/^bedrock-api-key-/, /^ABSK/],
          hint: { en: "A Bedrock API key; it works only in the region it was made in", zh: "Bedrock API Key，只能在创建它的区域使用" }
        }
      ],
      list: (endpoint, signal) => listModels(address(endpoint.baseURL, fallback), { apiKey: endpoint.apiKey, credentials }, signal),
      usable,
      capabilities: media,
      build: (profile) =>
        new BedrockModel({
          baseURL: address(profile.baseURL, fallback),
          apiKey: profile.apiKey,
          credentials,
          model: profile.model,
          inputModalities: profile.inputModalities,
          provider: ctx.namespace
        })
    });
  }
});
