import type { NormalizedField } from "../schemas/fields.js";

export interface FlowSummary {
  id?: number | string;
  hash?: string;
  title?: string;
  formInitId?: number | string;
  companyId?: number | string;
  status?: string;
}

export interface RegisterSummary {
  id?: number | string;
  hash?: string;
  title?: string;
  formId?: number | string;
  companyId?: number | string;
  status?: string;
}

/** Uma entrada (linha) de um cadastro, já normalizada e agnóstica à engine (v1/v2). */
export interface RegisterEntry {
  /** id_form_answer da entrada. */
  id?: number | string;
  /** Título/rótulo da entrada, quando o cadastro define um campo de título. */
  title?: string;
  /** Mapa rótulo-humano-do-campo → valor textual (multi-valor vira array). */
  fields: Record<string, unknown>;
}

/** Resultado do smart reader de cadastros: entradas normalizadas + qual engine rodou. */
export interface RegisterEntriesResult {
  raw: unknown;
  /** Engine efetivamente usada para ler: `v2` (paginado) ou `v1` (legado). */
  engine: FlowQueryEngine;
  entries: RegisterEntry[];
  pageInfo: FlowQueryPageInfo;
  executionStats?: FlowQueryExecutionStats;
}

export interface RegisterEngineStatus {
  raw: unknown;
  registerId?: number | string;
  useV2: boolean;
  useQueryV2?: string;
  isLargeData?: string;
}

export interface CardSummary {
  cardId?: number | string;
  id_card?: number | string;
  title?: string;
  flowId?: number | string;
  flow_id?: number | string;
  flowName?: string;
  flowHash?: string;
  companyId?: number | string;
  currentStepId?: number | string;
  step_id?: number | string;
  stepName?: string;
  dueDate?: string;
  createdAt?: string;
  responsibleUserId?: number | string;
  responsibleName?: string;
  statusDue?: number | string;
  fieldValues?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  archived?: boolean;
  complete?: boolean;
}

export interface FlowViewSortItem {
  field?: number | string;
  order?: string;
}

export interface FlowViewFilterSummary {
  columnsCount?: number;
  filtersCount?: number;
  sort?: FlowViewSortItem[];
  searchText?: string;
  searchFieldScope?: string;
}

export interface FlowViewSummary {
  id?: number | string;
  name?: string;
  icon?: string;
  color?: string;
  isPublic?: boolean;
  isFavorited?: boolean;
  filter?: FlowViewFilterSummary;
  /** Schema JSON parseado — presente só quando explicitamente pedido. */
  schema?: unknown;
}

export interface FlowQueryPageInfo {
  hasMore?: boolean;
  nextCursor?: string;
}

export interface FlowQueryExecutionStats {
  plan?: string;
  cached?: boolean;
  pageSize?: number;
  durationMs?: number;
  totalCount?: number;
  warmupCount?: number;
  snapshotFallbackUsed?: boolean;
  [key: string]: unknown;
}

export type FlowQueryEngine = "v1" | "v2";

export interface NotificationSummary {
  id?: number | string;
  title?: string;
  description?: string;
  type?: string;
  link?: string;
  cardId?: number | string;
  cardTitle?: string;
  flowId?: number | string;
  flowName?: string;
  currentStepId?: number | string;
  stepName?: string;
  responsibleUserId?: number | string;
  responsibleName?: string;
  commentId?: number | string;
  commentText?: string;
  commentAuthorId?: number | string;
  commentAuthorName?: string;
  archived?: boolean;
  read?: boolean;
  createdAt?: string;
}

export interface FieldSummaryItem {
  id?: number | string;
  name: string;
  title?: string;
  description?: string;
  type: string;
  expectedFormat?: string;
  required: boolean;
  formId?: number | string;
}

export interface FieldsSummary {
  total: number;
  requiredCount: number;
  groupedByFormId: Record<string, number>;
  items: FieldSummaryItem[];
}

export interface TemplateContext {
  kind: "flow" | "register" | "flow-step-move";
  flowId?: number | string;
  registerId?: number | string;
  formId?: number | string;
  fromStepId?: number | string;
  toStepId?: number | string;
}

export interface ValuesTemplateResult {
  context: TemplateContext;
  requiredFields: FieldSummaryItem[];
  optionalFields: FieldSummaryItem[];
  payloadSkeleton: Record<string, unknown>;
  flowSummary?: FlowSummary;
  registerSummary?: RegisterSummary;
  fieldsSummary?: FieldsSummary;
}

export interface ValidationIssue {
  code:
    | "UNKNOWN_FIELD"
    | "MISSING_REQUIRED"
    | "INVALID_TYPE"
    | "INVALID_OPTION"
    | "FIELD_OUT_OF_FORM"
    | "UNKNOWN_FIELD_TYPE";
  fieldName: string;
  fieldTitle?: string;
  message: string;
  expected?: string;
  receivedType?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  normalizedValues: Record<string, unknown>;
}

export interface FieldSetWithRaw {
  raw: unknown;
  fields: NormalizedField[];
  summary: FieldsSummary;
}
