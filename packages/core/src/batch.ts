/** OData JSON-batch types (POST <route>/$batch). */

export interface BatchRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /**
   * URL relative to the route root, e.g. `companies({company})/customers?$top=5`.
   * The `{company}` token is replaced with the resolved company GUID.
   */
  url: string;
  /** Correlation id; assigned automatically ("1", "2", …) when omitted. */
  id?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Requests sharing a group commit or roll back together. */
  atomicityGroup?: string;
  /** Ids of requests that must complete before this one runs. */
  dependsOn?: string[];
}

export interface BatchResponse {
  id: string;
  status: number;
  /** true when status < 400 */
  ok: boolean;
  headers?: Record<string, string>;
  body?: unknown;
}
