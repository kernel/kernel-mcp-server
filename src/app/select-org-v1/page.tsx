'use client';

import { Col } from '@/components/col';
import { Row } from '@/components/row';
import { KernelWordmark } from '@/components/icons';

const MOCK_ORGS = [
  { id: '1', name: 'mason', slug: 'mason', initial: 'M', isActive: true, isSelected: true },
  { id: '2', name: '1234-testing', slug: '1234-testing', initial: '1', isActive: false, isSelected: false },
  { id: '3', name: '123-testing', slug: '123-testing', initial: '1', isActive: false, isSelected: false },
];

// V1: Bordered card container — org list + button wrapped in a single bordered box
export default function SelectOrgV1(): React.ReactElement {
  return (
    <Col className="min-h-screen items-center justify-center">
      <Col className="max-w-md w-full mx-auto p-8 gap-8">
        <Col className="items-center gap-3">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <p className="text-muted-foreground text-sm">
            select an organization to authorize access.
          </p>
        </Col>

        {/* Bordered container wrapping org list + button */}
        <div className="border-[0.5px] border-foreground">
          {MOCK_ORGS.map((org) => (
            <button
              key={org.id}
              className={`w-full p-4 text-left cursor-pointer border-none border-b-[0.5px] border-b-foreground flex items-center gap-3 font-[250] tracking-[0.3px] lowercase text-foreground ${
                org.isSelected ? 'bg-primary/10' : 'hover:bg-primary/5'
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
          {/* Button inside the container */}
          <button className="w-full py-3 px-4 bg-foreground text-background border-none cursor-pointer font-[250] text-sm tracking-[0.3px] lowercase">
            continue
          </button>
        </div>
      </Col>

      <p className="fixed bottom-4 text-muted-foreground text-xs">
        v1 — bordered card container
      </p>
    </Col>
  );
}
