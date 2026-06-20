#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AardvarkClient } from "./aardvarkClient.js";
import { applyGeneratedPatch } from "./git.js";
import {
  normalizeFinding,
  normalizeFindingState,
  normalizeListResponse,
  normalizeMetadata,
  normalizeSitePrResponse,
} from "./normalize.js";

const server = new McpServer({
  name: "codex-security-cloud-mcp",
  title: "Codex Security Cloud MCP",
  version: "0.1.1",
});

const client = new AardvarkClient();

const criticalitySchema = z.enum(["critical", "high", "medium", "low", "informational"]);
const sortSchema = z.enum(["sev_desc", "date_desc", "commit_date_desc"]);
const closedStatusSchema = z.enum(["fixed", "wontfix", "duplicate", "false_positive"]);
const findingIdSchema = z
  .string()
  .min(1)
  .describe("Action-safe finding id returned by list_findings or get_finding.");

server.registerTool(
  "list_security_metadata",
  {
    title: "List Security Metadata",
    description: "List accessible Codex Security Cloud repositories and author filters.",
    inputSchema: z.object({
      forceRefreshRepos: z.boolean().optional(),
      repo: z.string().url().optional(),
    }),
  },
  async (args) =>
    toolResult(normalizeMetadata(await client.listSecurityMetadata(args)))
);

server.registerTool(
  "list_findings",
  {
    title: "List Findings",
    description: "List Codex Security Cloud findings in the open or closed section with filters.",
    inputSchema: z.object({
      section: z.enum(["open", "closed"]).default("open").optional(),
      repos: z.array(z.string().url()).optional(),
      criticality: criticalitySchema.optional(),
      hasPatch: z.boolean().optional(),
      author: z.string().optional(),
      sort: sortSchema.optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
  },
  async (args) => toolResult(normalizeListResponse(await client.listFindings(args)))
);

server.registerTool(
  "get_finding",
  {
    title: "Get Finding",
    description:
      "Fetch one Codex Security Cloud finding. Compact by default: includes summary, relevant-line locations, generated patch metadata, and site PR metadata. Do not request evidence or patch diff just to check whether a generated patch exists.",
    inputSchema: z.object({
      findingId: findingIdSchema,
      includePatchDiff: z
        .boolean()
        .optional()
        .describe(
          "Default false. Heavy unified diff; only set true when the user needs to inspect or manually repair the generated patch. apply_generated_patch does not need this."
        ),
      includeEvidence: z
        .boolean()
        .optional()
        .describe(
          "Default false. Heavy evidence payload; includes source snippets, validation/fix reports, and attack-path details. Only set true when the user explicitly asks for evidence or validation detail."
        ),
      includeDescription: z
        .boolean()
        .optional()
        .describe("Default false. Full raw finding description; the compact summary is returned by default."),
    }),
  },
  async (args) =>
    toolResult(
      normalizeFinding(await client.getFinding(args.findingId), {
        includePatchDiff: args.includePatchDiff,
        includeEvidence: args.includeEvidence,
        includeDescription: args.includeDescription,
      })
    )
);

server.registerTool(
  "close_finding",
  {
    title: "Close Finding",
    description: "Close a Codex Security Cloud finding as fixed, won't fix, duplicate, or false positive.",
    inputSchema: z.object({
      findingId: findingIdSchema,
      version: z.number().int().nonnegative(),
      status: closedStatusSchema,
      reason: z.string().min(1),
    }),
  },
  async (args) => toolResult(normalizeFindingState(await client.closeFinding(args)))
);

server.registerTool(
  "reopen_finding",
  {
    title: "Reopen Finding",
    description: "Reopen a closed Codex Security Cloud finding.",
    inputSchema: z.object({
      findingId: findingIdSchema,
      version: z.number().int().nonnegative(),
    }),
  },
  async (args) => toolResult(normalizeFindingState(await client.reopenFinding(args)))
);

server.registerTool(
  "request_site_pr",
  {
    title: "Request Site PR",
    description: "Ask Codex Security Cloud to generate its site-side patch/PR workflow for a finding.",
    inputSchema: z.object({
      findingId: findingIdSchema,
    }),
  },
  async (args) => toolResult(await requestSitePrWithResult(args.findingId))
);

server.registerTool(
  "apply_generated_patch",
  {
    title: "Apply Generated Patch",
    description:
      "Apply an already-generated Codex Security Cloud patch to a local git repo, commit it, and optionally close the finding as fixed.",
    inputSchema: z.object({
      findingId: findingIdSchema,
      repoPath: z.string().min(1).describe("Local git repository path where the patch should be applied."),
      autoClose: z
        .boolean()
        .optional()
        .describe(
          "Default false. When true, close the Codex Security Cloud finding as fixed after a clean apply and successful local commit."
        ),
    }),
  },
  async (args) =>
    toolResult(
      await applyGeneratedPatch({
        client,
        findingId: args.findingId,
        repoPath: args.repoPath,
        autoClose: args.autoClose,
      })
    )
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function requestSitePrWithResult(findingId: string) {
  const response = normalizeSitePrResponse(await client.requestSitePr(findingId));
  if (hasSitePr(response)) return response;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await delay(1000);
    const finding = normalizeSitePrResponse(await client.getFinding(findingId));
    if (hasSitePr(finding)) return { requestStatus: requestStatus(response), ...finding };
  }

  return {
    ...response,
    findingId,
    nextStep: "The site accepted the PR request, but no PR metadata was visible after polling. An agent can refetch the finding or inspect GitHub.",
  };
}

function hasSitePr(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "sitePr" in value && (value as { sitePr?: unknown }).sitePr);
}

function requestStatus(value: unknown): string | undefined {
  return value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string"
    ? (value as { status: string }).status
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("uncaughtException", (error) => {
  console.error(error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
  process.exit(1);
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
