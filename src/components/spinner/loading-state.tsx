'use client';

import { Row } from '@/components/row';
import { KernelIcon } from '@/components/icons';

export interface LoadingStateProps {
  children?: React.ReactNode;
  fullscreen?: boolean;
}

export const LoadingState = ({ children, fullscreen }: LoadingStateProps) => {
  const spinner = (
    <Row className="gap-2">
      <KernelIcon className="animate-spin duration-1000 object-contain" size={48} />
      {children}
    </Row>
  );

  if (fullscreen) {
    return <Row className="h-screen items-center justify-center">{spinner}</Row>;
  }

  return spinner;
};
