import type { DefinitionPlan, DefinitionPlanEdge, DefinitionPlanNode } from "../src/definition.ts";
import type { StructuredProjection, ProjectionStatus } from "../src/structured-projection.ts";

export interface GraphFont { family: string; size: number; lineHeight: number; }
export interface GraphPort { id: string; side: "NORTH" | "SOUTH" | "EAST" | "WEST"; direction: "in" | "out"; }
export interface SceneNode {
  id: string; kind: DefinitionPlanNode["type"] | "group"; label: string;
  parentId?: string; ownerId?: string; width: number; height: number; ports: GraphPort[];
  logicalParentId?: string;
  collapsed?: boolean; collapsible?: boolean;
  labelLines?: string[];
}
export interface SceneEdge {
  id: string; source: string; target: string; sourcePort: string; targetPort: string;
  kind: DefinitionPlanEdge["kind"]; label: string; originalEdgeIds: string[];
  hidden?: boolean; labelSize?: { width: number; height: number };
}
export interface GraphScene { signature: string; nodes: SceneNode[]; edges: SceneEdge[]; font: GraphFont; }
export interface SceneOptions { collapsed?: ReadonlySet<string>; font?: GraphFont; measureText?: (text: string) => number; edgeLabels?: ReadonlyMap<string, string>; }
export interface GraphPoint { x: number; y: number; }
export interface GraphBounds extends GraphPoint { width: number; height: number; }
export interface LayoutNode extends SceneNode, GraphBounds { portPositions: Record<string, GraphPoint>; }
export interface LayoutEdge extends SceneEdge { sections: GraphPoint[][]; labelBounds?: GraphBounds; }
export interface GraphGeometry { signature: string; width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; durationMs: number; }
export type GraphLayoutFunction = (scene: GraphScene, signal?: AbortSignal) => Promise<GraphGeometry>;
export interface GraphState { status: ProjectionStatus; inScope: boolean; instanceCount: number; iterationCount: number; selected: boolean; }
export interface CanvasInput { plan?: DefinitionPlan; projection?: StructuredProjection; selectedNodeId?: string; collapsed: ReadonlySet<string>; identity?: string; edgeLabels?: ReadonlyMap<string, string>; }
export interface CanvasCallbacks {
  onSelectNode: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onZoom?: (scale: number) => void;
  onError?: (message: string) => void;
}
