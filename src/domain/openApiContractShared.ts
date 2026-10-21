import type { ApiContractInspection } from "./apiContract.js";
import type { JsonValue } from "./jsonValue.js";

/** A parsed JSON or YAML object node. */
export type JsonRecord = Readonly<Record<string, unknown>>;

/** OpenAPI minor versions this normalizer reads. */
export type OpenApiVersion = "3.0" | "3.1";

type Unknown = ApiContractInspection["unknowns"][number];

/** Component groups whose local references are resolved. */
export type ComponentGroup =
  | "schemas"
  | "parameters"
  | "requestBodies"
  | "responses"
  | "headers";

const COMPONENT_GROUPS: ReadonlySet<string> = new Set<ComponentGroup>([
  "schemas",
  "parameters",
  "requestBodies",
  "responses",
  "headers",
]);

/** Mutable bookkeeping shared across one normalization. */
export interface Context {
  readonly version: OpenApiVersion;
  readonly components: JsonRecord;
  readonly schemaNames: ReadonlySet<string>;
  readonly unknowns: Unknown[];
  readonly unknownKeys: Set<string>;
  readonly unresolvedRefs: Set<string>;
}

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Whether an object key is a Specification Extension, which carries no normalized fact. */
export const isExtensionKey = (key: string): boolean => key.startsWith("x-");

/** Record one unknown once per subject and reason. */
export const recordUnknown = (
  context: Context,
  subject: string,
  reason: string,
): void => {
  const key = `${reason}\0${subject}`;
  if (context.unknownKeys.has(key)) return;
  context.unknownKeys.add(key);
  context.unknowns.push({ subject, reason });
};

/** Mark a reference as unresolved; the count reports distinct references. */
export const recordUnresolved = (
  context: Context,
  ref: string,
  subject: string,
): void => {
  context.unresolvedRefs.add(ref);
  recordUnknown(
    context,
    `${subject} → ${ref}`,
    "external_or_unsupported_reference",
  );
};

/**
 * Convert parsed data to a JSON value for the result. Non-finite numbers and
 * non-JSON host values (dates, maps) are replaced by null and reported, so the
 * output never fails its own schema because of one odd scalar.
 */
export const toJsonValue = (
  context: Context,
  value: unknown,
  subject: string,
): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    recordUnknown(context, subject, "non_finite_number");
    return null;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      toJsonValue(context, item, `${subject}[${String(index)}]`),
    );
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        toJsonValue(context, item, `${subject}.${key}`),
      ]),
    );
  recordUnknown(context, subject, "non_json_value");
  return null;
};

/** JSON text of a declared default or const, or null when absent. */
export const jsonText = (
  context: Context,
  value: unknown,
  subject: string,
): string | null =>
  value === undefined
    ? null
    : JSON.stringify(toJsonValue(context, value, subject));

/** A YAML or JSON scalar coerced to text; numbers are reported because the document should quote them. */
export const scalarText = (
  context: Context,
  value: unknown,
  subject: string,
): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    recordUnknown(context, subject, "numeric_scalar_coerced_to_text");
    return String(value);
  }
  return null;
};

interface LocalReference {
  readonly group: ComponentGroup;
  readonly name: string;
}

const unescapePointer = (segment: string): string =>
  segment.replaceAll("~1", "/").replaceAll("~0", "~");

/** Parse `#/components/<group>/<name>`; anything else is not a local component reference. */
export const localReference = (ref: string): LocalReference | null => {
  const match = /^#\/components\/([^/]+)\/([^/]+)$/u.exec(ref);
  if (match === null) return null;
  const group = match[1] ?? "";
  const name = match[2] ?? "";
  return COMPONENT_GROUPS.has(group)
    ? { group: group as ComponentGroup, name: unescapePointer(name) }
    : null;
};

/** Own-property lookup only, so `__proto__` or `toString` never resolve to built-ins. */
export const componentMember = (
  context: Context,
  group: ComponentGroup,
  name: string,
): unknown => {
  const members = context.components[group];
  return isRecord(members) && Object.hasOwn(members, name)
    ? members[name]
    : undefined;
};

/**
 * Follow `$ref` chains inside one component group with a visited set.
 * Returns the final non-reference value, or undefined after recording the
 * unresolved reference.
 */
export const resolveReference = (
  context: Context,
  group: Exclude<ComponentGroup, "schemas">,
  value: unknown,
  subject: string,
): unknown => {
  const visited = new Set<string>();
  let current = value;
  while (isRecord(current) && typeof current.$ref === "string") {
    const ref = current.$ref;
    const local = localReference(ref);
    if (local === null || local.group !== group || visited.has(ref)) {
      recordUnresolved(context, ref, subject);
      return undefined;
    }
    visited.add(ref);
    current = componentMember(context, group, local.name);
    if (current === undefined) {
      recordUnresolved(context, ref, subject);
      return undefined;
    }
  }
  return current;
};

/** Reference outcome for a schema position: a resolved local name, an unresolved raw ref, or none. */
export interface SchemaRefOutcome {
  readonly schema_ref: string | null;
  readonly unresolved_ref: string | null;
}

export const NO_SCHEMA_REF: SchemaRefOutcome = {
  schema_ref: null,
  unresolved_ref: null,
};

/** Classify a `$ref` at a schema position without following it. */
export const schemaRef = (
  context: Context,
  value: unknown,
  subject: string,
): SchemaRefOutcome => {
  if (!isRecord(value) || typeof value.$ref !== "string") return NO_SCHEMA_REF;
  const ref = value.$ref;
  const local = localReference(ref);
  if (
    local !== null &&
    local.group === "schemas" &&
    context.schemaNames.has(local.name)
  )
    return { schema_ref: local.name, unresolved_ref: null };
  recordUnresolved(context, ref, subject);
  return { schema_ref: null, unresolved_ref: ref };
};

/** Declared type, composition keyword, or null. 3.1 type arrays drop `null`, which `isNullable` reports. */
export const typeOf = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.type === "string") return value.type;
  if (Array.isArray(value.type)) {
    const types = value.type.filter(
      (item): item is string => typeof item === "string" && item !== "null",
    );
    return types.length === 0 && value.type.includes("null")
      ? "null"
      : types.length === 0
        ? null
        : types.join("|");
  }
  for (const key of ["allOf", "oneOf", "anyOf", "not"] as const)
    if (value[key] !== undefined) return key;
  return null;
};

/**
 * Nullability as each version defines it: 3.0 `nullable: true` (ignored as a
 * `$ref` sibling), 3.1 a `null` entry in the type array.
 */
export const isNullable = (context: Context, value: JsonRecord): boolean =>
  context.version === "3.0"
    ? value.nullable === true && typeof value.$ref !== "string"
    : Array.isArray(value.type) && value.type.includes("null");

/** Enum values as JSON, or null when none are declared. */
export const enumOf = (
  context: Context,
  value: unknown,
  subject: string,
): JsonValue[] | null =>
  isRecord(value) && Array.isArray(value.enum)
    ? value.enum.map((item, index) =>
        toJsonValue(context, item, `${subject}.enum[${String(index)}]`),
      )
    : null;
