# Amazon Bedrock

The models on Amazon Bedrock as a model provider in Tomrade: Claude, Amazon Nova, and the open models Bedrock serves (DeepSeek, Qwen, Mistral, gpt-oss, Llama…).

- **Set up.** In Settings → Assistant (or the first-run setup):
  - **Amazon Bedrock** uses the credentials the AWS CLI already holds (`aws configure`, or `aws sso login` for SSO and assumed roles), so there is no key to paste.
  - **Amazon Bedrock (API key)** takes a Bedrock API key from the Bedrock console. A key exported as `AWS_BEARER_TOKEN_BEDROCK` is offered without pasting.
  - Tomrade checks access and starts on Claude Sonnet through its global inference profile.
- **Region.** Profiles talk to `bedrock-runtime` in the region from `AWS_REGION`, `AWS_DEFAULT_REGION` or `aws configure get region` (us-east-1 when none is set). Type another region, such as `eu-central-1`, in the profile's address to use it. An API key works only in the region it was made in.
- **Models.** The picker lists the region's text models you can call on demand. It also lists the system inference profiles (`global.`, `us.`, `eu.`, `apac.` …), the only way to reach models Bedrock serves cross-region, such as Claude 5.x. Claude and Nova read pictures and PDFs; other models read pictures when Bedrock says they do.
- **Thinking.** Claude thinks adaptively on Bedrock. The assistant's effort sets Claude's own effort on the models that take one. Claude's signed reasoning goes back with the tool calls it led to, as Bedrock requires.
- **Caching.** The system prompt is cached on Claude and Nova.
- **Web search.** Bedrock's models do not search the web themselves, so Tomrade's web search plugins cover it.

The plugin talks to Bedrock's Converse API itself (ConverseStream, signed with AWS Signature Version 4 when it uses the CLI's credentials). It reaches `amazonaws.com` only. It runs the AWS CLI for nothing but `aws configure export-credentials` and `aws configure get region`.

`tests/` runs the provider against a fake host and stand-ins for Bedrock: SigV4 against AWS's published test vectors, the event stream reader, the Converse mapping, the listing and both ways in. `tests/live.test.ts` runs a tool loop on the real Bedrock with `BEDROCK_LIVE=1 pnpm test packages/bedrock`; AWS bills it. `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for Bedrock.
