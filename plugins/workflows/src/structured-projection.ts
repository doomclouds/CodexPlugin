import { compileDefinition } from "./definition.ts";
import type { CompiledDefinition, DefinitionPlan, DefinitionPlanEdge, DefinitionPlanNode } from "./definition.ts";
import type { InstanceStatus, NodeInstance, StructuredEvent, StructuredRun } from "./structured-types.ts";

/** Projection never schedules work and never substitutes the last loop result for active instances. */
export type ProjectionStatus = InstanceStatus | "planned" | "mixed" | "skipped";
export interface ProjectedPlanNode extends DefinitionPlanNode {
  definitionNodeId: string;
  frameInstanceId?: string;
  status: ProjectionStatus;
  instanceIds: string[];
  currentInstanceId?: string;
  scopeInstanceIds?: string[];
  availableScopeInstanceIds?: string[];
  inScope: boolean;
  counts: Partial<Record<InstanceStatus, number>>;
  iterations?: number[];
  itemKeys?: string[];
}
export interface ProjectedPlanEdge extends DefinitionPlanEdge {
  definitionEdgeId?: string;
  frameInstanceId?: string;
  status: ProjectionStatus;
  instanceIds: string[];
  eventSequences: number[];
  transitionCount: number;
  inScope: boolean;
}
export interface StructuredProjection {
  version: 1;
  definitionHash: string;
  revision: number;
  eventCursor: number;
  nodes: ProjectedPlanNode[];
  edges: ProjectedPlanEdge[];
  scopeInstanceId?: string;
}
export interface ProjectionOptions { scopeInstanceId?: string; }

const activePriority: InstanceStatus[] = ["running", "unknown", "waiting", "ready"];
function aggregate(instances: NodeInstance[]): ProjectionStatus {
  if (!instances.length) return "planned";
  for (const status of activePriority) if (instances.some(instance => instance.status === status)) return status;
  const statuses = new Set(instances.map(instance => instance.status));
  return statuses.size === 1 ? instances[0]!.status : "mixed";
}
function current(instances: NodeInstance[]): NodeInstance | undefined {
  for (const status of activePriority) { const found = instances.find(instance => instance.status === status); if (found) return found; }
  return instances.at(-1);
}

