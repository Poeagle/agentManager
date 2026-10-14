import type { ComponentProps, ReactNode } from 'react';

export function TableActions({ children }: { children: ReactNode }) {
  return <div className="table-actions">{children}</div>;
}

export function TableActionButton({ type = 'button', ...props }: Omit<ComponentProps<'button'>, 'className'>) {
  return <button {...props} type={type} className="table-button" />;
}
