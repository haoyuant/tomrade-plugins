import { execFile } from "node:child_process";
import type { AwsCredentials } from "./sigv4.js";

/** Runs the AWS CLI, found on the PATH Tomrade reads from the login shell. */
export const aws = (args: string[], timeout = 20_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile("aws", args, { timeout, windowsHide: true, shell: process.platform === "win32" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|command not found/i.test(stderr);
      reject(new Error(missing ? "the AWS CLI is not installed: install it and run `aws configure` or `aws sso login`, or paste a Bedrock API key" : stderr.trim() || error.message));
    })
  );

/**
 * The credentials the AWS CLI holds for its current profile, SSO and assumed
 * roles included, asked for again five minutes before they expire and at
 * least every fifteen minutes, so a changed profile is picked up.
 */
export function cliCredentials(run = aws): () => Promise<AwsCredentials> {
  let held: { credentials: AwsCredentials; until: number } | null = null;
  let pending: Promise<AwsCredentials> | null = null;
  return async () => {
    if (held && Date.now() < held.until) return held.credentials;
    pending ??= (async () => {
      try {
        const out = JSON.parse(await run(["configure", "export-credentials", "--format", "process"])) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
        if (!out.AccessKeyId || !out.SecretAccessKey) throw new Error("the AWS CLI has no credentials: run `aws configure` or `aws sso login`, or paste a Bedrock API key");
        const credentials = { accessKeyId: out.AccessKeyId, secretAccessKey: out.SecretAccessKey, ...(out.SessionToken ? { sessionToken: out.SessionToken } : {}) };
        const expires = out.Expiration ? Date.parse(out.Expiration) - 5 * 60_000 : Number.POSITIVE_INFINITY;
        held = { credentials, until: Math.min(expires, Date.now() + 15 * 60_000) };
        return credentials;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

/** The region the person works in: the environment's, else the AWS CLI's. */
export async function cliRegion(run = aws): Promise<string | null> {
  const env = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (env) return env;
  return (await run(["configure", "get", "region"], 5_000).catch(() => "")) || null;
}
