import type { ReactNode } from 'react';

/**
 * Every section opens the same way: a mono index eyebrow (the app's metadata voice), the h2, and
 * an optional lede. Keeping it in one place keeps the heading order and rhythm identical.
 */
export function SectionHeading({
  index,
  label,
  id,
  title,
  children,
  className = '',
}: {
  index: string;
  label: string;
  id: string;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`max-w-3xl ${className}`}>
      <p className="eyebrow">
        <b>{index}</b> / {label}
      </p>
      <h2
        id={id}
        className="mt-4 text-3xl font-bold leading-tight tracking-tight text-text sm:text-[2.625rem]"
      >
        {title}
      </h2>
      {children ? (
        <div className="mt-5 space-y-4 text-lg leading-relaxed text-text-soft">{children}</div>
      ) : null}
    </div>
  );
}
