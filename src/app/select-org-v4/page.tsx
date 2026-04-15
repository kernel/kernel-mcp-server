'use client';

import { Col } from '@/components/col';
import { Row } from '@/components/row';
import { KernelWordmark } from '@/components/icons';

const MOCK_ORGS = [
  { id: '1', name: 'mason', slug: 'mason', initial: 'M', isActive: true, isSelected: true },
  { id: '2', name: '1234-testing', slug: '1234-testing', initial: '1', isActive: false, isSelected: false },
  { id: '3', name: '123-testing', slug: '123-testing', initial: '1', isActive: false, isSelected: false },
];

// V4: Charcoal outer frame with lighter inner panel (#faf9f2) + muted dividers
// Two-layer depth — creates layered definition without shadows
export default function SelectOrgV4(): React.ReactElement {
  return (
    <Col className="min-h-screen items-center justify-center">
      <Col className="max-w-md w-full mx-auto p-8 gap-8">
        <Col className="items-center gap-3">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <p className="text-muted-foreground text-sm">
            select an organization to authorize access.
          </p>
        </Col>

        {/* Charcoal outer frame with lighter inner panel */}
        <div className="border-[0.5px] border-foreground">
          <div className="bg-[#faf9f2]">
            {MOCK_ORGS.map((org, i) => (
              <button
                key={org.id}
                className={`w-full p-4 text-left cursor-pointer border-none flex items-center gap-3 font-[250] tracking-[0.3px] lowercase text-foreground ${
                  i < MOCK_ORGS.length - 1 ? 'border-b-[0.5px] border-b-[#e1dccf]' : ''
                } ${
                  org.isSelected ? 'bg-primary/10' : 'bg-[#faf9f2] hover:bg-primary/5'
                }`}
              >
                <div className="w-10 h-10 bg-primary flex items-center justify-center">
                  <span className="text-foreground text-base">{org.initial}</span>
                </div>
                <Col className="flex-1 gap-0.5">
                  <Row className="justify-between items-center">
                    <span className="font-light text-sm text-foreground">{org.name}</span>
                    {org.isActive && (
                      <span className="text-[10px] font-[350] uppercase tracking-normal border-[0.5px] border-foreground px-2 py-0.5">
                        active
                      </span>
                    )}
                  </Row>
                  <span className="text-xs text-muted-foreground">{org.slug}</span>
                </Col>
              </button>
            ))}
          </div>
          {/* Button at bottom of frame */}
          <button className="w-full py-3 px-4 bg-foreground text-background border-none cursor-pointer font-[250] text-sm tracking-[0.3px] lowercase">
            continue
          </button>
        </div>
      </Col>

      <p className="fixed bottom-4 text-muted-foreground text-xs">
        v4 — charcoal frame + lighter inner panel with muted dividers
      </p>
    </Col>
  );
}
