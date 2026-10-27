import type { HTMLAttributes, ReactNode } from 'react';

type Tag = 'h1' | 'h2' | 'h3' | 'p' | 'div';

/**
 * Text set in authored lines, each in its own overflow-clipped mask, so a reveal can lift
 * the lines into view one after another (landing.css: data-reveal="lines"). The lines read
 * as one sentence: a space ends every line but the last. A line may still wrap inside its
 * mask on a narrow screen; nothing is set nowrap, so nothing can overflow.
 */
export function Lines({ as: Tag = 'div', lines, reveal = true, ...rest }: { as?: Tag; lines: ReactNode[]; reveal?: boolean } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag data-reveal={reveal ? 'lines' : undefined} {...rest}>
      {lines.map((line, i) => (
        <span className="line" key={i}>
          <span className="line-inner" style={{ ['--i' as string]: i }}>
            {line}
            {i < lines.length - 1 ? ' ' : null}
          </span>
        </span>
      ))}
    </Tag>
  );
}
