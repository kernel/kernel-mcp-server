'use client';

import { Col } from '@/components/col';
import { Row } from '@/components/row';
import { KernelIcon, KernelWordmark } from '@/components/icons';

// A: Current — spinning logo (for reference)
function VariantA(): React.ReactElement {
  return (
    <Col className="items-center gap-2">
      <KernelIcon className="animate-spin object-contain" size={48} />
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
    </Col>
  );
}

// B: Pulsing logo — gentle opacity pulse instead of spin
function VariantB(): React.ReactElement {
  return (
    <Col className="items-center gap-2">
      <KernelIcon className="animate-pulse object-contain" size={48} />
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
    </Col>
  );
}

// C: Minimal bar loader — thin animated line under the wordmark
function VariantC(): React.ReactElement {
  return (
    <Col className="items-center gap-4">
      <KernelWordmark className="text-foreground" width={100} height={22} />
      <div className="w-32 h-[1px] bg-[#e1dccf] overflow-hidden">
        <div
          className="h-full bg-foreground"
          style={{
            width: '40%',
            animation: 'slide 1.2s ease-in-out infinite',
          }}
        />
      </div>
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
      <style>{`
        @keyframes slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
    </Col>
  );
}

// D: Three dots — simple typing-style dots
function VariantD(): React.ReactElement {
  return (
    <Col className="items-center gap-3">
      <KernelWordmark className="text-foreground" width={100} height={22} />
      <Row className="gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-1.5 h-1.5 bg-foreground"
            style={{
              animation: 'dotPulse 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </Row>
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
      <style>{`
        @keyframes dotPulse {
          0%, 80%, 100% { opacity: 0.2; }
          40% { opacity: 1; }
        }
      `}</style>
    </Col>
  );
}

// E: Border spinner — small square outline with one side animated
function VariantE(): React.ReactElement {
  return (
    <Col className="items-center gap-3">
      <KernelWordmark className="text-foreground" width={100} height={22} />
      <div
        className="w-5 h-5 border-[0.5px] border-[#e1dccf] border-t-foreground"
        style={{ animation: 'squareSpin 0.8s linear infinite' }}
      />
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
      <style>{`
        @keyframes squareSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Col>
  );
}

// F: Wordmark with pulsing green dot — static wordmark, small green dot pulses
function VariantF(): React.ReactElement {
  return (
    <Col className="items-center gap-3">
      <Row className="items-center gap-2">
        <KernelWordmark className="text-foreground" width={100} height={22} />
        <div
          className="w-2 h-2 bg-primary"
          style={{ animation: 'dotBreathe 1.5s ease-in-out infinite' }}
        />
      </Row>
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
      <style>{`
        @keyframes dotBreathe {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </Col>
  );
}

// G: Progress blocks — three small squares filling sequentially
function VariantG(): React.ReactElement {
  return (
    <Col className="items-center gap-3">
      <KernelWordmark className="text-foreground" width={100} height={22} />
      <Row className="gap-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-2 h-2 border-[0.5px] border-foreground"
            style={{
              animation: 'blockFill 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </Row>
      <p className="text-muted-foreground text-sm">loading your organizations...</p>
      <style>{`
        @keyframes blockFill {
          0%, 100% { background: transparent; }
          40%, 60% { background: #1c2024; }
        }
      `}</style>
    </Col>
  );
}

export default function LoadingVariants(): React.ReactElement {
  const variants = [
    { label: 'a — spinning logo (current)', component: <VariantA /> },
    { label: 'b — pulsing logo', component: <VariantB /> },
    { label: 'c — minimal bar loader', component: <VariantC /> },
    { label: 'd — three dots', component: <VariantD /> },
    { label: 'e — square border spinner', component: <VariantE /> },
    { label: 'f — wordmark + pulsing green dot', component: <VariantF /> },
    { label: 'g — progress blocks', component: <VariantG /> },
  ];

  return (
    <Col className="min-h-screen items-center py-16 gap-0">
      <p className="text-muted-foreground text-xs mb-12">loading state variants</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0 max-w-3xl w-full">
        {variants.map((v) => (
          <Col key={v.label} className="items-center justify-center p-12 border-[0.5px] border-[#e1dccf] -mt-[0.5px] first:mt-0 md:[&:nth-child(odd)]:-mr-[0.5px] min-h-[200px]">
            {v.component}
            <p className="text-muted-foreground text-[10px] mt-6 font-[350]">{v.label}</p>
          </Col>
        ))}
      </div>
    </Col>
  );
}
