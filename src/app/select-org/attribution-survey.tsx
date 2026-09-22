"use client";

import { useState } from "react";
import { Col } from "@/components/col";
import { saveOAuthAttribution } from "./actions";
import type { ConnectorTrigger, DiscoverySource } from "./attribution";

const discoveryChoices: Array<{ value: DiscoverySource; label: string }> = [
  {
    value: "ai_answer",
    label: "chatgpt, claude, perplexity, or another ai answer",
  },
  { value: "search_engine", label: "google or another search engine" },
  { value: "social_or_content", label: "social media or content" },
  { value: "friend_or_coworker", label: "friend or coworker" },
  { value: "existing_user", label: "already used KERNEL" },
  { value: "other", label: "other" },
];

const triggerChoices: Array<{ value: ConnectorTrigger; label: string }> = [
  {
    value: "claude_suggestion",
    label: "claude suggested KERNEL while completing a task",
  },
  {
    value: "claude_connector_directory",
    label: "found KERNEL in claude's connector directory",
  },
  { value: "kernel_documentation", label: "followed KERNEL documentation" },
  {
    value: "manual_connector_url",
    label: "manually entered the connector url",
  },
  {
    value: "product_or_template",
    label: "another product or template configured it",
  },
  { value: "other", label: "other" },
];

interface AttributionSurveyProps {
  onSaved: () => void;
  oauthClientId?: string;
  oauthRedirectUri?: string;
}

export function AttributionSurvey({
  onSaved,
  oauthClientId,
  oauthRedirectUri,
}: AttributionSurveyProps): React.ReactElement {
  const [firstDiscoverySource, setFirstDiscoverySource] =
    useState<DiscoverySource>();
  const [connectorTrigger, setConnectorTrigger] = useState<ConnectorTrigger>();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (!firstDiscoverySource || !connectorTrigger || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      const result = await saveOAuthAttribution({
        firstDiscoverySource,
        connectorTrigger,
        oauthClientId,
        oauthRedirectUri,
      });
      if (!result.success) {
        setError("could not save your answers. please try again.");
        return;
      }
      onSaved();
    } catch (saveError) {
      console.error("Failed to save OAuth attribution:", saveError);
      setError("could not save your answers. please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full text-left">
      <Col className="gap-8">
        <ChoiceGroup
          legend="how did you first hear about KERNEL?"
          name="first-discovery-source"
          choices={discoveryChoices}
          value={firstDiscoverySource}
          onChange={setFirstDiscoverySource}
        />
        <ChoiceGroup
          legend="what prompted you to connect KERNEL today?"
          name="connector-trigger"
          choices={triggerChoices}
          value={connectorTrigger}
          onChange={setConnectorTrigger}
        />
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!firstDiscoverySource || !connectorTrigger || isSaving}
          className="w-full border-[0.5px] border-foreground bg-primary px-4 py-3 text-sm cursor-pointer hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "saving..." : "continue"}
        </button>
      </Col>
    </form>
  );
}

function ChoiceGroup<T extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  choices: Array<{ value: T; label: string }>;
  value?: T;
  onChange: (value: T) => void;
}): React.ReactElement {
  return (
    <fieldset>
      <legend className="mb-3 text-sm">{legend}</legend>
      <Col className="gap-2">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className="flex cursor-pointer items-start gap-3 border-[0.5px] border-foreground p-3 text-sm has-checked:bg-secondary"
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
              className="mt-0.5 accent-primary"
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </Col>
    </fieldset>
  );
}
