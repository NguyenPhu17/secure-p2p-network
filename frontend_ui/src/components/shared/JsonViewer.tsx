import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

interface JsonViewerProps {
  data: any;
  maxHeight?: string;
  initiallyExpanded?: boolean;
}

export const JsonViewer: React.FC<JsonViewerProps> = ({
  data,
  maxHeight = 'max-h-96',
  initiallyExpanded = true,
}) => {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);

  if (!data) {
    return <span className="text-slate-500 italic text-xs">null</span>;
  }

  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const highlightSyntax = (json: string) => {
    // Escape HTML special characters
    const escaped = json
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return escaped.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'text-amber-300'; // number
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'text-cyan-400 font-semibold'; // key
          } else {
            cls = match.length > 50 ? 'text-indigo-300 font-mono text-[11px]' : 'text-emerald-300'; // string or long b64
          }
        } else if (/true|false/.test(match)) {
          cls = 'text-purple-400 font-semibold'; // boolean
        } else if (/null/.test(match)) {
          cls = 'text-rose-400 italic'; // null
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  };

  return (
    <div className="relative rounded-lg border border-slate-800 bg-slate-950 font-mono text-xs overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 select-none">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-slate-400 hover:text-slate-200 transition"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <span className="font-sans font-medium text-[11px] text-slate-300">
            JSON Payload ({Object.keys(data || {}).length} keys)
          </span>
        </button>

        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] transition active:scale-95"
          title="Copy JSON"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>

      {isExpanded && (
        <pre
          className={`p-3 overflow-auto ${maxHeight} leading-relaxed text-slate-300 selection:bg-cyan-500/30`}
          dangerouslySetInnerHTML={{ __html: highlightSyntax(jsonString) }}
        />
      )}
    </div>
  );
};
