import type {
  ApiContractInspection,
  ApiContractOperation,
  ApiContractSchema,
} from "./apiContract.js";

type Inferences = ApiContractInspection["inferences"];

const STATUS_PROPERTY = /(?:^|_)(?:status|state|phase)$|Status$|State$/u;

const namespaces = (
  ops: readonly ApiContractOperation[],
): Inferences["namespaces"] => {
  const counts = new Map<string, { depth: number; count: number }>();
  for (const { path } of ops) {
    const segments = path.split("/").filter((segment) => segment !== "");
    for (const depth of [2, 3])
      if (segments.length >= depth) {
        const prefix = `/${segments.slice(0, depth).join("/")}`;
        const entry = counts.get(prefix) ?? { depth, count: 0 };
        entry.count += 1;
        counts.set(prefix, entry);
      }
  }
  return [...counts.entries()]
    .filter(([, { count }]) => count >= 2)
    .map(([prefix, { depth, count }]) => ({
      prefix,
      depth,
      operation_count: count,
    }))
    .sort(
      (left, right) =>
        left.depth - right.depth || left.prefix.localeCompare(right.prefix),
    );
};

const statusEnums = (
  schemas: readonly ApiContractSchema[],
): Inferences["status_enums"] =>
  schemas.flatMap((schema) =>
    schema.properties
      .filter(
        ({ name, enum: values }) =>
          values !== null && STATUS_PROPERTY.test(name),
      )
      .map(({ name, enum: values }) => ({
        schema: schema.name,
        property: name,
        values: values ?? [],
      })),
  );

const asyncIndicators = (
  ops: readonly ApiContractOperation[],
  statusSchemas: ReadonlySet<string>,
): Inferences["async_indicators"] =>
  ops.flatMap((op) => {
    const indicators: Inferences["async_indicators"][number][] = [];
    if (op.responses.some(({ status }) => status === "202"))
      indicators.push({
        method: op.method,
        path: op.path,
        reason: "accepted_202",
        detail:
          "Declares a 202 Accepted response: the request is accepted for processing that might or might not complete after the call returns.",
      });
    const polled = op.responses
      .flatMap(({ content }) => content)
      .map(({ schema_ref }) => schema_ref)
      .find((ref) => ref !== null && statusSchemas.has(ref));
    if (op.method === "get" && polled !== undefined && polled !== null)
      indicators.push({
        method: op.method,
        path: op.path,
        reason: "status_poll",
        detail: `Returns ${polled}, whose status enum suggests this GET is polled until a terminal state.`,
      });
    return indicators;
  });

/** Edges between component schemas, from every resolved reference inside each schema. */
const schemaReferences = (
  schemas: readonly ApiContractSchema[],
): Inferences["schema_references"] =>
  schemas.flatMap((schema) =>
    schema.references.flatMap(({ via, schema_ref }) =>
      schema_ref === null ? [] : [{ from: schema.name, via, to: schema_ref }],
    ),
  );

const quotaStatuses = (
  ops: readonly ApiContractOperation[],
): Inferences["quota_statuses"] =>
  ops.flatMap((op) => {
    const statuses = op.responses
      .map(({ status }) => status)
      .filter((status) => status === "402" || status === "429");
    return statuses.length === 0
      ? []
      : [{ method: op.method, path: op.path, statuses }];
  });

/**
 * Heuristic readings of a declared API surface. Each facet is derived from
 * path shapes, property names, or status codes and is reported apart from the
 * declared facts so callers can weigh it accordingly.
 */
export const inferApiContractFacets = (
  ops: readonly ApiContractOperation[],
  schemas: readonly ApiContractSchema[],
): Inferences => {
  const status = statusEnums(schemas);
  return {
    namespaces: namespaces(ops),
    status_enums: status,
    async_indicators: asyncIndicators(
      ops,
      new Set(status.map(({ schema }) => schema)),
    ),
    schema_references: schemaReferences(schemas),
    quota_statuses: quotaStatuses(ops),
  };
};
