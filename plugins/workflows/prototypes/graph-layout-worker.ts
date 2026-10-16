import { layoutGraphScene } from "./graph-layout.ts";
import type { GraphGeometry, GraphScene } from "./graph-types.ts";

interface LayoutMessage { id: number; scene: GraphScene; }
interface LayoutResponse { id: number; geometry?: GraphGeometry; error?: string; }
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<LayoutMessage>) => void) | null; postMessage: (value: LayoutResponse) => void };
scope.onmessage = event => {
  const { id, scene } = event.data;
  if (!Number.isSafeInteger(id) || !scene || typeof scene.signature !== "string") return;
  void layoutGraphScene(scene).then(geometry => scope.postMessage({ id, geometry }), error => scope.postMessage({ id, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }));
};
