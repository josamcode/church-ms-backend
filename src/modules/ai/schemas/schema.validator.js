/**
 * The second hard gate: structural validation of model output.
 *
 * A provider's "strict" structured-output mode is a strong hint, not a
 * guarantee we control. Model output is treated as untrusted input and
 * re-validated here before any application code reads it.
 *
 * Deliberately a small, dependency-free JSON Schema subset covering exactly
 * what the AI schemas use — object/array/string/number/boolean, `required`,
 * `enum`, and `additionalProperties: false`. A general-purpose validator would
 * accept keywords the provider silently ignores, which is how a schema ends up
 * claiming a guarantee it does not have.
 */

class SchemaValidationError extends Error {
  constructor(errors) {
    super(`Model output failed schema validation: ${errors.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.code = 'SCHEMA_INVALID';
    this.errors = errors;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type) {
    const actual = typeOf(value);
    const expected = schema.type;
    const matches = expected === 'number'
      ? actual === 'number'
      : actual === expected;

    if (!matches) {
      errors.push(`${path || 'root'}: expected ${expected}, received ${actual}`);
      return; // Cascading errors from a wrong type are noise.
    }
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${path || 'root'}: value not in enum [${schema.enum.join(', ')}]`
      );
    }
  }

  if (schema.type === 'object') {
    const properties = schema.properties || {};

    for (const key of schema.required || []) {
      if (value[key] === undefined) {
        errors.push(`${path ? `${path}.` : ''}${key}: required property missing`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(
            `${path ? `${path}.` : ''}${key}: unexpected property (additionalProperties is false)`
          );
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateNode(value[key], childSchema, path ? `${path}.${key}` : key, errors);
      }
    }
  }

  if (schema.type === 'array' && schema.items) {
    value.forEach((entry, index) => {
      validateNode(entry, schema.items, `${path}[${index}]`, errors);
    });
  }
}

/**
 * Validate and return the value, or throw.
 * @throws {SchemaValidationError}
 */
function validateAgainstSchema(value, schema, schemaName = 'output') {
  const errors = [];
  validateNode(value, schema, '', errors);

  if (errors.length > 0) {
    throw new SchemaValidationError(errors.map((e) => `${schemaName}.${e}`));
  }
  return value;
}

/** Non-throwing form, for tests and reporting. */
function checkAgainstSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Parse a model's textual response into JSON.
 *
 * Providers occasionally wrap JSON in markdown fences even in structured mode,
 * so that one specific, well-understood deviation is tolerated. Anything else
 * is a validation failure rather than something to repair heuristically —
 * guessing at malformed model output is how invented data enters a system.
 */
function parseModelJson(raw) {
  if (raw && typeof raw === 'object') return raw;

  const text = String(raw ?? '').trim();
  if (!text) {
    throw new SchemaValidationError(['empty response']);
  }

  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new SchemaValidationError([`response is not valid JSON: ${error.message}`]);
  }
}

module.exports = {
  validateAgainstSchema,
  checkAgainstSchema,
  parseModelJson,
  SchemaValidationError,
};
