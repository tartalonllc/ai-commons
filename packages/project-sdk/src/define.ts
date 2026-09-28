import {
  parse,
  ProjectDefinition,
  templatePlaceholders,
  type JsonSchemaDocument,
  type ValidationIssue,
} from '@ai-commons/protocol';
import { checkProjectSchema } from '@ai-commons/validators';

export class ProjectDefinitionError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(
      `Invalid project definition:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ProjectDefinitionError';
  }
}

function schemaPropertyNames(schema: JsonSchemaDocument): Set<string> | undefined {
  const props = schema['properties'];
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return undefined;
  return new Set(Object.keys(props));
}

/**
 * Validates a project definition and returns it unchanged. Prompts are
 * `{{field}}` templates rendered by workers, never code, so every
 * placeholder must name a top-level input property.
 */
export function defineProject(definition: ProjectDefinition): ProjectDefinition {
  const parsed = parse(ProjectDefinition, definition);
  if (!parsed.ok) throw new ProjectDefinitionError(parsed.issues);

  const issues: ValidationIssue[] = [
    ...checkProjectSchema(definition.input_schema).map((i) => ({
      path: `/input_schema${i.path}`,
      message: i.message,
    })),
    ...checkProjectSchema(definition.output_schema).map((i) => ({
      path: `/output_schema${i.path}`,
      message: i.message,
    })),
  ];

  const inputProps = schemaPropertyNames(definition.input_schema);
  if (!inputProps) {
    issues.push({
      path: '/input_schema/properties',
      message: 'input schema must declare properties',
    });
  } else {
    for (const part of ['system', 'user'] as const) {
      for (const field of templatePlaceholders(definition.prompt[part])) {
        if (!inputProps.has(field)) {
          issues.push({
            path: `/prompt/${part}`,
            message: `placeholder "{{${field}}}" is not an input_schema property`,
          });
        }
      }
    }
  }

  const outputProps = schemaPropertyNames(definition.output_schema);
  const { mode, consensus_fields: fields } = definition.validation;
  if (mode === 'consensus' && (!fields || fields.length === 0)) {
    issues.push({
      path: '/validation/consensus_fields',
      message: 'consensus mode requires at least one consensus field',
    });
  }
  for (const field of fields ?? []) {
    if (!outputProps?.has(field)) {
      issues.push({
        path: '/validation/consensus_fields',
        message: `"${field}" is not an output_schema property`,
      });
    }
  }

  if (issues.length > 0) throw new ProjectDefinitionError(issues);
  return definition;
}
