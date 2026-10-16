import type { Artboard, DesignDocument, DesignNode, NodeStyle } from './model.ts';

export const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export const jsonForHtml = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
function token(doc: DesignDocument, value: string | undefined, fallback: string): string {
  let current = value ?? fallback;
  const visited = new Set<string>();
  while (current.startsWith('$')) {
    if (visited.has(current)) return fallback;
    visited.add(current); current = doc.designSystem.tokens[current.slice(1)] ?? fallback;
  }
  return current;
}
function cssValue(value: string): string { return /[;{}<>\\]|url\s*\(|expression\s*\(|@import/i.test(value) ? '' : value; }
export function styleText(doc: DesignDocument, node: DesignNode, flow = false): string {
  const s: NodeStyle = node.style;
  const entries: Record<string, string | number | undefined> = {
    position: flow ? 'relative' : 'absolute', left: flow ? undefined : `${node.x}px`, top: flow ? undefined : `${node.y}px`,
    width: `${node.width}px`, height: `${node.height}px`, 'box-sizing': 'border-box', 'flex-shrink': 0,
    display: node.layout?.mode === 'grid' ? 'grid' : node.layout && node.layout.mode !== 'absolute' ? 'flex' : 'block',
    background: token(doc, s.fill, node.type === 'button' ? '#18181b' : 'transparent'), color: token(doc, s.color, '#18181b'),
    border: s.stroke ? `${s.strokeWidth ?? 1}px solid ${token(doc, s.stroke, 'transparent')}` : '0',
    'border-radius': node.type === 'ellipse' ? '50%' : `${s.radius ?? 0}px`, opacity: s.opacity ?? 1,
    'font-family': token(doc, s.fontFamily, 'system-ui, sans-serif'), 'font-size': `${s.fontSize ?? 16}px`, 'font-weight': s.fontWeight ?? 400,
    'line-height': s.lineHeight ?? 1.4, 'text-align': s.textAlign ?? 'left', 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere',
    overflow: node.type === 'text' ? 'visible' : 'hidden', 'box-shadow': token(doc, s.shadow, 'none'),
  };
  if (node.layout && node.layout.mode !== 'absolute') {
    const l = node.layout; entries.gap = `${l.gap}px`; entries.padding = `${l.padding}px`;
    entries['flex-direction'] = l.mode === 'column' ? 'column' : 'row';
    entries['align-items'] = l.align === 'start' ? 'flex-start' : l.align === 'end' ? 'flex-end' : l.align ?? 'stretch';
    entries['justify-content'] = l.justify === 'start' ? 'flex-start' : l.justify === 'end' ? 'flex-end' : l.justify ?? 'flex-start';
    if (l.mode === 'grid') entries['grid-template-columns'] = `repeat(${l.columns ?? 2},minmax(0,1fr))`;
  }
  return Object.entries(entries).filter(([,v]) => v !== undefined).map(([key,value]) => `${key}:${cssValue(String(value))}`).join(';');
}
function renderNode(doc: DesignDocument, original: DesignNode, flow: boolean, depth = 0, stack: string[] = [], instanceChild = false): string {
  if (depth > 32) return '';
  let node = original;
  while (node.type === 'component' && node.componentId && !stack.includes(node.componentId) && stack.length < 32) {
    const component = doc.designSystem.components.find(c => c.id === node.componentId);
    if (component) {
      const source = component.node;
      node = {...source, ...node, type: source.type, componentId: source.componentId, text: node.text ?? source.text, style: {...source.style, ...node.style}, layout: node.layout ?? source.layout, children: node.children.length ? node.children : source.children};
      stack = [...stack, component.id];
    } else break;
  }
  const interaction = node.interaction;
  const action = interaction ? ` data-design-action="${interaction.action}" data-design-target="${escapeHtml(interaction.target)}" tabindex="0" role="${interaction.action === 'url' ? 'link' : 'button'}"` : '';
  const attrs = `${instanceChild ? '' : `data-node-id="${escapeHtml(original.id)}"`} data-node-type="${node.type}" data-node-name="${escapeHtml(node.name)}"${node.visible === false ? ' hidden' : ''} style="${escapeHtml(styleText(doc, node, flow))}"${action}`;
  const children = node.children.map(child => renderNode(doc, child, !!node.layout && node.layout.mode !== 'absolute', depth + 1, stack, instanceChild || original.type === 'component')).join('');
  if (node.type === 'image') {
    const asset = doc.assets.find(a => a.id === node.assetId);
    return `<div ${attrs}>${asset ? `<img alt="${escapeHtml(node.text ?? node.name)}" src="data:${asset.mimeType};base64,${asset.data}" style="width:100%;height:100%;object-fit:cover;display:block">` : `<span role="img" aria-label="${escapeHtml(node.name)}">${escapeHtml(node.text ?? '图片')}</span>`}</div>`;
  }
  if (node.type === 'input') return `<div ${attrs}><input aria-label="${escapeHtml(node.name)}" placeholder="${escapeHtml(node.text ?? '')}" style="width:100%;height:100%;font:inherit;color:inherit;background:transparent;border:0;padding:8px;box-sizing:border-box"></div>`;
  const tag = node.type === 'button' ? 'button' : 'div';
  return `<${tag} ${attrs}>${escapeHtml(node.text ?? '')}${children}</${tag}>`;
}
export interface RenderOptions { interactive?: boolean; selection?: string[]; artboardId?: string }
export function renderArtboard(doc: DesignDocument, artboardId: string, _options: RenderOptions = {}): string {
  const board = doc.artboards.find(a => a.id === artboardId);
  if (!board) throw new Error('Artboard not found');
  return `<div class="design-artboard" data-artboard-id="${escapeHtml(board.id)}" aria-label="${escapeHtml(board.name)}" style="position:relative;isolation:isolate;width:${board.width}px;height:${board.height}px;background:${escapeHtml(cssValue(token(doc, board.background, '#ffffff')))};overflow:hidden"><style>.design-artboard [hidden]{display:none!important}</style>${board.nodes.map(node => renderNode(doc, node, false)).join('')}</div>`;
}
export const interactionScript = `document.addEventListener('click',e=>{const n=e.target.closest('[data-design-action]');if(!n)return;const a=n.dataset.designAction,t=n.dataset.designTarget;if(a==='navigate'){for(const b of document.querySelectorAll('.design-artboard')){b.hidden=b.dataset.artboardId!==t;const s=b.closest('section');if(s)s.hidden=b.hidden}}else if(a==='toggle'){for(const x of document.querySelectorAll('[data-node-id]'))if(x.dataset.nodeId===t)x.hidden=!x.hidden}else if(a==='url'&&/^(https?:\\/\\/|mailto:)/i.test(t)){window.open(t,'_blank','noopener,noreferrer')}});document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-design-action]')){e.preventDefault();e.target.click()}});`;
export function renderDocument(doc: DesignDocument, options: RenderOptions = {}): string {
  const boards = options.artboardId ? doc.artboards.filter(a => a.id === options.artboardId) : doc.artboards;
  const body = boards.map((board,index) => `<section${options.interactive && index ? ' hidden' : ''}><h2>${escapeHtml(board.name)}</h2>${renderArtboard(doc,board.id,options)}</section>`).join('');
  // Store source as inert JSON; never execute project-supplied scripts.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${escapeHtml(doc.name)}</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font-family:system-ui,sans-serif}section{width:max-content;margin:24px auto}h2{font-size:14px;color:#52525b;margin:0 0 12px}button{font:inherit;cursor:pointer}button,input{min-width:0}button[data-node-id]{padding:0}[hidden]{display:none!important}@media print{body{background:white}section{margin:0;break-after:page}h2{display:none}.design-artboard{break-inside:avoid}}${options.artboardId ? 'body{background:transparent}section{margin:0}h2{display:none}' : ''}</style></head><body>${body}<script type="application/json" id="design-document">${jsonForHtml(doc)}</script>${options.interactive ? `<script>${interactionScript}</script>` : ''}</body></html>`;
}

export function renderSvg(doc: DesignDocument, board: Artboard): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${board.width}" height="${board.height}" viewBox="0 0 ${board.width} ${board.height}" role="img" aria-label="${escapeHtml(board.name)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:system-ui,sans-serif">${renderArtboard(doc, board.id)}</div></foreignObject></svg>`;
}
