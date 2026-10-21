import type { ApiContractSchema } from "./apiContract.js";
import {
  enumOf,
  isNullable,
  isRecord,
  jsonText,
  localReference,
  recordUnresolved,
  recordUnknown,
  schemaRef,
  text,
  typeOf,
  type Context,
  type JsonRecord,
} from "./openApiContractShared.js";

type Property = ApiContractSchema["properties"][number];
type Reference = ApiContractSchema["references"][number];

const MAX_DEPTH = 32;
const CHILD_KEYS = ["allOf", "oneOf", "anyOf", "prefixItems"] as const;

/**
 * Collect every `$ref` reachable inside one schema with the JSON pointer it
 * sits at, so composition members, nested objects, array items, and
 * additionalProperties all count. Cycles and excessive depth stop the walk and
 * are reported.
 */
const collectReferences = (
  context: Context,
  schemaName: string,
  root: unknown,
): Reference[] => {
  const references: Reference[] = [];
  const visited = new Set<object>();
  const visit = (value: unknown, pointer: string, depth: number): void => {
    if (!isRecord(value) || visited.has(value)) return;
    if (depth > MAX_DEPTH) {
      recordUnknown(context, `${schemaName} ${pointer}`, "schema_depth_limit");
      return;
    }
    visited.add(value);
    if (typeof value.$ref === "string") {
      const outcome = schemaRef(context, value, `${schemaName} ${pointer}`);
      references.push({ via: pointer, ...outcome });
      return;
    }
    if (isRecord(value.properties))
      for (const [name, child] of Object.entries(value.properties))
        visit(child, `${pointer}/properties/${name}`, depth + 1);
    if (isRecord(value.items))
      visit(value.items, `${pointer}/items`, depth + 1);
    if (isRecord(value.additionalProperties))
      visit(
        value.additionalProperties,
        `${pointer}/additionalProperties`,
        depth + 1,
      );
    if (isRecord(value.not)) visit(value.not, `${pointer}/not`, depth + 1);
    for (const key of CHILD_KEYS) {
      const members = value[key];
      if (Array.isArray(members))
        members.forEach((member, index) =>
          visit(member, `${pointer}/${key}/${String(index)}`, depth + 1),
        );
    }
  };
  visit(root, "#", 0);
  return references;
};

const finiteOrNull = (
  context: Context,
  value: unknown,
  subject: string,
): number | null => {
  if (typeof value !== "number") return null;
  if (Number.isFinite(value)) return value;
  recordUnknown(context, subject, "non_finite_number");
  return null;
};

const property = (
  context: Context,
  schemaName: string,
  entry: readonly [string, unknown],
  required: boolean,
): Property => {
  const [name, value] = entry;
  const subject = `${schemaName}.${name}`;
  const record = isRecord(value) ? value : {};
  const items = isRecord(record.items) ? record.items : null;
  const own = schemaRef(context, record, subject);
  const itemRef =
    items === null
      ? { schema_ref: null, unresolved_ref: null }
      : schemaRef(context, items, `${subject}.items`);
  return {
    name,
    type: typeOf(record),
    format: text(record.format),
    ref: own.schema_ref,
    unresolved_ref: own.unresolved_ref,
    items_type: items === null ? null : typeOf(items),
    items_ref: itemRef.schema_ref,
    items_unresolved_ref: itemRef.unresolved_ref,
    enum: enumOf(context, record, subject),
    const_json: jsonText(context, record.const, `${subject}.const`),
    nullable: isNullable(context, record),
    required,
    minimum: finiteOrNull(context, record.minimum, `${subject}.minimum`),
    maximum: finiteOrNull(context, record.maximum, `${subject}.maximum`),
    default_json: jsonText(context, record.default, `${subject}.default`),
    description: text(record.description),
  };
};

const additionalProperties = (
  value: unknown,
): ApiContractSchema["additional_properties"] => {
  if (value === undefined) return null;
  if (value === true) return "any";
  if (value === false) return "none";
  return isRecord(value) ? "typed" : null;
};

const componentReference = (
  context: Context,
  name: string,
  record: JsonRecord,
): Pick<ApiContractSchema, "ref" | "unresolved_ref"> => {
  if (typeof record.$ref !== "string")
    return { ref: null, unresolved_ref: null };
  const local = localReference(record.$ref);
  if (
    local !== null &&
    local.group === "schemas" &&
    context.schemaNames.has(local.name)
  )
    return { ref: local.name, unresolved_ref: null };
  recordUnresolved(context, record.$ref, name);
  return { ref: null, unresolved_ref: record.$ref };
};

/** Normalize one component schema; property records are always built so inferences see the whole model. */
export const schemaEntry = (
  context: Context,
  name: string,
  value: unknown,
): ApiContractSchema => {
  const record = isRecord(value) ? value : {};
  const required = Array.isArray(record.required)
    ? record.required.filter((item): item is string => typeof item === "string")
    : [];
  const entries = isRecord(record.properties)
    ? Object.entries(record.properties)
    : [];
  // The component-level reference is recorded here; nested references come
  // from the collector so the unresolved count stays per distinct reference.
  const own = componentReference(context, name, record);
  const nested = collectReferences(context, name, record).filter(
    ({ via }) => via !== "#",
  );
  return {
    name,
    type: typeOf(record),
    description: text(record.description),
    ...own,
    enum: enumOf(context, record, name),
    const_json: jsonText(context, record.const, `${name}.const`),
    composition: (["allOf", "oneOf", "anyOf", "not"] as const).filter(
      (key) => record[key] !== undefined,
    ),
    additional_properties: additionalProperties(record.additionalProperties),
    required,
    property_count: entries.length,
    properties: entries.map((entry) =>
      property(context, name, entry, required.includes(entry[0])),
    ),
    references: [
      ...(own.ref === null && own.unresolved_ref === null
        ? []
        : [
            {
              via: "#",
              schema_ref: own.ref,
              unresolved_ref: own.unresolved_ref,
            },
          ]),
      ...nested,
    ],
  };
};
