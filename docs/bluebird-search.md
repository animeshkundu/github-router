# Bluebird code search

`github-router claude --bluebird` routes the unified `code` tool's `semantic` and
`lexical` modes to the Bluebird MCP service. The local engine continues to own
`exact`, `regex`, and `ast` modes.

Bluebird and local ColBERT search are independent:

| Launch flags | Semantic | Lexical | Exact / regex / AST | Local ColBERT provisioning |
| --- | --- | --- | --- | --- |
| none | Local lexical fallback | Local | Local | No |
| `--search` | Local ColBERT, with lexical fallback | Local | Local | Yes |
| `--bluebird` | Bluebird semantic | Bluebird keyword | Local | No |
| `--bluebird --search` | Bluebird semantic | Bluebird keyword | Local | Yes |

When Bluebird owns a request, authentication, HTTP, JSON-RPC, MCP tool, and
response-shape failures are returned as `source: "error"`. They never silently
fall back to local search. Calls are bounded and cancellation-aware. Concurrent
callers share provisioning, initialization, token refresh, and expired-session
recovery, while one caller cancelling its wait does not cancel work needed by
other callers. Process shutdown aborts pending provisioning and MCP reads and
performs best-effort session teardown.

## Authentication and scope

The router obtains an Azure access token through Azure CLI for the Azure DevOps
resource. An operator may provide `BLUEBIRD_TOKEN` for controlled testing, but
the router strips that variable from Claude, Codex, and their descendants. Tokens
must never be logged, placed in request examples, or committed to fixtures.

The query workspace must be an absolute, accessible directory. Its local Git
remotes supply exactly one Azure DevOps organization, project, and repository
scope. Fetch and push entries for the same remote are collapsed. An Azure
`origin` fetch target is preferred; conflicting Azure `origin` targets are an
error. Without an Azure `origin`, exactly one distinct Azure repository is
accepted and multiple candidates are rejected as ambiguous. The router never
chooses the first remote arbitrarily and never broadens scope to other
repositories in the same project. The examples below use fictional names and
content.

Branch scope is also fail-closed. A normal checkout first probes whether its
current branch is indexed. Only a successful probe proving that branch absent
may trigger default-branch lookup. HTTP/authentication errors, malformed probe
responses, transport failures, timeouts, cancellation, Git failures, and Azure
CLI default-branch failures remain visible. Detached HEAD is the one case that
uses the default branch without a current-branch probe.

## MCP transport

Endpoint:

```text
https://mcp.bluebird-ai.net/
```

Common request headers:

```http
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
Authorization: Bearer <redacted Azure access token>
x-mcp-ec-organization: example-org
x-mcp-ec-project: example-project
x-mcp-ec-repository: example-repository
x-mcp-ec-branch: main
Mcp-Session-Id: <opaque session id, only when supplied by the server>
```

The client performs this sequence:

1. `initialize`
2. `notifications/initialized`
3. `tools/list`
4. `tools/call`

A server may be stateless and omit `Mcp-Session-Id`. Responses may be JSON or
SSE. Notification responses may have an empty body and status `202` or `204`.

### Initialize request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {
      "name": "github-router",
      "version": "bluebird"
    }
  }
}
```

Example response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "example-bluebird-server",
      "version": "1.0.0"
    }
  }
}
```

### Initialized notification

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

### Tool discovery

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

The relevant deployed tool has this redacted, non-proprietary shape:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "code_search",
        "description": "Search indexed source code.",
        "inputSchema": {
          "type": "object",
          "required": ["method", "query"],
          "properties": {
            "method": {
              "type": "string",
              "enum": ["keyword", "semantic"]
            },
            "query": {
              "type": "string"
            },
            "search_index": {
              "type": "string",
              "enum": ["General", "File", "Class", "Struct", "Function", "Macro"],
              "default": "General"
            },
            "organization": { "type": "string" },
            "project": { "type": "string" },
            "repository": { "type": "string" },
            "branch": { "type": "string" },
            "ext": { "type": "string" },
            "path": { "type": "string" },
            "file": { "type": "string" },
            "limit": { "type": "integer" }
          }
        }
      }
    ]
  }
}
```

The client reads the advertised schema rather than assuming optional fields.
For compatibility, it may use the legacy `do_vector_search` and
`search_file_content` tools only when both are advertised and `code_search` is
absent.

## Search requests

### Semantic

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "code_search",
    "arguments": {
      "method": "semantic",
      "query": "service that refreshes account sessions",
      "search_index": "General",
      "limit": 3
    }
  }
}
```

### Lexical

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "code_search",
    "arguments": {
      "method": "keyword",
      "query": "SessionRefreshService",
      "limit": 3
    }
  }
}
```

`file_glob` is sent only when the advertised upstream schema contains an
explicit compatible glob field. It is not translated heuristically to `path` or
`file`, whose semantics differ.

## Search responses

A normal MCP tool result wraps one or more text blocks:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "[{\"SimilaritySearchResult\":[{\"node_name\":\"SessionRefreshService\",\"node_file_path\":\"/src/session-refresh.ts\",\"code_startRow\":12,\"code_endRow\":84,\"page_content\":\"Refreshes an account session.\",\"similarity_score\":0.73}]}]"
      }
    ],
    "isError": false
  }
}
```

Semantic results use `SimilaritySearchResult`. Keyword results use
`FullTextSearchResult`:

```json
[
  {
    "FullTextSearchResult": [
      {
        "node_name": "/src/session-refresh.ts",
        "node_file_path": "/src/session-refresh.ts",
        "page_content": "Line 12: export class SessionRefreshService {",
        "match_count": 1,
        "total_matches": 1
      }
    ]
  }
]
```

The service can append human-readable guidance after the JSON value. The client
parses the leading JSON value and does not interpret the suffix as a result row.
An empty JSON array is a valid successful search with no hits. A malformed
wrapper is an error, not an empty result.

Normalized rows returned to the unified search layer have this shape:

```json
{
  "file": "src/session-refresh.ts",
  "line": 12,
  "endLine": 84,
  "name": "SessionRefreshService",
  "snippet": "Refreshes an account session.",
  "score": 0.73
}
```

Remote paths are normalized to repository-relative forward-slash paths. Drive
paths, UNC paths, NUL bytes, and parent-directory traversal are rejected.

Structural outlines are included by default for the returned files and augment,
rather than replace, these rows. Pass `summary: false` to omit outlines.
`scan: true` still requests a full-workspace structural map independently of
that result-summary setting.

## Error envelopes

JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32602,
    "message": "Invalid tool arguments"
  }
}
```

MCP tool-level error:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "The search request could not be completed."
      }
    ],
    "isError": true
  }
}
```

The router preserves the distinction between HTTP failures, JSON-RPC errors,
and MCP `isError` results while exposing an actionable, credential-free notice
to the caller.

## Testing policy

Unit and end-to-end tests must not call the real Bluebird endpoint, Azure DevOps,
or a real repository. Tests inject a fictional MCP URL, mock `fetch`, and use
synthetic paths, queries, snippets, session IDs, and tool schemas. Live Bluebird
checks are manual, read-only validation steps and must never print or inspect the
Azure access token.
