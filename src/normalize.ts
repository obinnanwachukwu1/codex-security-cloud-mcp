import type { GeneratedPatch, JsonObject, NormalizedFinding } from "./types.js";

type NormalizeFindingOptions = {
  includePatchDiff?: boolean;
  includeEvidence?: boolean;
  includeDescription?: boolean;
};

export function normalizeListResponse(raw: JsonObject): JsonObject {
  const items = asArray(raw.items).map((item) => normalizeFindingSummary(asObject(item)));
  return {
    total: asNumber(raw.total),
    nextCursor: asString(raw.next_cursor),
    items,
  };
}

export function normalizeMetadata(raw: JsonObject): JsonObject {
  return {
    repos: asArray(asObject(raw.repos).items).map((repo) => {
      const object = asObject(repo);
      return asString(object.canonical_url);
    }).filter(isString),
    authors: asArray(asObject(raw.authors).items).map((author) => {
      const object = asObject(author);
      return {
        name: asString(object.name),
        email: asString(object.email),
      };
    }),
  };
}

export function normalizeFinding(raw: JsonObject, options: NormalizeFindingOptions = {}): NormalizedFinding {
  const commitAnalysis = asObject(raw.commit_analysis);
  const latestTask = asObject(asObject(raw.proposed_patch).latest_task);
  const turn = asObject(asObject(latestTask.codex_task_turn).turn);
  const pullRequestData = asObject(turn.pull_request_data);
  const generatedPatch = extractGeneratedPatch(raw);
  const description = asString(commitAnalysis.description);
  const resolutionReason = nullableString(raw.resolution_reason);
  const criticalityReason = nullableString(raw.criticality_reason);

  const finding: NormalizedFinding = {
    findingId: actionFindingId(raw),
    version: asNumber(raw.version),
    repoUrl: asString(raw.repo_url),
    status: asString(raw.status),
    criticality: asString(raw.criticality),
    title: asString(commitAnalysis.title),
    summary: extractDescriptionSummary(description),
    relevantLines: normalizeRelevantLines(asArray(commitAnalysis.relevant_lines), options),
    generatedPatch: generatedPatch ? normalizeGeneratedPatch(generatedPatch, options) : undefined,
    sitePr:
      Object.keys(pullRequestData).length === 0
        ? undefined
        : {
            number: asNumber(pullRequestData.number),
            url: asString(pullRequestData.url),
            state: asString(pullRequestData.state),
            title: asString(pullRequestData.title),
          },
  };

  if (options.includeDescription) finding.description = description;
  if (resolutionReason) finding.resolutionReason = resolutionReason;
  if (criticalityReason) finding.criticalityReason = criticalityReason;
  if (options.includeEvidence) {
    finding.validationReport = asString(commitAnalysis.validation_report) ?? asString(commitAnalysis.validation_str);
    finding.fixCheckReport = asString(commitAnalysis.last_fix_check_report);
    finding.attackPath = commitAnalysis.attack_path_analysis;
  }

  return finding;
}

export function normalizeFindingState(raw: JsonObject): JsonObject {
  const commitAnalysis = asObject(raw.commit_analysis);
  const state: JsonObject = {
    findingId: actionFindingId(raw),
    version: asNumber(raw.version),
    repoUrl: asString(raw.repo_url),
    status: asString(raw.status),
    criticality: asString(raw.criticality),
    title: asString(commitAnalysis.title),
    updatedAt: asString(raw.updated_at),
  };
  const resolutionReason = nullableString(raw.resolution_reason);
  if (resolutionReason) state.resolutionReason = resolutionReason;
  return state;
}

export function normalizeSitePrResponse(raw: JsonObject): JsonObject {
  const state = normalizeFindingState(raw);
  const sitePr = normalizeFinding(raw).sitePr;
  if (Object.values(state).some((value) => value !== undefined) || sitePr) {
    return { ...state, sitePr };
  }
  return raw;
}

export function extractGeneratedPatch(raw: JsonObject): GeneratedPatch | undefined {
  const outputItems = asArray(
    asObject(asObject(asObject(asObject(raw.proposed_patch).latest_task).codex_task_turn).turn).output_items
  );
  for (const item of outputItems) {
    const object = asObject(item);
    if (object.type !== "pr") continue;
    const outputDiff = asObject(object.output_diff);
    const diff = asString(outputDiff.diff);
    if (!diff) continue;
    return {
      diff,
      baseCommitSha: asString(outputDiff.base_commit_sha),
      filesModified: asNumber(outputDiff.files_modified),
      linesAdded: asNumber(outputDiff.lines_added),
      linesRemoved: asNumber(outputDiff.lines_removed),
      commitMessage: asString(outputDiff.commit_message),
    };
  }
  return undefined;
}

