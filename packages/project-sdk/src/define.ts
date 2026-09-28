import { parse, ProjectDefinition, type ValidationIssue } from '@ai-commons/protocol';
import { checkProjectDefinition } from '@ai-commons/validators';

export class ProjectDefinitionError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(
      `Invalid project definition:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ProjectDefinitionError';
  }
}

/**
 * Validates a project definition and returns it unchanged. Prompts are
 * `{{field}}` templates rendered by workers, never code, so every
 * placeholder must name a top-level input property.
 */
export function defineProject(definition: ProjectDefinition): ProjectDefinition {
  const parsed = parse(ProjectDefinition, definition);
  if (!parsed.ok) throw new ProjectDefinitionError(parsed.issues);

  const issues = checkProjectDefinition(definition);
  if (issues.length > 0) throw new ProjectDefinitionError(issues);
  return definition;
}
