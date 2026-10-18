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
                            
                                                                                           
                      
                
                   
                           
                 
                   
                                            
                                
                              
                 
 

                                     
                                                            

                                
              
              
 

                                    
              
                     
                              
           
                                        
                                                      
   
                    
                     
                                                                    
 

                           
                      
                           
                 
                        
 

/** Compile one author-facing value spec to raw JSON Schema (wire form). */
export function toJsonSchema(spec           )                          {
  if (!spec || typeof spec !== 'object') return {}
  // Author-only `json` is the unconstrained-JSON form on the wire: the harness
  // rejects `type: "json"` outright ("schema.type must be one of
  // object/array/string/number/integer/boolean/null") and documents
  // annotation-only schemas as the unconstrained form instead.
  if (spec.type === 'json') {
    const loose                          = {}
    if (spec.description) loose.description = spec.description
    if (spec.title) loose.title = spec.title
    return loose
  }
  if (spec.oneOf) return { oneOf: spec.oneOf.map((branch) => toJsonSchema(branch)) }
  const type = spec.type ?? (spec.properties ? 'object' : 'string')
  const out                          = { type }
  if (spec.description) out.description = spec.description
  if (spec.title) out.title = spec.title
  if (spec.default !== undefined) out.default = spec.default
  if (spec.enum) out.enum = [...spec.enum]
  if (spec.const !== undefined) out.const = spec.const
  if (type === 'array' && spec.items) out.items = toJsonSchema(spec.items)
  if (type === 'object' && spec.properties) {
    const properties                          = {}
    const required           = []
    for (const [key, value] of Object.entries(spec.properties)) {
      const { required: isRequired, ...rest } = value
      properties[key] = toJsonSchema(rest             )
      if (isRequired) required.push(key)
    }
    out.properties = properties
    if (required.length) out.required = required
    out.additionalProperties = spec.additionalProperties ?? false
  }
  return out
}

/** Compile an implicit parameter map (open object root) to wire JSON Schema. */
export function parametersToJsonSchema(parameters                  )                          {
  const properties                          = {}
  const required           = []
  for (const [key, value] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = value
    properties[key] = toJsonSchema(rest             )
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Build a `ctx.tools.register`-shaped ToolDefinition from the author spec. */
export function defineTool(options                   )                          {
  return {
    name: options.name,
    description: options.description,
    parameters: parametersToJsonSchema(options.parameters),
    output: {
      schema: toJsonSchema(
        (options.output.schema             ).type || (options.output.schema             ).properties
          ? (options.output.schema             )
          : { type: 'object', properties: options.output.schema                     },
      ),
      render: options.output.render,
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.deferLoading ? { deferLoading: true } : {}),
    execute: options.execute,
  }
}

/** Small helper shared by tool renderers: text-only canonical projection. */
export function textBlock(text        )                  {
  return [{ type: 'text', text }]
}


//# sourceURL=tool.ts