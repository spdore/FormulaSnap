import { Eye } from "lucide-react";
import { renderFormulaPreview } from "../formula-preview";

export function BatchFormulaPreview({ latex, onOpen }: { latex: string; onOpen: () => void }) {
  const rendered = renderFormulaPreview(latex);
  return (
    <div className="batch-formula-preview">
      <div className="batch-render-status">
        <span>识别成功</span>
        <span className={rendered.error ? "render-state failed" : "render-state ready"}>
          {rendered.error ? "预览未渲染" : "公式预览"}
        </span>
      </div>
      {rendered.error ? (
        <div className="batch-render-error">
          <span>公式无法渲染，源码仍保留。</span>
          <button className="link-button" type="button" onClick={onOpen}><Eye size={14} />查看并修正</button>
        </div>
      ) : (
        <div className="batch-formula-scroll" role="img" aria-label="已识别公式预览">
          <div className="batch-formula" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
      )}
      <details className="batch-source">
        <summary>查看 LaTeX 源码</summary>
        <pre>{latex}</pre>
      </details>
    </div>
  );
}