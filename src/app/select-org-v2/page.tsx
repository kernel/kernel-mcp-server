'use client';

import { Col } from '@/components/col';
import { Row } from '@/components/row';
import { KernelWordmark } from '@/components/icons';

const MOCK_ORGS = [
  { id: '1', name: 'mason', slug: 'mason', initial: 'M', isActive: true, isSelected: true },
  { id: '2', name: '1234-testing', slug: '1234-testing', initial: '1', isActive: false, isSelected: false },
  { id: '3', name: '123-testing', slug: '123-testing', initial: '1', isActive: false, isSelected: false },
];

// V2: Lighter background (#faf9f2) inset card with muted (#e1dccf) border + dividers
// Creates a subtle "lifted" panel against the beige page without shadows
export default function SelectOrgV2(): React.ReactElement {
  return (
    <Col className="min-h-screen items-center justify-center">
      <Col className="max-w-md w-full mx-auto p-8 gap-8">
        <Col className="items-center gap-3">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <p className="text-muted-foreground text-sm">
            select an organization to authorize access.
          </p>
        </Col>

        {/* Lighter background card with muted border */}
        <div className="bg-[#faf9f2] border-[0.5px] border-[#e1dccf]">
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

        {/* Button separate, full width */}
        <button className="w-full bg-foreground text-background py-3 px-4 font-[250] text-sm tracking-[0.3px] lowercase cursor-pointer hover:underline hover:decoration-[0.5px] hover:underline-offset-2">
          continue
        </button>
      </Col>

      <p className="fixed bottom-4 text-muted-foreground text-xs">
        v2 — lighter background inset card with muted border
      </p>
    </Col>
  );
}
