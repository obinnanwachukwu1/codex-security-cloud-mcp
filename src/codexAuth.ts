import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type CodexAuthJson = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

export type CodexAuth = {
  accessToken: string;
  accountId: string;
};

export async function readCodexAuth(): Promise<CodexAuth> {
  const authPath = join(homedir(), ".codex", "auth.json");
  let parsed: CodexAuthJson;
  try {
    parsed = JSON.parse(await readFile(authPath, "utf8")) as CodexAuthJson;
  } catch (error) {
    throw new Error(
      `Unable to read Codex auth at ${authPath}. Sign in with Codex first, then retry. ${errorMessage(error)}`
    );
  }

  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`Codex auth at ${authPath} does not contain an access token. Sign in with Codex first.`);
  }

  const expiresAt = jwtExpiresAt(accessToken);
  if (expiresAt && Date.now() >= expiresAt) {
    throw new Error("Codex access token is expired. Refresh Codex auth, then retry.");
  }

  const accountId = parsed.tokens?.account_id ?? accountIdFromToken(accessToken) ?? "";
  return { accessToken, accountId };
}

function accountIdFromToken(token: string): string | null {
  const claims = jwtPayload(token);
  const auth = claims?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") return null;
  const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
  return typeof accountId === "string" ? accountId : null;
}

function jwtExpiresAt(token: string): number | null {
  const claims = jwtPayload(token);
  const exp = typeof claims?.exp === "number" ? claims.exp : undefined;
  return exp ? exp * 1000 : null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