/** Select authoritative persisted facts. scopeInstanceId identifies an activation, never a definition node. */
export function projectStructuredRun(run: StructuredRun, options: ProjectionOptions = {}): StructuredProjection {
  const instanceById = new Map(run.instances.map(instance => [instance.id, instance]));
  interface Frame { id: string; compiled: CompiledDefinition; owner?: NodeInstance; }
  const frames = new Map<string, Frame>([["root", { id: "root", compiled: run.compiled }]]);
  for (const instance of run.instances) {
    const definition = instance.type === "expand" ? instance.cursor?.expanded : instance.type === "subflow" ? instance.cursor?.definition : undefined;
    if (definition !== undefined) frames.set(instance.id, { id: instance.id, owner: instance, compiled: compileDefinition(definition) });
  }
  function frameFor(instance: NodeInstance): Frame {
    const visited = new Set<string>();
    let parentId = instance.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const frame = frames.get(parentId);
      if (frame) return frame;
      parentId = instanceById.get(parentId)?.parentId;
    }
    return frames.get("root")!;
  }
  const prefixed = (frame: Frame, localId: string): string => frame.id === "root" ? localId : `$frame:${frame.id}:${localId}`;
  const plan: DefinitionPlan = { version: 1, nodes: [], edges: [] };
  const nodeOrigins = new Map<string, { localId: string; frame: Frame }>();
  const edgeOrigins = new Map<string, { localId?: string; frame: Frame; connector?: "entry" | "exit" }>();
  for (const frame of frames.values()) {
    const ownerId = frame.owner ? prefixed(frameFor(frame.owner), frame.owner.nodeId) : undefined;
    for (const node of frame.compiled.plan.nodes) {
      const id = prefixed(frame, node.id);
      const parentId = node.parentId ? prefixed(frame, node.parentId) : ownerId;
      plan.nodes.push({ ...node, id, ...(parentId ? { parentId } : {}) });
      nodeOrigins.set(id, { localId: node.id, frame });
    }
    for (const edge of frame.compiled.plan.edges) {
      const id = prefixed(frame, edge.id);
      plan.edges.push({ ...edge, id, from: prefixed(frame, edge.from), to: prefixed(frame, edge.to) });
      edgeOrigins.set(id, { localId: edge.id, frame });
    }
    if (frame.owner && ownerId && frame.compiled.definition.steps.length) {
      const first = frame.compiled.definition.steps[0]!;
      const last = frame.compiled.definition.steps.at(-1)!;
      const lastIsContainer = frame.compiled.plan.nodes.some(node => node.id === `$join:${last.id}`);
      const entry: DefinitionPlanEdge = { id: `${prefixed(frame, "entry")}`, from: ownerId, to: prefixed(frame, first.id), kind: "body" };
      const exit: DefinitionPlanEdge = { id: `${prefixed(frame, "exit")}`, from: prefixed(frame, lastIsContainer ? `$join:${last.id}` : last.id), to: prefixed(frameFor(frame.owner), `$join:${frame.owner.nodeId}`), kind: "join" };
      plan.edges.push(entry, exit);
      edgeOrigins.set(entry.id, { frame, connector: "entry" });
      edgeOrigins.set(exit.id, { frame, connector: "exit" });
      // Once the frozen child exists, replace its placeholder exit rather than draw a bypass.
      plan.edges = plan.edges.filter(edge => !(edge.from === ownerId && edge.to === exit.to && edge.kind === "exit"));
    }
  }
  const planById = new Map(plan.nodes.map(node => [node.id, node]));
  if (options.scopeInstanceId && !instanceById.has(options.scopeInstanceId)) throw new Error("The requested workflow instance does not exist in this run");
  const descendants = new Set<string>();
  if (options.scopeInstanceId) {
    descendants.add(options.scopeInstanceId);
    for (let changed = true; changed;) {
      changed = false;
      for (const instance of run.instances) if (instance.parentId && descendants.has(instance.parentId) && !descendants.has(instance.id)) { descendants.add(instance.id); changed = true; }
    }
  } else for (const instance of run.instances) descendants.add(instance.id);
  const scopedInstances = run.instances.filter(instance => descendants.has(instance.id));
  const instancesByNode = new Map<string, NodeInstance[]>();
  const scopesByNode = new Map<string, NodeInstance[]>();
  for (const instance of scopedInstances) {
    const nodeId = prefixed(frameFor(instance), instance.nodeId);
    const target = instance.type === "scope" ? scopesByNode : instancesByNode;
    const list = target.get(nodeId) ?? [];
    list.push(instance);
    target.set(nodeId, list);
  }
  const scopedRoot = options.scopeInstanceId ? instanceById.get(options.scopeInstanceId) : undefined;
  const scopeNode = scopedRoot ? prefixed(frameFor(scopedRoot), scopedRoot.nodeId) : undefined;
  function isPlanInScope(nodeId: string): boolean {
    if (!scopeNode) return true;
    const visited = new Set<string>();
    for (let id: string | undefined = nodeId; id && !visited.has(id); id = planById.get(id)?.parentId) {
      if (id === scopeNode) return true;
      visited.add(id);
    }
    return false;
  }
  function selectedCase(instance: NodeInstance): string | undefined {
    const selected = instance.cursor?.selectedCase;
    return typeof selected === "string" ? selected : undefined;
  }
  function skippedBranch(node: DefinitionPlanNode): boolean {
    let child = node;
    const visited = new Set<string>();
    while (child.parentId && !visited.has(child.parentId)) {
      visited.add(child.parentId);
      const parent = planById.get(child.parentId);
      if (!parent) return false;
      if (parent.type === "choice" && child.branchId !== undefined) {
        const owners = instancesByNode.get(parent.id) ?? [];
        if (owners.length && owners.every(owner => selectedCase(owner) !== undefined && selectedCase(owner) !== child.branchId)) return true;
      }
      child = parent;
    }
    return false;
  }
  const nodes = plan.nodes.map((node): ProjectedPlanNode => {
    const isJoin = node.type === "join";
    const scopes = scopesByNode.get(isJoin ? node.parentId ?? "" : node.id) ?? [];
    const actual = instancesByNode.get(isJoin ? node.parentId ?? "" : node.id) ?? [];
    const instances = !isJoin && scopedRoot?.type === "scope" && node.id === scopeNode ? [scopedRoot] : actual;
    const counts: Partial<Record<InstanceStatus, number>> = {};
    for (const instance of instances) counts[instance.status] = (counts[instance.status] ?? 0) + 1;
    let status = aggregate(instances);
    if (isJoin) {
      const committed = instances.filter(instance => instance.status === "completed");
      status = committed.length === instances.length && committed.length ? "completed" : instances.some(instance => instance.cursor?.phase === "joining") ? "waiting" : "planned";
    }
    if (status === "planned" && !instances.length && skippedBranch(node)) status = "skipped";
    const selected = current(instances);
    const ownerIds = new Set(instances.map(instance => instance.id));
    const observedIterations = run.events.flatMap(event => event.type === "repeat.iteration" && event.instanceId && ownerIds.has(event.instanceId) && event.data !== null && typeof event.data === "object" && !Array.isArray(event.data) && typeof event.data.iteration === "number" ? [event.data.iteration] : []);
    const iterations = [...new Set([...instances.concat(scopes).flatMap(instance => instance.iteration === undefined ? [] : [instance.iteration]), ...observedIterations])].sort((a, b) => a - b);
    const itemKeys = [...new Set(instances.concat(scopes).flatMap(instance => instance.itemKey !== undefined ? [instance.itemKey] : Array.isArray(instance.cursor?.keys) ? instance.cursor.keys.filter((key): key is string => typeof key === "string") : []))];
    const origin = nodeOrigins.get(node.id)!;
    let selectorOwner: string | undefined;
    let ancestor = scopedRoot;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);
      if (prefixed(frameFor(ancestor), ancestor.nodeId) === node.id) { selectorOwner = ancestor.type === "scope" ? ancestor.parentId : ancestor.id; break; }
      ancestor = ancestor.parentId ? instanceById.get(ancestor.parentId) : undefined;
    }
    const availableScopes = run.instances.filter(instance => instance.type === "scope" && prefixed(frameFor(instance), instance.nodeId) === node.id && (selectorOwner === undefined ? descendants.has(instance.id) : instance.parentId === selectorOwner));
    return { ...node, definitionNodeId: origin.localId, ...(origin.frame.owner ? { frameInstanceId: origin.frame.owner.id } : {}), status, instanceIds: instances.map(instance => instance.id), ...(selected ? { currentInstanceId: selected.id } : {}), ...(scopes.length ? { scopeInstanceIds: scopes.map(instance => instance.id) } : {}), ...(availableScopes.length ? { availableScopeInstanceIds: availableScopes.map(instance => instance.id) } : {}), inScope: isPlanInScope(node.id), counts, ...(iterations.length ? { iterations } : {}), ...(itemKeys.length ? { itemKeys } : {}) };
  });
  function eventInScope(event: StructuredEvent): boolean {
    if (!options.scopeInstanceId) return true;
    return [event.instanceId, event.fromInstanceId, event.toInstanceId].some(id => id !== undefined && descendants.has(id));
  }
  const eventsByEdge = new Map<string, StructuredEvent[]>();
  for (const event of run.events) if (event.edgeId && eventInScope(event)) {
    const source = [event.fromInstanceId, event.instanceId, event.toInstanceId].flatMap(id => id ? [instanceById.get(id)].filter((value): value is NodeInstance => value !== undefined) : [])[0];
    let frame = source ? frameFor(source) : frames.get("root")!;
    const eventHash = event.data !== null && typeof event.data === "object" && !Array.isArray(event.data) ? event.data?.definitionHash : undefined;
    if (eventHash && frame.compiled.hash !== eventHash && source && frames.has(source.id) && frames.get(source.id)!.compiled.hash === eventHash) frame = frames.get(source.id)!;
    if (eventHash && eventHash !== frame.compiled.hash) continue;
    const id = prefixed(frame, event.edgeId);
    const list = eventsByEdge.get(id) ?? [];
    list.push(event);
    eventsByEdge.set(id, list);
  }
  const edges = plan.edges.map((edge): ProjectedPlanEdge => {
    const origin = edgeOrigins.get(edge.id)!;
    const events = eventsByEdge.get(edge.id) ?? [];
    const transitionPrefix = origin.localId ? `${origin.frame.compiled.hash}:${origin.localId}:` : undefined;
    const committed = transitionPrefix ? run.instances.flatMap(instance => {
      if (frameFor(instance).id !== origin.frame.id && frames.get(instance.id)?.id !== origin.frame.id) return [];
      const keys = instance.cursor?.transitions;
      if (!Array.isArray(keys)) return [];
      return keys.filter((key): key is string => typeof key === "string" && key.startsWith(transitionPrefix)).filter(key => {
        if (!options.scopeInstanceId || descendants.has(instance.id)) return true;
        const scopePath = key.slice(transitionPrefix.length);
        return scopedRoot !== undefined && (scopePath === scopedRoot.path || scopePath.startsWith(`${scopedRoot.path}/`));
      }).map(key => ({ instanceId: instance.id, key }));
    }) : [];
    const ids = [...new Set([...events.flatMap(event => [event.instanceId, event.fromInstanceId, event.toInstanceId].filter((id): id is string => id !== undefined && instanceById.has(id))), ...committed.map(evidence => evidence.instanceId)])];
    let status: ProjectionStatus = events.length || committed.length ? "completed" : "planned";
    if (origin.connector && origin.frame.owner && descendants.has(origin.frame.owner.id)) {
      const owner = origin.frame.owner;
      const activated = scopedInstances.some(instance => instance.parentId === owner.id);
      if (origin.connector === "entry" && activated || origin.connector === "exit" && owner.status === "completed") status = "completed";
    }
    const from = planById.get(edge.from);
    if (status === "planned" && from?.type === "choice" && edge.branchId !== undefined) {
      const owners = instancesByNode.get(from.id) ?? [];
      if (owners.length && owners.every(owner => selectedCase(owner) !== undefined && selectedCase(owner) !== edge.branchId)) status = "skipped";
    }
    if (status === "planned") {
      const fromNode = nodes.find(node => node.id === edge.from);
      const toNode = nodes.find(node => node.id === edge.to);
      if (fromNode?.status === "skipped" || toNode?.status === "skipped") status = "skipped";
    }
    return { ...edge, ...(origin.localId ? { definitionEdgeId: origin.localId } : {}), ...(origin.frame.owner ? { frameInstanceId: origin.frame.owner.id } : {}), status, instanceIds: ids, eventSequences: events.map(event => event.sequence), transitionCount: committed.length || events.length, inScope: isPlanInScope(edge.from) && isPlanInScope(edge.to) };
  });
  return { version: 1, definitionHash: run.definitionHash, revision: run.revision, eventCursor: run.events.reduce((cursor, event) => Math.max(cursor, event.sequence), 0), nodes, edges, ...(options.scopeInstanceId ? { scopeInstanceId: options.scopeInstanceId } : {}) };
}
