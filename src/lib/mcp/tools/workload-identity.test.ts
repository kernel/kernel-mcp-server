import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { projectScopedAuthInfo } from '@/lib/mcp/auth-context.test-fixtures';
import { connectTestMcp, testMcpDependencies, toolResultJSON } from '@/lib/mcp/mcp-test-fixtures';
import { registerWorkloadIdentityCapabilities } from '@/lib/mcp/tools/workload-identity';

function page(items: unknown[] = []) {
  return {
    getPaginatedItems: () => items,
    has_more: false,
    next_offset: null,
  };
}

async function callWorkloadIdentity(kernelClient: unknown, args: Record<string, unknown>[]) {
  const { client, close } = await connectTestMcp(registerWorkloadIdentityCapabilities, kernelClient);
  try {
    const results = [];
    for (const call of args) {
      results.push(
        await client.callTool({
          name: 'manage_workload_identity',
          arguments: call,
        }),
      );
    }
    return results;
  } finally {
    await close();
  }
}

describe('manage_workload_identity SDK coverage', () => {
  test('advertises every resource action and nested input', async () => {
    const { client, close } = await connectTestMcp(registerWorkloadIdentityCapabilities, {});
    try {
      const tool = (await client.listTools()).tools.find(({ name }) => name === 'manage_workload_identity');
      expect(tool?.inputSchema.properties?.action).toMatchObject({
        enum: [
          'create_service_account',
          'list_service_accounts',
          'get_service_account',
          'update_service_account',
          'archive_service_account',
          'create_issuer',
          'list_issuers',
          'get_issuer',
          'update_issuer',
          'archive_issuer',
          'verify_issuer',
          'create_rule',
          'list_rules',
          'get_rule',
          'update_rule',
          'archive_rule',
          'list_authentication_events',
        ],
      });
      expect(tool?.description).toContain('signed-in user');
      expect(tool?.description).toContain('default disabled');
      expect(tool?.description).toContain('does not enable trust');
      expect(tool?.inputSchema.properties?.preset_type).toMatchObject({
        enum: ['github_actions', 'aws', 'google_cloud', 'microsoft_entra', 'kubernetes', 'custom_oidc'],
      });
      expect(tool?.inputSchema.properties?.jwks).toMatchObject({
        properties: {
          type: { enum: ['discovery', 'explicit_url', 'inline'] },
          keys: { maxItems: 16, minItems: 1 },
        },
      });
      expect(tool?.inputSchema.properties?.token_validation).toMatchObject({
        description: expect.stringContaining('independently of issued token ttl'),
        properties: {
          max_lifetime_seconds: { maximum: 86400, minimum: 1 },
          replay_protection: { enum: ['single_use', 'allow_reuse'] },
        },
      });
      expect(tool?.inputSchema.properties?.expected_version).toMatchObject({
        description: expect.stringContaining('authority security_version'),
      });
      expect(tool?.inputSchema.properties?.match).toMatchObject({
        properties: {
          claims: { maxProperties: 32 },
          event_names: { maxItems: 20, minItems: 1 },
        },
      });
      expect(tool?.inputSchema.properties?.max_token_ttl_seconds).toMatchObject({
        maximum: 600,
        minimum: 1,
        description: expect.stringContaining('default 300'),
      });
    } finally {
      await close();
    }
  });

  test('forwards all service account actions, including empty text and offset zero', async () => {
    const calls: unknown[] = [];
    const results = await callWorkloadIdentity(
      {
        serviceAccounts: {
          create: async (body: unknown) => {
            calls.push(['create', body]);
            return { id: 'svc_1', last_used_at: null };
          },
          list: async (query: unknown) => {
            calls.push(['list', query]);
            return page([{ id: 'svc_1' }]);
          },
          retrieve: async (id: string) => {
            calls.push(['get', id]);
            return { id };
          },
          update: async (id: string, body: unknown) => {
            calls.push(['update', id, body]);
            return { id };
          },
          delete: async (id: string) => {
            calls.push(['archive', id]);
          },
        },
      },
      [
        {
          action: 'create_service_account',
          name: 'worker-1',
          description: '',
        },
        {
          action: 'list_service_accounts',
          query: 'worker',
          status: 'all',
          limit: 1,
          offset: 0,
        },
        { action: 'get_service_account', id: 'svc_1' },
        {
          action: 'update_service_account',
          id: 'svc_1',
          expected_version: 1,
          name: 'worker-2',
          description: '',
        },
        { action: 'archive_service_account', id: 'svc_1' },
      ],
    );

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(calls).toEqual([
      ['create', { name: 'worker-1', description: '' }],
      ['list', { query: 'worker', status: 'all', limit: 1, offset: 0 }],
      ['get', 'svc_1'],
      ['update', 'svc_1', { expected_version: 1, name: 'worker-2', description: '' }],
      ['archive', 'svc_1'],
    ]);
    expect(toolResultJSON(results[0])).toMatchObject({
      id: 'svc_1',
      last_used_at: null,
    });
  });

  test('forwards issuer fields and preserves false filters', async () => {
    const calls: unknown[] = [];
    const jwks = {
      type: 'inline',
      ca_cert_pem: 'PUBLIC CA',
      keys: [{ kty: 'RSA', kid: 'key-1', n: 'public', e: 'AQAB' }],
    };
    const tokenValidation = {
      max_lifetime_seconds: 3600,
      replay_protection: 'allow_reuse',
    };

    const results = await callWorkloadIdentity(
      {
        workloadIdentityIssuers: {
          create: async (body: unknown) => {
            calls.push(['create', body]);
            return { id: 'iss_1' };
          },
          list: async (query: unknown) => {
            calls.push(['list', query]);
            return page();
          },
          retrieve: async (id: string) => {
            calls.push(['get', id]);
            return { id };
          },
          update: async (id: string, body: unknown) => {
            calls.push(['update', id, body]);
            return { id };
          },
          delete: async (id: string) => {
            calls.push(['archive', id]);
          },
          verify: async (id: string) => {
            calls.push(['verify', id]);
            return { issuer_id: id, key_ids: ['key-1'] };
          },
        },
      },
      [
        {
          action: 'create_issuer',
          name: 'github-main',
          description: 'GitHub issuer',
          enabled: false,
          issuer_url: 'https://token.actions.githubusercontent.com',
          preset_type: 'github_actions',
          jwks,
          token_validation: tokenValidation,
        },
        {
          action: 'list_issuers',
          enabled: false,
          query: 'github',
          status: 'active',
          limit: 20,
          offset: 0,
        },
        { action: 'get_issuer', id: 'iss_1' },
        {
          action: 'update_issuer',
          id: 'iss_1',
          expected_version: 2,
          description: '',
          enabled: false,
          issuer_url: 'https://issuer.example.com',
          preset_type: 'custom_oidc',
          jwks: {
            type: 'explicit_url',
            url: 'https://issuer.example.com/jwks.json',
          },
          token_validation: {
            max_lifetime_seconds: 1,
            replay_protection: 'single_use',
          },
        },
        { action: 'verify_issuer', id: 'iss_1' },
        { action: 'archive_issuer', id: 'iss_1' },
      ],
    );

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(calls).toEqual([
      [
        'create',
        {
          name: 'github-main',
          description: 'GitHub issuer',
          enabled: false,
          issuer_url: 'https://token.actions.githubusercontent.com',
          preset_type: 'github_actions',
          jwks,
          token_validation: tokenValidation,
        },
      ],
      [
        'list',
        {
          enabled: false,
          query: 'github',
          status: 'active',
          limit: 20,
          offset: 0,
        },
      ],
      ['get', 'iss_1'],
      [
        'update',
        'iss_1',
        {
          expected_version: 2,
          description: '',
          enabled: false,
          issuer_url: 'https://issuer.example.com',
          preset_type: 'custom_oidc',
          jwks: {
            type: 'explicit_url',
            url: 'https://issuer.example.com/jwks.json',
          },
          token_validation: {
            max_lifetime_seconds: 1,
            replay_protection: 'single_use',
          },
        },
      ],
      ['verify', 'iss_1'],
      ['archive', 'iss_1'],
    ]);
  });

  test('constructs rule nesting and forwards rule/event filters', async () => {
    const calls: unknown[] = [];
    const policy = {
      statements: [
        {
          action: 'browsers:use',
          resource: 'projects/proj_1/browsers/*',
          condition: {
            key: 'source_ip',
            operator: 'in',
            values: ['203.0.113.0/24'],
          },
        },
      ],
    };
    const match = {
      type: 'github_actions',
      subject: 'repo:kernel/example:ref:refs/heads/main',
      claims: { '/repository_visibility': 'private' },
      repository: 'kernel/example',
      repository_id: '123',
      repository_owner_id: '456',
      workflow: 'deploy.yml',
      workflow_ref: 'kernel/example/.github/workflows/deploy.yml@refs/heads/main',
      job_workflow_ref: 'kernel/shared/.github/workflows/deploy.yml@refs/heads/main',
      ref: 'refs/heads/main',
      environment: 'production',
      event_names: ['push'],
    };

    const results = await callWorkloadIdentity(
      {
        workloadIdentityFederationRules: {
          create: async (body: unknown) => {
            calls.push(['create', body]);
            return { id: 'rule_1' };
          },
          list: async (query: unknown) => {
            calls.push(['list', query]);
            return page();
          },
          retrieve: async (id: string) => {
            calls.push(['get', id]);
            return { id };
          },
          update: async (id: string, body: unknown) => {
            calls.push(['update', id, body]);
            return { id };
          },
          delete: async (id: string) => {
            calls.push(['archive', id]);
          },
        },
        workloadIdentityAuthenticationEvents: {
          list: async (query: unknown) => {
            calls.push(['events', query]);
            return page([{ id: 'event_1', outcome: 'failure' }]);
          },
        },
      },
      [
        {
          action: 'create_rule',
          name: 'github-deploy',
          description: 'Deploy from main',
          enabled: false,
          issuer_id: 'iss_1',
          match,
          expected_audience: 'https://auth.onkernel.com',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          policy,
          token_audience: 'https://api.onkernel.com',
          max_token_ttl_seconds: 1,
        },
        {
          action: 'list_rules',
          issuer_id: 'iss_1',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          query: 'deploy',
          status: 'all',
          limit: 5,
          offset: 0,
        },
        { action: 'get_rule', id: 'rule_1' },
        {
          action: 'update_rule',
          id: 'rule_1',
          expected_version: 3,
          description: '',
          enabled: false,
          issuer_id: 'iss_2',
          match: { type: 'custom_oidc', subject_prefix: 'build:' },
          expected_audience: 'kernel-ci',
          service_account_id: 'svc_2',
          project_id: 'proj_2',
          policy,
          token_audience: 'https://api.onkernel.com',
          max_token_ttl_seconds: 600,
        },
        { action: 'archive_rule', id: 'rule_1' },
        {
          action: 'list_authentication_events',
          issuer_id: 'iss_1',
          federation_rule_id: 'rule_1',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          outcome: 'failure',
          start_time: '2026-11-01T00:00:00Z',
          end_time: '2026-11-02T00:00:00Z',
          limit: 100,
          offset: 0,
        },
      ],
    );

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(calls).toEqual([
      [
        'create',
        {
          name: 'github-deploy',
          issuer_id: 'iss_1',
          match,
          expected_audience: 'https://auth.onkernel.com',
          target: {
            type: 'service_account',
            service_account_id: 'svc_1',
          },
          authorization: {
            project_id: 'proj_1',
            policy,
            token_audience: 'https://api.onkernel.com',
            max_token_ttl_seconds: 1,
          },
          description: 'Deploy from main',
          enabled: false,
        },
      ],
      [
        'list',
        {
          issuer_id: 'iss_1',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          query: 'deploy',
          status: 'all',
          limit: 5,
          offset: 0,
        },
      ],
      ['get', 'rule_1'],
      [
        'update',
        'rule_1',
        {
          expected_version: 3,
          description: '',
          enabled: false,
          issuer_id: 'iss_2',
          match: { type: 'custom_oidc', subject_prefix: 'build:' },
          expected_audience: 'kernel-ci',
          target: {
            type: 'service_account',
            service_account_id: 'svc_2',
          },
          authorization: {
            project_id: 'proj_2',
            policy,
            token_audience: 'https://api.onkernel.com',
            max_token_ttl_seconds: 600,
          },
        },
      ],
      ['archive', 'rule_1'],
      [
        'events',
        {
          issuer_id: 'iss_1',
          federation_rule_id: 'rule_1',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          outcome: 'failure',
          start_time: '2026-11-01T00:00:00Z',
          end_time: '2026-11-02T00:00:00Z',
          limit: 100,
          offset: 0,
        },
      ],
    ]);
    expect(toolResultJSON(results[5])).toEqual({
      items: [{ id: 'event_1', outcome: 'failure' }],
      has_more: false,
      next_offset: null,
    });
  });

  test('rejects missing, unrelated, and partial nested inputs before the SDK', async () => {
    let calls = 0;
    const record = async () => {
      calls++;
      return {};
    };

    const results = await callWorkloadIdentity(
      {
        serviceAccounts: { list: record },
        workloadIdentityFederationRules: {
          create: record,
          update: record,
        },
      },
      [
        { action: 'create_rule', name: 'incomplete' },
        {
          action: 'update_rule',
          id: 'rule_1',
          expected_version: 1,
          max_token_ttl_seconds: 300,
        },
        {
          action: 'list_service_accounts',
          description: 'does not apply',
        },
        {
          action: 'create_rule',
          name: 'bad-match',
          issuer_id: 'iss_1',
          match: { type: 'github_actions', repository_id: 'not-numeric' },
          expected_audience: 'audience',
          service_account_id: 'svc_1',
          project_id: 'proj_1',
          policy: {
            statements: [{ action: 'browsers:use', resource: '*' }],
          },
          token_audience: 'https://api.onkernel.com',
        },
      ],
    );

    for (const result of results) expect(result.isError).toBe(true);
    expect(calls).toBe(0);
    expect(results[1].content).toEqual([
      {
        type: 'text',
        text: 'error: changing rule authorization requires project_id, policy, and token_audience together.',
      },
    ]);
    expect(results[2].content).toEqual([
      {
        type: 'text',
        text: 'error: description does not apply to list_service_accounts.',
      },
    ]);
  });

  test('rejects API-key and workload-identity MCP credentials locally', async () => {
    const server = new McpServer({ name: 'test', version: '0' });
    let created = false;
    registerWorkloadIdentityCapabilities(
      server,
      testMcpDependencies({
        serviceAccounts: {
          list: async () => {
            created = true;
            return page();
          },
        },
      }),
    );
    const client = new Client({ name: 'test-client', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          ...projectScopedAuthInfo(),
          scopes: ['apikey'],
        },
      });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: 'manage_workload_identity',
        arguments: { action: 'list_service_accounts' },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: 'text',
          text: 'error: manage_workload_identity requires a signed-in user session; API keys and workload identity credentials are not accepted.',
        },
      ]);
      expect(created).toBe(false);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
