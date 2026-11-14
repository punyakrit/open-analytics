import { useState } from 'react';
import { CheckIcon, CopyIcon } from './Icons';

export function CopyButton({ text, label = 'Copy', className = 'btn-ghost px-2 py-1 text-xs' }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A snippet to paste somewhere, with what it is and a copy button. */
export function CodeBlock({ label, children }: { label?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200">
      <div className="flex items-center justify-between border-b border-stone-200 bg-surface py-1 pl-3 pr-1">
        <span className="text-xs text-stone-500">{label}</span>
        <CopyButton text={children} />
      </div>
      <code className="code">{children}</code>
    </div>
  );
}

/** A single value to copy, like a URL. */
export function CopyField({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}
