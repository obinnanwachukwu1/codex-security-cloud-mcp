import { randomUUID } from "node:crypto";
import { readCodexAuth } from "./codexAuth.js";
import type { ClosedFindingStatus, Criticality, FindingSection, FindingSort, JsonObject } from "./types.js";

const CHATGPT_BASE_URL = "https://chatgpt.com";
const AARDVARK_BASE_PATH = "/backend-api/aardvark";
const OPEN_STATUSES = "new,triaged,in_progress";
const CLOSED_STATUSES = "fixed,wontfix,duplicate,false_positive";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  route: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  referer?: string;
};

export type ListFindingsInput = {
  section?: FindingSection;
  repos?: string[];
  criticality?: Criticality;
  hasPatch?: boolean;
  author?: string;
  sort?: FindingSort;
  cursor?: string;
  limit?: number;
};

export class AardvarkClient {
  async listSecurityMetadata(input: { forceRefreshRepos?: boolean; repo?: string }): Promise<JsonObject> {
    const [repos, authors] = await Promise.all([
      this.requestJson({
        route: "/backend-api/aardvark/scan-findings/list-accessible-repos",
        path: "/backend-api/aardvark/scan-findings/list-accessible-repos",
        query: { force_refresh: input.forceRefreshRepos ? "true" : "false" },
      }),
      this.requestJson({
        route: "/backend-api/aardvark/scan-findings/list-authors",
        path: "/backend-api/aardvark/scan-findings/list-authors",
        query: { limit: 100, repo: input.repo },
      }),
    ]);

    return { repos, authors };
  }

  async listFindings(input: ListFindingsInput): Promise<JsonObject> {
    const section = input.section ?? "open";
    const statuses = section === "closed" ? CLOSED_STATUSES : OPEN_STATUSES;
    return this.requestJson({
      route: "/backend-api/aardvark/scan-findings",
      path: "/backend-api/aardvark/scan-findings",
      query: {
        limit: input.limit ?? 20,
        cursor: input.cursor ?? "0",
        repo: input.repos && input.repos.length > 0 ? input.repos.join(",") : undefined,
        sort: input.sort,
        status: statuses,
        criticality: input.criticality,
        has_patch: input.hasPatch ? "true" : undefined,
        author: input.author,
      },
    });
  }

  async getFinding(findingId: string): Promise<JsonObject> {
    const endpointId = endpointFindingId(findingId);
    return this.requestJson({
      route: "/backend-api/aardvark/scan-findings/{id}",
      path: `/backend-api/aardvark/scan-findings/${encodeURIComponent(endpointId)}`,
      referer: `${CHATGPT_BASE_URL}/codex/cloud/security/findings/${encodeURIComponent(endpointId)}`,
    });
  }

  async closeFinding(input: {
    findingId: string;
    version: number;
    status: ClosedFindingStatus;
    reason: string;
  }): Promise<JsonObject> {
    const endpointId = endpointFindingId(input.findingId);
    return this.requestJson({
      method: "PATCH",
      route: "/backend-api/aardvark/scan-findings/{id}",
      path: `/backend-api/aardvark/scan-findings/${encodeURIComponent(endpointId)}`,
      body: {
        version: input.version,
        status: input.status,
        resolution_reason: input.reason,
      },
    });
  }

  async reopenFinding(input: { findingId: string; version: number }): Promise<JsonObject> {
    const endpointId = endpointFindingId(input.findingId);
    return this.requestJson({
      method: "PATCH",
      route: "/backend-api/aardvark/scan-findings/{id}",
      path: `/backend-api/aardvark/scan-findings/${encodeURIComponent(endpointId)}`,
      body: {
        version: input.version,
        status: "new",
      },
    });
  }

  async requestSitePr(findingId: string): Promise<JsonObject> {
    const endpointId = endpointFindingId(findingId);
    return this.requestJson({
      method: "POST",
      route: "/backend-api/aardvark/scan-findings/{id}/pr",
      path: `/backend-api/aardvark/scan-findings/${encodeURIComponent(endpointId)}/pr`,
      body: {},
    });
  }

  private async requestJson(options: RequestOptions): Promise<JsonObject> {
    const response = await fetch(this.url(options), {
      method: options.method ?? "GET",
      headers: await this.headers(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        [
          `Codex Security Cloud request failed: ${response.status} ${response.statusText}`,
          `Path: ${options.path}`,
          `Response: ${text.slice(0, 500).replace(/\s+/g, " ")}`,
        ].join("\n")
      );
    }

    try {
      return JSON.parse(text) as JsonObject;
    } catch (error) {
      throw new Error(`Expected JSON from ${options.path}, got ${text.slice(0, 200)}: ${errorMessage(error)}`);
    }
  }

  private url(options: RequestOptions): string {
    const url = new URL(`${CHATGPT_BASE_URL}${options.path.startsWith(AARDVARK_BASE_PATH) ? "" : AARDVARK_BASE_PATH}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async headers(options: RequestOptions): Promise<Headers> {
    const auth = await readCodexAuth();
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      originator: "codex_cli_rs",
      session_id: `codex-security-cloud-${randomUUID()}`,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      referer: options.referer ?? `${CHATGPT_BASE_URL}/codex/cloud/security`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "x-openai-target-route": options.route,
      "x-openai-target-path": options.path,
    });
    if (auth.accountId) headers.set("chatgpt-account-id", auth.accountId);
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      headers.set("origin", CHATGPT_BASE_URL);
    }
    return headers;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endpointFindingId(findingId: string): string {
  if (findingId.includes(":")) {
    throw new Error(
      [
        "Use the `findingId` returned by list_findings or get_finding.",
        "Codex Security Cloud rejects long composite backend ids for finding detail/action URLs.",
      ].join(" ")
    );
  }
  return findingId;
}
