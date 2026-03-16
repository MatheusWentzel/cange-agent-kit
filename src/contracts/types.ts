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

export interface CardSummary {
  cardId?: number | string;
  title?: string;
  flowId?: number | string;
  flowName?: string;
  flowHash?: string;
  companyId?: number | string;
  currentStepId?: number | string;
  stepName?: string;
  dueDate?: string;
  createdAt?: string;
  responsibleUserId?: number | string;
  responsibleName?: string;
  statusDue?: number | string;
  archived?: boolean;
  complete?: boolean;
}

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
  kind: "flow" | "register";
  flowId?: number | string;
  registerId?: number | string;
  formId?: number | string;
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
    | "FIELD_OUT_OF_FORM"
    | "UNKNOWN_FIELD_TYPE";
  fieldName: string;
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
