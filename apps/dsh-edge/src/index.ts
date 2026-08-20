import { getWorkspace } from '@cloudflare/computer'
import type { EdgeShellResult } from './agent.ts'
import {
  handleOwnerAuthRoute,
  loginRedirect,
  OWNER_SESSION_EXPIRY_HEADER,
  resolveOwnerAuthConfig,
  resolveOwnerSession,
  unauthorizedResponse,
} from './auth.ts'
import {
  EdgeHttpError,
  MAX_SESSION_CREATE_BODY_BYTES,
  MAX_TURN_BODY_BYTES,
  MAX_WORKSPACE_EXEC_BODY_BYTES,
  corsHeaders,
  discardUnreadRequestBody,
  errorResponse,
  jsonResponse,
  readBoundedBody,
  readBoundedText,
  readJsonObject,
} from './http.ts'
import type { EdgeEnv } from './instance.ts'
import { resolveEdgeDeploymentHealth } from './deployment.ts'
import {
  executeWorkspaceCommand,
  MAX_TEXT_FILE_BYTES,
  readBoundedWorkspaceFile,
  requireCommand,
  requireWorkspacePath,
  resolveEdgeCommandTimeoutPolicy,
} from './workspace.ts'

// The optional isolated shell reaches the owning Durable Object through these entrypoints.
export { WorkspaceProxy, WorkspaceServiceProxy } from '@cloudflare/computer'
export { DshEdgeInstance } from './instance.ts'

type Env = EdgeEnv

const OWNER_INSTANCE = 'owner'

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      })
    }

    try {
      const url = new URL(request.url)
      const auth = resolveOwnerAuthConfig(env.DSH_EDGE_ACCESS_KEY)
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return jsonResponse(resolveEdgeDeploymentHealth(env))
      }

      const authResponse = await handleOwnerAuthRoute(request, auth)
      if (authResponse !== undefined) return authResponse

      const ownerSession = await resolveOwnerSession(request, auth)
      if (url.pathname === '/') {
        if (ownerSession === undefined) return loginRedirect()
        return await env.ASSETS.fetch(request)
      }
      if (ownerSession === undefined) return unauthorizedResponse()

      rejectCrossOriginAuthenticatedRequest(request, url)
      rejectLegacyInstanceSelector(request, url)
      const instanceStub = env.DSH_EDGE_INSTANCE.getByName(OWNER_INSTANCE)
      if (isInstanceApiPath(url.pathname)) {
        const response = await instanceStub.fetch(
          await requestForInstance(request, ownerSession.expiresAt),
        )
        if (response.webSocket !== null) return response
        const headers = new Headers(response.headers)
        for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value)
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }
      using workspace = await getWorkspace(
        instanceStub as unknown as Parameters<typeof getWorkspace>[0],
      )

      if (url.pathname === '/api/workspace/file') {
        const path = resolveWorkspacePath(url)
        if (request.method === 'GET') {
          const contents = await readBoundedWorkspaceFile(workspace.fs, path)
          return new Response(contents, {
            headers: {
              ...corsHeaders(),
              'content-type': 'text/plain; charset=utf-8',
            },
          })
        }
        if (request.method === 'PUT') {
          const contents = await readBoundedText(
            request,
            MAX_TEXT_FILE_BYTES,
            'Text files are limited to 1 MiB in the prototype API.',
          )
          await workspace.fs.mkdir(parentDirectory(path), { recursive: true })
          await workspace.fs.writeFile(path, contents)
          return jsonResponse({ ok: true, path })
        }
        if (request.method === 'DELETE') {
          await workspace.fs.rm(path, { recursive: false })
          return jsonResponse({ ok: true, path })
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace/exec') {
        const body = await readJsonObject(request, MAX_WORKSPACE_EXEC_BODY_BYTES)
        const command = requireCommand(body.command)
        const cwd = requireWorkspacePath(body.cwd ?? '/workspace')
        const timeoutPolicy = resolveEdgeCommandTimeoutPolicy(
          env.DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS,
          env.DSH_EDGE_MAX_COMMAND_TIMEOUT_MS,
        )
        const result = await executeWorkspaceCommand(workspace, command, cwd, timeoutPolicy)
        return jsonResponse({
          executionId: result.executionId,
          status: result.status,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          outputTruncated: result.outputTruncated,
        } satisfies EdgeShellResult)
      }

      throw new EdgeHttpError(404, 'Route not found.')
    } catch (error) {
      await discardUnreadRequestBody(request)
      return errorResponse(error)
    }
  },
} satisfies ExportedHandler<Env>

function rejectLegacyInstanceSelector(request: Request, url: URL): void {
  if (request.headers.has('x-dsh-edge-instance') || url.searchParams.has('instance')) {
    throw new EdgeHttpError(400, 'This deployment has one owner workspace; instance selectors are not supported.')
  }
}

function rejectCrossOriginAuthenticatedRequest(request: Request, url: URL): void {
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) {
    throw new EdgeHttpError(403, 'Cross-origin authenticated requests are not allowed.')
  }
}

function resolveWorkspacePath(url: URL): string {
  return requireWorkspacePath(url.searchParams.get('path'))
}

async function requestForInstance(request: Request, ownerSessionExpiresAt: number): Promise<Request> {
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('authorization')
  headers.delete('x-dsh-edge-instance')
  headers.set(OWNER_SESSION_EXPIRY_HEADER, String(ownerSessionExpiresAt))
  if (request.body === null) return new Request(request, { headers })
  const url = new URL(request.url)
  const maxBytes = url.pathname.endsWith('/turn')
    || url.pathname === '/api/session.prompt'
    || url.pathname === '/api/session.updateQueue'
    ? MAX_TURN_BODY_BYTES
    : MAX_SESSION_CREATE_BODY_BYTES
  const body = await readBoundedBody(
    request,
    maxBytes,
    `Session request bodies are limited to ${maxBytes} bytes.`,
  )
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
  })
}

function isInstanceApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
    && pathname !== '/api/health'
    && pathname !== '/api/workspace/file'
    && pathname !== '/api/workspace/exec'
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator <= 0 ? '/' : path.slice(0, separator)
}
