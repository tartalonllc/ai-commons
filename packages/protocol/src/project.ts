import Type, { type Static } from 'typebox';
import { JsonSchemaDocument, ProjectId, SemVer, Timestamp } from './common.js';
import { LIMITS } from './limits.js';

export const ProjectCategory = Type.Union([
  Type.Literal('science'),
  Type.Literal('medicine'),
  Type.Literal('astronomy'),
  Type.Literal('climate'),
  Type.Literal('open_source'),
  Type.Literal('history'),
  Type.Literal('education'),
]);
export type ProjectCategory = Static<typeof ProjectCategory>;

export const Capability = Type.Literal('text_generation');
export type Capability = Static<typeof Capability>;

export const ValidationMode = Type.Union([
  Type.Literal('schema'),
  Type.Literal('deterministic'),
  Type.Literal('consensus'),
]);
export type ValidationMode = Static<typeof ValidationMode>;

export const ProjectStatus = Type.Union([
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('archived'),
]);
export type ProjectStatus = Static<typeof ProjectStatus>;

/**
 * Prompts are declarative templates, never code: workers render `{{field}}`
 * placeholders from the task payload themselves, so volunteers can inspect
 * exactly what will be sent to their provider.
 */
export const PromptTemplate = Type.Object(
  {
    system: Type.String({ maxLength: LIMITS.maxPromptTemplateChars }),
    user: Type.String({ minLength: 1, maxLength: LIMITS.maxPromptTemplateChars }),
  },
  { additionalProperties: false },
);
export type PromptTemplate = Static<typeof PromptTemplate>;

export const ProjectRequirements = Type.Object(
  {
    capability: Capability,
    minimum_context_window: Type.Integer({ minimum: 512, maximum: 2_000_000 }),
    max_output_tokens: Type.Integer({ minimum: 1, maximum: LIMITS.maxOutputTokens }),
    local_models_only: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ProjectRequirements = Static<typeof ProjectRequirements>;

export const ProjectValidation = Type.Object(
  {
    mode: ValidationMode,
    replication_factor: Type.Integer({ minimum: 1, maximum: LIMITS.maxReplicationFactor }),
    /** Top-level output fields compared for agreement in consensus mode. */
    consensus_fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 })),
  },
  { additionalProperties: false },
);
export type ProjectValidation = Static<typeof ProjectValidation>;

/** What a project owner submits to create a project. */
export const ProjectDefinition = Type.Object(
  {
    id: ProjectId,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ maxLength: 5_000 }),
    version: SemVer,
    category: ProjectCategory,
    input_schema: JsonSchemaDocument,
    output_schema: JsonSchemaDocument,
    prompt: PromptTemplate,
    requirements: ProjectRequirements,
    validation: ProjectValidation,
  },
  { additionalProperties: false },
);
export type ProjectDefinition = Static<typeof ProjectDefinition>;

/** A project as returned by the coordinator. */
export const Project = Type.Object(
  {
    ...ProjectDefinition.properties,
    status: ProjectStatus,
    created_at: Timestamp,
    updated_at: Timestamp,
  },
  { additionalProperties: false },
);
export type Project = Static<typeof Project>;

export const ProjectList = Type.Object(
  { projects: Type.Array(Project) },
  { additionalProperties: false },
);
export type ProjectList = Static<typeof ProjectList>;
