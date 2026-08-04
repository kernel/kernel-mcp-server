export type JsonObject = Record<string, unknown>;

export type SafeConnection = {
  id: string;
  domain: string;
  profile_name: string;
  status: "AUTHENTICATED" | "NEEDS_AUTH";
  flow_status:
    | "IN_PROGRESS"
    | "SUCCESS"
    | "FAILED"
    | "EXPIRED"
    | "CANCELED"
    | null;
  flow_type: "LOGIN" | "REAUTH" | null;
  flow_expires_at: string | null;
  error_code: string | null;
};

export type ToolAction = {
  tool?: string;
  arguments?: JsonObject;
};

export type BeginResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: {
    state?: string;
    connection?: SafeConnection;
    started_new_flow?: boolean;
    resume_id?: string;
    next_action?: ToolAction;
    app_private?: {
      handoff_code?: string;
      hosted_url?: string;
      relay_base_url?: string;
    };
  };
  _meta?: {
    auth_login?: {
      handoff_code?: string;
      hosted_url?: string;
      relay_base_url?: string;
    };
  };
  isError?: boolean;
};

export type WaitToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: {
    state?: "authenticated" | "failed" | "pending";
    connection?: SafeConnection | null;
  };
  isError?: boolean;
};

export type LauncherResult = {
  structuredContent?: {
    connection?: { domain?: string; profile_name?: string };
    next_action?: ToolAction;
  };
};
