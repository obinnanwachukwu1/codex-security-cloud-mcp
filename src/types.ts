export type JsonObject = Record<string, unknown>;

export type FindingSection = "open" | "closed";

export type OpenFindingStatus = "new" | "triaged" | "in_progress";
export type ClosedFindingStatus = "fixed" | "wontfix" | "duplicate" | "false_positive";
export type FindingStatus = OpenFindingStatus | ClosedFindingStatus;

export type Criticality = "critical" | "high" | "medium" | "low" | "informational";

export type FindingSort = "sev_desc" | "date_desc" | "commit_date_desc";

export type GeneratedPatch = {
  diff?: string;
  baseCommitSha?: string;
  filesModified?: number;
  linesAdded?: number;
  linesRemoved?: number;
  commitMessage?: string;
};

export type NormalizedFinding = {
  findingId?: string;
  version?: number;
  repoUrl?: string;
  status?: string;
  criticality?: string;
  title?: string;
  summary?: string;
  description?: string;
  resolutionReason?: string;
  criticalityReason?: string;
  relevantLines?: unknown[];
  validationReport?: string;
  fixCheckReport?: string;
  attackPath?: unknown;
  generatedPatch?: GeneratedPatch;
  sitePr?: {
    number?: number;
    url?: string;
    state?: string;
    title?: string;
  };
};