function normalizeGeneratedPatch(patch: GeneratedPatch, options: NormalizeFindingOptions): GeneratedPatch {
  return {
    ...(options.includePatchDiff ? { diff: patch.diff } : {}),
    baseCommitSha: patch.baseCommitSha,
    filesModified: patch.filesModified,
    linesAdded: patch.linesAdded,
    linesRemoved: patch.linesRemoved,
    commitMessage: patch.commitMessage,
  };
}

export function filesTouchedByDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;
    const before = match[1];
    const after = match[2];
    if (after && after !== "/dev/null") files.add(after);
    else if (before && before !== "/dev/null") files.add(before);
  }
  return [...files].sort();
}

function normalizeFindingSummary(raw: JsonObject): JsonObject {
  const commitAnalysis = asObject(raw.commit_analysis);
  const generatedPatchState = generatedPatchStateFromListItem(raw);
  return {
    findingId: actionFindingId(raw),
    version: asNumber(raw.version),
    repoUrl: asString(raw.repo_url),
    status: asString(raw.status),
    criticality: asString(raw.criticality),
    title: asString(commitAnalysis.title),
    commitHash: asString(commitAnalysis.commit_hash),
    stillExistsInHead: asString(commitAnalysis.still_exists_in_head),
    patchState: generatedPatchState,
    updatedAt: asString(raw.updated_at),
  };
}

function normalizeRelevantLines(lines: unknown[], options: NormalizeFindingOptions): JsonObject[] {
  return lines.map((line) => {
    const object = asObject(line);
    return {
      path: asString(object.path) ?? asString(object.file_path),
      startLine: asNumber(object.start_line_number),
      endLine: asNumber(object.end_line_number),
      comment: asString(object.comment),
      ...(options.includeEvidence ? { content: asString(object.content) } : {}),
    };
  });
}

function extractDescriptionSummary(description: string | undefined): string | undefined {
  const normalized = normalizeWhitespace(extractExplicitSummarySection(description) ?? firstParagraph(description));
  return truncateSummary(normalized);
}

function extractExplicitSummarySection(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const lines = description.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const inline = line.match(/^\s*(?:#{1,6}\s*)?(summary|overview)\s*:\s*(.+)$/i);
    const heading = line.match(/^\s*(?:#{1,6}\s*)?(summary|overview)\s*:?\s*$/i);
    if (!inline && !heading) continue;

    const sectionLines: string[] = [];
    if (inline?.[2]) sectionLines.push(inline[2]);
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next] ?? "";
      if (isSectionBoundary(nextLine)) break;
      sectionLines.push(nextLine);
    }

    const section = sectionLines.join("\n").trim();
    if (section) return section;
  }
  return undefined;
}

function firstParagraph(description: string | undefined): string | undefined {
  return description?.replace(/\r\n/g, "\n").split(/\n\s*\n/)[0]?.trim();
}

function isSectionBoundary(line: string): boolean {
  return (
    /^\s*#{1,6}\s+\S+/.test(line) ||
    /^\s*(impact|details?|evidence|recommendation|remediation|fix|mitigation|attack path|risk)\s*:/i.test(line)
  );
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

function truncateSummary(value: string | undefined): string | undefined {
  const maxLength = 520;
  if (!value || value.length <= maxLength) return value;
  const prefix = value.slice(0, maxLength + 1);
  const sentenceEndMatches = [...prefix.matchAll(/[.!?](?=\s+[A-Z0-9`@])/g)];
  const sentenceEnd = sentenceEndMatches.at(-1)?.index;
  if (sentenceEnd !== undefined && sentenceEnd >= 280) return `${value.slice(0, sentenceEnd + 1).trim()}...`;
  const wordBoundary = value.lastIndexOf(" ", maxLength);
  return `${value.slice(0, wordBoundary > 280 ? wordBoundary : maxLength).trim()}...`;
}

function actionFindingId(raw: JsonObject): string | undefined {
  return asString(raw.hid) ?? asString(raw.id);
}

function generatedPatchStateFromListItem(raw: JsonObject): "available" | "none" | "unknown" {
  if (extractGeneratedPatch(raw)) return "available";
  return raw.proposed_patch === null || raw.proposed_patch === undefined ? "unknown" : "none";
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
