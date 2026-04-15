'use client';

import { useAuth, useOrganizationList, useUser, CreateOrganization, UserButton } from '@clerk/nextjs';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState, Suspense, useEffect, useRef } from 'react';
import { Col } from '@/components/col'
import { Row } from '@/components/row'
import { LoadingState } from '@/components/spinner/loading-state';
import { KernelWordmark } from '@/components/icons';

function SelectOrgContent(): React.ReactElement {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: {
      infinite: true,
    },
  });
  const { orgId } = useAuth();
  const { user } = useUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(orgId || null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Check if we just returned from org creation and reload to get fresh data
  useEffect(() => {
    if (searchParams.get('org_created') === 'true') {
      // Remove the flag from URL and reload to get fresh organization data
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('org_created');
      window.location.href = newUrl.toString();
    }
  }, [searchParams]);

  // Check scroll state
  const updateScrollState = (): void => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    setCanScrollUp(scrollTop > 0);
    setCanScrollDown(scrollTop < scrollHeight - clientHeight);
  };

  // Update scroll state when content changes
  useEffect(() => {
    updateScrollState();
  }, [userMemberships?.data]);

  // Get the original OAuth parameters from the URL
  const originalParams = {
    client_id: searchParams.get('client_id'),
    redirect_uri: searchParams.get('redirect_uri'),
    response_type: searchParams.get('response_type'),
    scope: searchParams.get('scope'),
    state: searchParams.get('state'),
    code_challenge: searchParams.get('code_challenge'),
    code_challenge_method: searchParams.get('code_challenge_method'),
  };

  const handleOrgSelect = (organizationId: string): void => {
    setSelectedOrgId(organizationId);
  };

  const handleConfirm = async (): Promise<void> => {
    if (!setActive || isSelecting || !selectedOrgId) return;

    setIsSelecting(true);

    try {
      await setActive({ organization: selectedOrgId });

      // After setting active org, redirect back to authorize
      const authorizeUrl = new URL('/authorize', window.location.origin);

      // Add all original OAuth parameters
      Object.entries(originalParams).forEach(([key, value]) => {
        if (value) authorizeUrl.searchParams.set(key, value);
      });

      // Add the selected orgId as a parameter
      authorizeUrl.searchParams.set('org_id', selectedOrgId);

      const redirectUri = authorizeUrl.toString();

      router.push(redirectUri);
    } catch (error) {
      console.error('Failed to set active organization:', error);
      setIsSelecting(false);
    }
  };

  if (!isLoaded || userMemberships?.isLoading) {
    return (
      <Col className="min-h-screen items-center justify-center">
        <Col className="text-center items-center gap-2">
          <LoadingState />
          <p className="text-muted-foreground text-sm">loading your organizations...</p>
        </Col>
      </Col>
    );
  }

  // Check if user has any organizations (only after loaded)
  if (isLoaded && !userMemberships?.isLoading && (!userMemberships?.data || userMemberships.data.length === 0)) {
    return (
      <Col className="min-h-screen items-center justify-center">
        {/* User button in top-right corner */}
        <div className="absolute top-4 right-4">
          <UserButton
            afterSignOutUrl={`/select-org?${searchParams.toString()}`}
          />
        </div>

        <Col className="text-center max-w-md mx-auto p-8 gap-8">
          <Col className="items-center gap-4">
            <KernelWordmark className="text-foreground" width={100} height={22} />
            <p className="text-muted-foreground text-sm">
              you need to be a member of at least one organization to continue.
            </p>
          </Col>
          <CreateOrganization
            afterCreateOrganizationUrl={(() => {
              const params = new URLSearchParams(searchParams.toString());
              params.set('org_created', 'true');
              return `/select-org?${params.toString()}`;
            })()}
            skipInvitationScreen={true}
          />
        </Col>
      </Col>
    );
  }

  return (
    <Col className="min-h-screen items-center justify-center">
      {/* User button in top-right corner */}
      <div className="absolute top-4 right-4">
        <UserButton
          afterSignOutUrl={`/select-org?${searchParams.toString()}`}
        />
      </div>

      <Col className="max-w-md w-full mx-auto p-8 gap-8">
        <Col className="items-center gap-3">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <p className="text-muted-foreground text-sm">
            select an organization to authorize access.
          </p>
        </Col>

        <div className="relative">
          <div
            ref={scrollContainerRef}
            onScroll={updateScrollState}
            className="flex flex-col gap-2 max-h-60 overflow-y-auto"
          >
            {(userMemberships?.data || user?.organizationMemberships)
              ?.sort((a, b) => {
                // Put the currently active org first
                if (a.organization.id === orgId) return -1;
                if (b.organization.id === orgId) return 1;
                return 0;
              })
              ?.map((membership) => {
              const isSelected = membership.organization.id === selectedOrgId;
              const isCurrentlyActive = membership.organization.id === orgId;
              return (
                <button
                  key={membership.organization.id}
                  onClick={() => handleOrgSelect(membership.organization.id)}
                  disabled={isSelecting}
                  className={`w-full p-4 text-left rounded-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    isSelected
                      ? 'bg-primary/10 border border-primary/40'
                      : 'border border-border hover:border-primary/30 hover:bg-primary/5'
                  }`}
                >
                  <Row className="gap-3">
                    {membership.organization.imageUrl && (
                      <img
                        src={membership.organization.imageUrl}
                        alt={membership.organization.name}
                        className="w-10 h-10 rounded-lg"
                      />
                    )}
                    <Col className="flex-1 gap-1">
                      <Row className="justify-between items-center">
                        <span className="font-normal text-sm text-foreground">{membership.organization.name}</span>
                        {isCurrentlyActive && (
                          <span className="text-xs bg-primary/15 text-primary px-2 py-0.5 rounded-full">
                            active
                          </span>
                        )}
                      </Row>
                      <span className="text-xs text-muted-foreground">{membership.organization.slug}</span>
                    </Col>
                  </Row>
                </button>
              );
            })}
          </div>

          {/* Fade overlays to indicate scrollability */}
          {canScrollUp && (
            <div className="absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-background to-transparent pointer-events-none" />
          )}
          {canScrollDown && (
            <div className="absolute bottom-0 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent pointer-events-none" />
          )}
        </div>

        <button
          onClick={handleConfirm}
          disabled={isSelecting || !selectedOrgId}
          className="w-full bg-primary text-primary-foreground py-3 px-4 rounded-lg font-normal text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-opacity"
        >
          {isSelecting ? (
            <Row className="items-center justify-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary-foreground"></div>
              authorizing...
            </Row>
          ) : 'continue'}
        </button>
      </Col>
    </Col>
  );
}

function LoadingFallback(): React.ReactElement {
  return (
    <Col className="min-h-screen items-center justify-center">
      <Col className="text-center items-center gap-2">
        <LoadingState />
        <p className="text-muted-foreground text-sm">loading...</p>
      </Col>
    </Col>
  );
}

export default function SelectOrgPage(): React.ReactElement {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SelectOrgContent />
    </Suspense>
  );
}
