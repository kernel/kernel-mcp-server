import React, { type ReactNode } from "react";
import {
  AppearanceProvider,
  LocalizationProvider,
  Shell,
  StepError,
  StepExpired,
  StepPrime,
  StepSuccess,
} from "@onkernel/managed-auth-react";
import { failureTerminalView } from "./managed-auth-terminal";
import type { SafeConnection } from "./managed-auth-types";

type Appearance = {
  theme: "light" | "dark" | "auto";
  layout: { skipPrimeStep: boolean };
};

function AppShell({
  appearance,
  children,
}: {
  appearance: Appearance;
  children: ReactNode;
}) {
  return (
    <AppearanceProvider appearance={appearance}>
      <LocalizationProvider>
        <Shell appearance={appearance}>{children}</Shell>
      </LocalizationProvider>
    </AppearanceProvider>
  );
}

export function ConsentView({
  appearance,
  targetDomain,
  starting,
  status,
  onContinue,
}: {
  appearance: Appearance;
  targetDomain: string;
  starting: boolean;
  status: string;
  onContinue: () => void;
}) {
  return (
    <AppShell appearance={appearance}>
      <StepPrime
        targetDomain={targetDomain}
        onContinue={onContinue}
        isLoading={starting}
      />
      {status && <p className="kernel-app-status">{status}</p>}
    </AppShell>
  );
}

export function TerminalView({
  appearance,
  targetDomain,
  outcome,
  connection,
  onClose,
}: {
  appearance: Appearance;
  targetDomain: string;
  outcome: "success" | "failure";
  connection: SafeConnection | null;
  onClose: () => void;
}) {
  const failure =
    outcome === "failure"
      ? failureTerminalView(connection?.flow_status, connection?.error_code)
      : null;
  return (
    <AppShell appearance={appearance}>
      {outcome === "success" ? (
        <StepSuccess targetDomain={targetDomain} />
      ) : failure?.step === "expired" ? (
        <StepExpired />
      ) : (
        <StepError targetDomain={targetDomain} errorCode={failure?.errorCode} />
      )}
      <div className="kernel-app-actions">
        <p className="kernel-app-status">
          {outcome === "success"
            ? "Connection status saved for Claude’s next turn."
            : "Failure status saved for Claude’s next turn."}
        </p>
        <button className="kernel-app-button" onClick={onClose}>
          Close panel
        </button>
      </div>
    </AppShell>
  );
}

export function MessageView({
  appearance,
  title,
  message,
  action,
}: {
  appearance: Appearance;
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <AppShell appearance={appearance}>
      <div className="kernel-app-fallback">
        <h2>{title}</h2>
        <p>{message}</p>
        {action && (
          <button className="kernel-app-button" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </AppShell>
  );
}
