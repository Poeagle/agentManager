/** The diagram and renderer live in an opaque-origin iframe, without network access. */
export function buildDrawioPreview(xml: string, viewer: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !['mxfile', 'mxGraphModel'].includes(doc.documentElement.tagName)) {
    throw new Error('不是有效的 draw.io 图表文件');
  }
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const diagram = JSON.stringify(xml).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;min-height:100%;background:#fff;color:#172033;font:14px/1.6 system-ui}#diagram{position:relative;min-height:360px;width:100%;overflow:auto}#error{padding:16px;color:#b91c1c;white-space:pre-wrap}</style>
</head><body><div id="diagram"></div><div id="error" role="alert"></div>
<script nonce="${nonce}">window.MathJax = {};</script>
<script nonce="${nonce}">${viewer.replace(/<\/script/gi, '<\\/script')}</script>
<script nonce="${nonce}">
try {
  mxStencilRegistry.dynamicLoading = false;
  mxStencilRegistry.allowEval = false;
  Editor.MathJaxRender = function() {};
  Editor.onMathJaxDone = function() {};
  var diagram = document.getElementById('diagram');
  diagram.setAttribute('data-mxgraph', JSON.stringify({xml:${diagram},nav:true,resize:true,fit:true,toolbar:'pages zoom layers','toolbar-nohide':true}));
  GraphViewer.createViewerForElement(diagram, function(viewer) {
    viewer.graph.setEnabled(false);
    viewer.graph.getLinkForCell = function() { return null; };
  });
} catch(error) { document.getElementById('error').textContent = '图表预览失败：' + error.message; }
</script></body></html>`;
}
