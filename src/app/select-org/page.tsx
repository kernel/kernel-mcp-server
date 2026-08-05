"use client";

import {
  CreateOrganization,
  UserButton,
  useAuth,
  useOrganizationList,
  useUser,
} from "@clerk/nextjs";
import { useSearchParams, useRouter } from "next/navigation";
import { useState, Suspense, useCallback, useEffect, useRef } from "react";
import { Col } from "@/components/col";
import { Row } from "@/components/row";
import { LoadingState } from "@/components/spinner/loading-state";
import { KernelWordmark } from "@/components/icons";

interface OAuthProject {
  id: string;
  name: string;
}

type SelectionStage = "organization" | "scope";

function SelectOrgContent(): React.ReactElement {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 100 },
  });
  const { orgId } = useAuth();
  const { user } = useUser();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [stage, setStage] = useState<SelectionStage>("organization");
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(
    orgId || null,
  );
  const [projects, setProjects] = useState<OAuthProject[]>([]);
  const [projectQuery, setProjectQuery] = useState("");
  const [hasMoreProjects, setHasMoreProjects] = useState(false);
  const [nextProjectOffset, setNextProjectOffset] = useState<number>();
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [selectedScope, setSelectedScope] = useState("organization");
  const [projectsError, setProjectsError] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const projectRequestRef = useRef(0);
  const lastLoadedProjectQueryRef = useRef<string | null>(null);
  const supportsProjectScope =
    searchParams.get("code_challenge_method") === "S256" &&
    Boolean(searchParams.get("code_challenge"));

  useEffect(() => {
    if (userMemberships?.hasNextPage && !userMemberships.isFetching) {
      userMemberships.fetchNext?.();
    }
  }, [userMemberships?.hasNextPage, userMemberships?.isFetching]);

  useEffect(() => {
    if (searchParams.get("org_created") === "true") {
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete("org_created");
      window.location.href = newUrl.toString();
    }
  }, [searchParams]);

  const updateScrollState = (): void => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    setCanScrollUp(scrollTop > 0);
    setCanScrollDown(scrollTop < scrollHeight - clientHeight);
  };

  useEffect(() => {
    updateScrollState();
  }, [userMemberships?.data, projects, stage]);

  const loadProjectsPage = useCallback(
    async ({
      organizationId,
      query,
      offset,
      append,
    }: {
      organizationId: string;
      query: string;
      offset: number;
      append: boolean;
    }): Promise<void> => {
      const requestId = ++projectRequestRef.current;
      setIsLoadingProjects(true);
      setProjectsError(false);

      try {
        const params = new URLSearchParams({
          org_id: organizationId,
          limit: "20",
          offset: String(offset),
        });
        if (query) params.set("query", query);
        const response = await fetch(`/oauth/projects?${params.toString()}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("failed to load projects");
        const body = (await response.json()) as {
          projects: OAuthProject[];
          has_more: boolean;
          next_offset?: number;
        };
        if (requestId !== projectRequestRef.current) return;

        setProjects((current) =>
          append ? [...current, ...body.projects] : body.projects,
        );
        setHasMoreProjects(body.has_more);
        setNextProjectOffset(body.next_offset);
        lastLoadedProjectQueryRef.current = query;
      } catch (error) {
        if (requestId !== projectRequestRef.current) return;
        console.error("Failed to load projects:", error);
        if (!append) {
          setProjects([]);
          setHasMoreProjects(false);
          setNextProjectOffset(undefined);
          lastLoadedProjectQueryRef.current = null;
        }
        setProjectsError(true);
      } finally {
        if (requestId === projectRequestRef.current) {
          setIsLoadingProjects(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (
      stage !== "scope" ||
      !supportsProjectScope ||
      !selectedOrgId ||
      projectQuery === lastLoadedProjectQueryRef.current
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      setSelectedScope("organization");
      void loadProjectsPage({
        organizationId: selectedOrgId,
        query: projectQuery,
        offset: 0,
        append: false,
      });
    }, 250);
    return () => clearTimeout(timeout);
  }, [
    loadProjectsPage,
    projectQuery,
    selectedOrgId,
    stage,
    supportsProjectScope,
  ]);

  const handleOrgConfirm = async (): Promise<void> => {
    if (!setActive || isSelecting || !selectedOrgId) return;
    setIsSelecting(true);
    setProjectsError(false);
    setSelectionError(null);

    try {
      await setActive({ organization: selectedOrgId });
    } catch (error) {
      console.error("Failed to select organization:", error);
      setSelectionError("organization selection failed. please try again.");
      setIsSelecting(false);
      return;
    }

    setProjectQuery("");
    lastLoadedProjectQueryRef.current = null;
    if (supportsProjectScope) {
      await loadProjectsPage({
        organizationId: selectedOrgId,
        query: "",
        offset: 0,
        append: false,
      });
    } else {
      setProjects([]);
      setHasMoreProjects(false);
      setNextProjectOffset(undefined);
    }

    setSelectedScope("organization");
    setStage("scope");
    setIsSelecting(false);
  };

  const handleAuthorize = (): void => {
    if (!selectedOrgId || isSelecting) return;
    setIsSelecting(true);

    const authorizeUrl = new URL("/authorize", window.location.origin);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("org_created");
    params.delete("org_id");
    params.delete("access_scope");
    params.delete("project_id");
    params.forEach((value, key) => authorizeUrl.searchParams.set(key, value));
    authorizeUrl.searchParams.set("org_id", selectedOrgId);

    if (selectedScope.startsWith("project:")) {
      authorizeUrl.searchParams.set("access_scope", "project");
      authorizeUrl.searchParams.set(
        "project_id",
        selectedScope.slice("project:".length),
      );
    } else {
      authorizeUrl.searchParams.set("access_scope", "organization");
    }

    router.push(authorizeUrl.toString());
  };

  if (!isLoaded || userMemberships?.isLoading) {
    return (
      <Col className="min-h-screen items-center justify-center">
        <LoadingState>
          <p className="text-muted-foreground text-sm">
            loading your organizations...
          </p>
        </LoadingState>
      </Col>
    );
  }

  const memberships =
    userMemberships?.data || user?.organizationMemberships || [];

  if (!memberships.length) {
    return (
      <Col className="min-h-screen items-center justify-center">
        <div className="absolute top-6 right-6">
          <UserButton
            afterSignOutUrl={`/select-org?${searchParams.toString()}`}
          />
        </div>
        <Col className="text-center max-w-md mx-auto p-8 gap-8">
          <Col className="items-center gap-4">
            <KernelWordmark
              className="text-foreground"
              width={100}
              height={22}
            />
            <p className="text-muted-foreground text-sm">
              you need to be a member of at least one organization to continue.
            </p>
          </Col>
          <CreateOrganization
            afterCreateOrganizationUrl={(() => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("org_created", "true");
              return `/select-org?${params.toString()}`;
            })()}
            skipInvitationScreen={true}
          />
        </Col>
      </Col>
    );
  }

  const selectedOrg = memberships.find(
    (membership) => membership.organization.id === selectedOrgId,
  )?.organization;

  return (
    <Col className="min-h-screen items-center justify-center">
      <div className="absolute top-6 right-6">
        <UserButton
          afterSignOutUrl={`/select-org?${searchParams.toString()}`}
        />
      </div>

      <Col className="max-w-md w-full mx-auto p-8 gap-8">
        <Col className="items-center gap-3">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <p className="text-muted-foreground text-sm">
            {stage === "organization"
              ? "select an organization to authorize access."
              : `choose access for ${selectedOrg?.name || "this organization"}.`}
          </p>
        </Col>

        <div className="relative">
          <div
            ref={scrollContainerRef}
            onScroll={updateScrollState}
            className="flex flex-col gap-0 max-h-72 overflow-y-auto overscroll-y-none bg-[#faf9f2] border-[0.5px] border-[#e1dccf]"
          >
            {stage === "organization" ? (
              [...memberships]
                .sort((a, b) => {
                  if (a.organization.id === orgId) return -1;
                  if (b.organization.id === orgId) return 1;
                  return 0;
                })
                .map((membership, index, arr) => {
                  const organization = membership.organization;
                  const isSelected = organization.id === selectedOrgId;
                  return (
                    <button
                      key={organization.id}
                      onClick={() => setSelectedOrgId(organization.id)}
                      disabled={isSelecting}
                      className={`w-full p-4 text-left transition-colors cursor-pointer disabled:opacity-50 ${
                        index < arr.length - 1
                          ? "border-b-[0.5px] border-b-[#e1dccf]"
                          : ""
                      } ${isSelected ? "bg-primary/10" : "bg-[#faf9f2] hover:bg-primary/5"}`}
                    >
                      <Row className="gap-3">
                        {organization.imageUrl && (
                          <img
                            src={organization.imageUrl}
                            alt={organization.name}
                            className="w-10 h-10"
                          />
                        )}
                        <Col className="flex-1 gap-1">
                          <Row className="justify-between items-center">
                            <span className="font-light text-sm text-foreground">
                              {organization.name}
                            </span>
                            {organization.id === orgId && (
                              <span className="text-[10px] font-[350] uppercase border-[0.5px] border-foreground px-2 py-0.5">
                                active
                              </span>
                            )}
                          </Row>
                          <span className="text-xs text-muted-foreground">
                            {organization.slug}
                          </span>
                        </Col>
                      </Row>
                    </button>
                  );
                })
            ) : (
              <>
                <ScopeButton
                  label="entire organization"
                  detail="access every project and select projects per request"
                  selected={selectedScope === "organization"}
                  onClick={() => setSelectedScope("organization")}
                />
                {supportsProjectScope && (
                  <div className="p-3 border-b-[0.5px] border-b-[#e1dccf] bg-[#faf9f2]">
                    <input
                      type="search"
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      placeholder="search projects"
                      aria-label="search projects"
                      className="w-full bg-transparent border-[0.5px] border-[#e1dccf] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-foreground"
                    />
                  </div>
                )}
                {projects.map((project) => (
                  <ScopeButton
                    key={project.id}
                    label={project.name}
                    detail="access only this project"
                    selected={selectedScope === `project:${project.id}`}
                    onClick={() => setSelectedScope(`project:${project.id}`)}
                  />
                ))}
                {supportsProjectScope &&
                  isLoadingProjects &&
                  projects.length === 0 && (
                    <p className="p-4 text-xs text-muted-foreground">
                      loading projects...
                    </p>
                  )}
                {supportsProjectScope &&
                  !isLoadingProjects &&
                  projects.length === 0 &&
                  !hasMoreProjects &&
                  !projectsError && (
                    <p className="p-4 text-xs text-muted-foreground">
                      no projects found.
                    </p>
                  )}
                {supportsProjectScope && hasMoreProjects && (
                  <button
                    onClick={() => {
                      if (selectedOrgId && nextProjectOffset !== undefined) {
                        void loadProjectsPage({
                          organizationId: selectedOrgId,
                          query: projectQuery,
                          offset: nextProjectOffset,
                          append: true,
                        });
                      }
                    }}
                    disabled={isLoadingProjects}
                    className="w-full p-4 text-left text-sm text-foreground hover:bg-primary/5 disabled:opacity-50 cursor-pointer"
                  >
                    {isLoadingProjects ? "loading..." : "show more projects"}
                  </button>
                )}
              </>
            )}
          </div>
          {canScrollUp && (
            <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#faf9f2] to-transparent pointer-events-none" />
          )}
          {canScrollDown && (
            <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[#faf9f2] to-transparent pointer-events-none" />
          )}
        </div>

        {selectionError && (
          <p className="text-xs text-muted-foreground">{selectionError}</p>
        )}
        {stage === "scope" && projectsError && (
          <p className="text-xs text-muted-foreground">
            projects could not be loaded. organization-wide access is still
            available.
          </p>
        )}
        {stage === "scope" && !supportsProjectScope && (
          <p className="text-xs text-muted-foreground">
            this client does not support PKCE, so project-scoped access is
            unavailable.
          </p>
        )}

        <Row className="gap-3">
          {stage === "scope" && (
            <button
              onClick={() => setStage("organization")}
              disabled={isSelecting}
              className="border-[0.5px] border-foreground py-3 px-4 text-sm disabled:opacity-50 cursor-pointer"
            >
              back
            </button>
          )}
          <button
            onClick={
              stage === "organization" ? handleOrgConfirm : handleAuthorize
            }
            disabled={isSelecting || !selectedOrgId}
            className="flex-1 bg-foreground text-background py-3 px-4 font-[250] text-sm hover:underline disabled:opacity-50 cursor-pointer"
          >
            {isSelecting
              ? "loading..."
              : stage === "organization"
                ? "continue"
                : "authorize"}
          </button>
        </Row>
      </Col>
    </Col>
  );
}

function ScopeButton({
  label,
  detail,
  selected,
  onClick,
}: {
  label: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`w-full p-4 text-left border-b-[0.5px] last:border-b-0 border-b-[#e1dccf] cursor-pointer ${
        selected ? "bg-primary/10" : "bg-[#faf9f2] hover:bg-primary/5"
      }`}
    >
      <Col className="gap-1">
        <span className="font-light text-sm text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </Col>
    </button>
  );
}

function LoadingFallback(): React.ReactElement {
  return (
    <Col className="min-h-screen items-center justify-center">
      <LoadingState>
        <p className="text-muted-foreground text-sm">loading...</p>
      </LoadingState>
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
