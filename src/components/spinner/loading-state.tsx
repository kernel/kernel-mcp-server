'use client';

import { Col } from '@/components/col';
import { KernelWordmark } from '@/components/icons';

export interface LoadingStateProps {
  children?: React.ReactNode;
  fullscreen?: boolean;
}

export const LoadingState = ({ children, fullscreen }: LoadingStateProps) => {
  const loader = (
    <Col className="items-center gap-4">
      <KernelWordmark className="text-foreground" width={100} height={22} />
      <div className="w-32 h-[1px] bg-[#e1dccf] overflow-hidden">
        <div
          className="h-full bg-foreground"
          style={{
            width: '40%',
            animation: 'kernel-bar-slide 1.2s ease-in-out infinite',
          }}
        />
      </div>
      {children}
      <style>{`
        @keyframes kernel-bar-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </Col>
  );

  if (fullscreen) {
    return <Col className="h-screen items-center justify-center">{loader}</Col>;
  }

  return loader;
};
