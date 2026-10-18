/**
 * Dependency-free equivalent of `defineTool` from `@deepseek-ai/dsh-tools`.
 *
 * WHY A LOCAL SHIM: the plugin ships into `$DSH_HOME/plugins/<name>` (a plain
 * directory outside the Harness install). Node ESM would resolve a bare
 * `@deepseek-ai/dsh-tools` import from there by walking *up* the plugin
 * directory — the Harness' own `node_modules` is not on that path, so the
 * import fails at load time. The published plugin therefore keeps zero
 * non-`node:` imports and reproduces the *contract* of `defineTool`:
 *
 *   { name, description, parameters, output: { schema, render }, execute }
 *
 * `parameters`/`output.schema` accept the author-facing spec DSL (a per-key
 * property map with `required: true`, or a value node), which this module
 * compiles to the raw JSON Schema that `ctx.tools.register` puts on the wire
 * (dsh-llm `ToolSchema.parameters: Record<string, unknown>`). `render` is the
 * pure canonical-value -> ContentBlock[] projection. Keeping this local also
 * makes the engine testable with `node --test` and no install step.
 */
export interface ValueSpec {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
  description?: string
  title?: string
  default?: unknown
  enum?: readonly unknown[]
  const?: unknown
  items?: ValueSpec
  properties?: Record<string, ParameterSpec>
  additionalProperties?: boolean
  oneOf?: readonly ValueSpec[]
  required?: true
}

export type ParameterSpec = ValueSpec
export type ParameterSpecMap = Record<string, ParameterSpec>

export interface RenderedBlock {
  type: 'text'
  text: string
}

export interface DefinitionOptions {
  name: string
  description: string
  parameters: ParameterSpecMap
  output: {
    schema: ParameterSpecMap | ValueSpec
    render: (args: any, value: any) => RenderedBlock[]
  }
  timeoutMs?: number
  deferLoading?: true
  execute: (args: any, exec: ToolExec) => Promise<unknown> | unknown
}

export interface ToolExec {
  signal?: AbortSignal
  session?: { id?: string }
  callId?: string
  [key: string]: unknown
}

/** Compile one author-facing value spec to raw JSON Schema (wire form). */
export function toJsonSchema(spec: ValueSpec): Record<string, unknown> {
  if (!spec || typeof spec !== 'object') return {}
  if (spec.oneOf) return { oneOf: spec.oneOf.map((branch) => toJsonSchema(branch)) }
  const type = spec.type ?? (spec.properties ? 'object' : 'string')
  const out: Record<string, unknown> = { type }
  if (spec.description) out.description = spec.description
  if (spec.title) out.title = spec.title
  if (spec.default !== undefined) out.default = spec.default
  if (spec.enum) out.enum = [...spec.enum]
  if (spec.const !== undefined) out.const = spec.const
  if (type === 'array' && spec.items) out.items = toJsonSchema(spec.items)
  if (type === 'object' && spec.properties) {
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(spec.properties)) {
      const { required: isRequired, ...rest } = value
      properties[key] = toJsonSchema(rest as ValueSpec)
      if (isRequired) required.push(key)
    }
    out.properties = properties
    if (required.length) out.required = required
    out.additionalProperties = spec.additionalProperties ?? false
  }
  return out
}

/** Compile an implicit parameter map (open object root) to wire JSON Schema. */
export function parametersToJsonSchema(parameters: ParameterSpecMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = value
    properties[key] = toJsonSchema(rest as ValueSpec)
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Build a `ctx.tools.register`-shaped ToolDefinition from the author spec. */
export function defineTool(options: DefinitionOptions): Record<string, unknown> {
  return {
    name: options.name,
    description: options.description,
    parameters: parametersToJsonSchema(options.parameters),
    output: {
      schema: toJsonSchema(
        (options.output.schema as ValueSpec).type || (options.output.schema as ValueSpec).properties
          ? (options.output.schema as ValueSpec)
          : { type: 'object', properties: options.output.schema as ParameterSpecMap },
      ),
      render: options.output.render,
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.deferLoading ? { deferLoading: true } : {}),
    execute: options.execute,
  }
}

/** Small helper shared by tool renderers: text-only canonical projection. */
export function textBlock(text: string): RenderedBlock[] {
  return [{ type: 'text', text }]
}
