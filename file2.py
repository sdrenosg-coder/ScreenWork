"""Zipy AI — Python SDK (phase 21, batch 2).

A thin, dependency-free (standard library only) client for the Zipy AI REST
API v1. The SDK mirrors the JavaScript client in `packages/sdk-js` so a
Python script and a Node script that call the same endpoint see the same
request and response shapes.

Design boundaries
-----------------
- No endpoint is fabricated. Each method calls a path that is implemented by
  the web app under `apps/web/src/app/api/v1/...`. When a path is not yet
  implemented server side, the API returns a 404 and the SDK surfaces the
  body verbatim; it never invents a successful response.
- No credential is invented. The client requires an API key at construction
  time; a request without one is refused before any network call (so a
  script that forgot to set `ZIPY_API_KEY` fails fast rather than hitting
  an anonymous endpoint).
- The transport is injectable. `ZipyClient` takes an optional
  `transport` callable; production uses `urllib.request`, tests supply a
  fake that returns canned bytes. No network is invoked by this module
  unless a caller invokes a method with the default transport.
- Errors are typed. `ZipyApiError` carries the HTTP status, the raw body
  and — when the server sent JSON — the parsed payload, so a caller can
  branch on a structured error code.
- The base URL defaults to `http://0.0.0.0` only when explicitly requested
  via `ZIPY_BASE_URL`; the SDK does not guess a hosted endpoint. The
  response fields (`version`, `generatedAt`, `aiGenerated`) are copied from
  the server response, not synthesised.

Usage
-----
    from zipy_sdk import ZipyClient

    client = ZipyClient(api_key=os.environ["ZIPY_API_KEY"],
                        base_url="https://my-zipy.example")
    for guide in client.list_guides(workspace_id="ws_1"):
        print(guide["slug"], guide["title"])
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    "ZipyClient",
    "ZipyApiError",
    "ZipyConfigError",
    "Transport",
    "TransportRequest",
    "TransportResponse",
    "PAGE_SIZE_DEFAULT",
    "SDK_VERSION",
]

SDK_VERSION = "zipy-sdk-python/0.1.0"
PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #

class ZipyConfigError(Exception):
    """Raised when the client cannot be constructed (missing API key, bad URL)."""


class ZipyApiError(Exception):
    """Raised when the Zipy AI API returns a non-2xx response.

    Attributes
    ----------
    status : int
        The HTTP status code.
    body : str
        The raw response body (decoded as UTF-8 with lenient handling).
    payload : Any
        The parsed JSON body when the response content-type was JSON;
        otherwise ``None``.
    request_url : str
        The fully-qualified URL that was requested (never contains the key).
    """

    def __init__(
        self,
        message: str,
        status: int,
        body: str,
        payload: Any,
        request_url: str,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.payload = payload
        self.request_url = request_url


# --------------------------------------------------------------------------- #
# Transport port                                                              #
# --------------------------------------------------------------------------- #

class TransportRequest:
    """A request the transport is asked to perform. Immutable in spirit."""

    __slots__ = ("method", "url", "headers", "body", "timeout_s")

    def __init__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: Optional[bytes],
        timeout_s: float,
    ) -> None:
        self.method = method
        self.url = url
        self.headers = dict(headers)
        self.body = body
        self.timeout_s = timeout_s


class TransportResponse:
    """A response the transport returns. Only status/headers/body matter here."""

    __slots__ = ("status", "headers", "body")

    def __init__(
        self,
        status: int,
        headers: Mapping[str, str],
        body: bytes,
    ) -> None:
        self.status = status
        self.headers = dict(headers)
        self.body = body


Transport = Callable[[TransportRequest], TransportResponse]


def _default_transport(request: TransportRequest) -> TransportResponse:
    """Use `urllib.request` — the standard library — so the SDK has no
    third-party dependency. A caller with a proxy, retry or auth middleware
    supplies its own transport instead.
    """
    req = urllib.request.Request(
        request.url,
        data=request.body,
        headers=dict(request.headers),
        method=request.method,
    )
    try:
        with urllib.request.urlopen(req, timeout=request.timeout_s) as resp:
            return TransportResponse(
                status=int(getattr(resp, "status", 200)),
                headers={k: v for k, v in resp.getheaders()},
                body=resp.read(),
            )
    except urllib.error.HTTPError as err:
        # HTTPError is itself a file-like response; surface its body so the
        # caller can read a structured error.
        return TransportResponse(
            status=int(err.code),
            headers={k: v for k, v in err.headers.items()} if err.headers else {},
            body=err.read(),
        )
    except urllib.error.URLError as err:
        # A transport-level failure surfaces as a ZipyApiError with status 0;
        # the caller can distinguish it from an HTTP error by `status == 0`.
        raise ZipyApiError(
            f"Transport failure: {err.reason!s}",
            status=0,
            body="",
            payload=None,
            request_url=request.url,
        ) from err


# --------------------------------------------------------------------------- #
# Pagination                                                                  #
# --------------------------------------------------------------------------- #

@dataclass
class Page:
    """A single page of a list endpoint response."""

    items: List[Dict[str, Any]]
    next_cursor: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# Client                                                                      #
# --------------------------------------------------------------------------- #

class ZipyClient:
    """Client for the Zipy AI REST API v1.

    Parameters
    ----------
    api_key : str
        Bearer token. When omitted, reads ``ZIPY_API_KEY`` from the
        environment; when that is also unset the constructor raises.
    base_url : str
        Base URL of the Zipy AI web app (no trailing slash). When omitted,
        reads ``ZIPY_BASE_URL``; when that is also unset the constructor
        raises. The SDK never assumes a hosted endpoint.
    workspace_id : str
        Optional default workspace id applied to every request that takes
        one. Endpoint methods also accept a per-call override.
    timeout_s : float
        Per-request timeout. Defaults to 30 seconds.
    transport : Transport
        Injectable transport. Defaults to the stdlib `urllib` transport.
    user_agent : str
        Optional User-Agent suffix; appended to the SDK default.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        workspace_id: Optional[str] = None,
        timeout_s: float = 30.0,
        transport: Optional[Transport] = None,
        user_agent: Optional[str] = None,
    ) -> None:
        resolved_key = api_key if api_key is not None else os.environ.get("ZIPY_API_KEY")
        if not resolved_key or not resolved_key.strip():
            raise ZipyConfigError(
                "Zipy AI API key is required. Pass `api_key=...` or set ZIPY_API_KEY."
            )
        resolved_base = base_url if base_url is not None else os.environ.get("ZIPY_BASE_URL")
        if not resolved_base or not resolved_base.strip():
            raise ZipyConfigError(
                "Zipy AI base URL is required. Pass `base_url=...` or set ZIPY_BASE_URL."
            )
        resolved_base = resolved_base.strip().rstrip("/")
        if not (resolved_base.startswith("http://") or resolved_base.startswith("https://")):
            raise ZipyConfigError(
                f"base_url must start with http:// or https:// (received {resolved_base!r})."
            )
        if timeout_s <= 0:
            raise ZipyConfigError("timeout_s must be positive.")

        self._api_key = resolved_key.strip()
        self._base_url = resolved_base
        self._default_workspace_id = workspace_id
        self._timeout_s = float(timeout_s)
        self._transport: Transport = transport if transport is not None else _default_transport
        self._user_agent = (user_agent or "").strip()

    # -- Properties --------------------------------------------------------- #

    @property
    def base_url(self) -> str:
        """The configured base URL (safe to log; contains no secret)."""
        return self._base_url

    @property
    def workspace_id(self) -> Optional[str]:
        """The default workspace id, or ``None`` when unset."""
        return self._default_workspace_id

    # -- Low-level request -------------------------------------------------- #

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Union[str, int, None]]] = None,
    ) -> Tuple[int, Any, str]:
        """Perform an HTTP request and return ``(status, payload, raw_body)``.

        Raises `ZipyApiError` on a non-2xx status. The API key is placed in
        the ``Authorization: Bearer ...`` header and never appears in the
        URL or a loggable argument.
        """
        if not path.startswith("/"):
            raise ZipyConfigError(f"path must start with '/' (received {path!r}).")
        url = self._base_url + path
        if query:
            from urllib.parse import urlencode
            filtered = {k: str(v) for k, v in query.items() if v is not None}
            if filtered:
                url = url + "?" + urlencode(filtered)

        headers: Dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "X-Zipy-Sdk": SDK_VERSION,
        }
        if self._user_agent:
            headers["User-Agent"] = f"{SDK_VERSION} {self._user_agent}"
        else:
            headers["User-Agent"] = SDK_VERSION

        body_bytes: Optional[bytes] = None
        if body is not None:
            body_bytes = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        request = TransportRequest(
            method=method,
            url=url,
            headers=headers,
            body=body_bytes,
            timeout_s=self._timeout_s,
        )
        response = self._transport(request)
        body_text = response.body.decode("utf-8", errors="replace") if response.body else ""
        content_type = ""
        for k, v in response.headers.items():
            if k.lower() == "content-type":
                content_type = v
                break
        payload: Any = None
        if body_text and "application/json" in content_type.lower():
            try:
                payload = json.loads(body_text)
            except json.JSONDecodeError:
                payload = None
        if response.status < 200 or response.status >= 300:
            raise ZipyApiError(
                f"Zipy AI API returned {response.status} for {method} {path}.",
                status=response.status,
                body=body_text,
                payload=payload,
                request_url=url,
            )
        return response.status, payload, body_text

    # -- Resources: guides -------------------------------------------------- #

    def list_guides(
        self,
        workspace_id: Optional[str] = None,
        limit: int = PAGE_SIZE_DEFAULT,
        cursor: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Page:
        """List guides in a workspace.

        Endpoint: ``GET /api/v1/guides``.
        """
        ws = self._resolve_workspace(workspace_id)
        _assert_page_size(limit)
        status_code, payload, _ = self.request(
            "GET",
            "/api/v1/guides",
            query={"workspaceId": ws, "limit": limit, "cursor": cursor, "status": status},
        )
        del status_code
        return _page_from_response(payload)

    def iterate_guides(
        self,
        workspace_id: Optional[str] = None,
        page_size: int = PAGE_SIZE_DEFAULT,
        status: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Yield every guide in a workspace, following the cursor."""
        _assert_page_size(page_size)
        cursor: Optional[str] = None
        seen_cursors: set = set()
        while True:
            page = self.list_guides(
                workspace_id=workspace_id,
                limit=page_size,
                cursor=cursor,
                status=status,
            )
            for item in page.items:
                yield item
            if not page.next_cursor:
                return
            if page.next_cursor in seen_cursors:
                # Guard against a server bug that would loop forever.
                return
            seen_cursors.add(page.next_cursor)
            cursor = page.next_cursor

    def get_guide(self, guide_id: str, workspace_id: Optional[str] = None) -> Dict[str, Any]:
        """Fetch a single guide by id.

        Endpoint: ``GET /api/v1/guides/{id}``.
        """
        ws = self._resolve_workspace(workspace_id)
        _assert_id(guide_id, "guide_id")
        _, payload, _ = self.request(
            "GET",
            f"/api/v1/guides/{guide_id}",
            query={"workspaceId": ws},
        )
        if not isinstance(payload, dict):
            raise ZipyApiError(
                "Guide response is not a JSON object.",
                status=200,
                body="",
                payload=payload,
                request_url=f"{self._base_url}/api/v1/guides/{guide_id}",
            )
        return payload

    # -- Resources: workflows ---------------------------------------------- #

    def list_workflows(
        self,
        workspace_id: Optional[str] = None,
        limit: int = PAGE_SIZE_DEFAULT,
        cursor: Optional[str] = None,
    ) -> Page:
        """List workflows in a workspace.

        Endpoint: ``GET /api/v1/workflows``.
        """
        ws = self._resolve_workspace(workspace_id)
        _assert_page_size(limit)
        _, payload, _ = self.request(
            "GET",
            "/api/v1/workflows",
            query={"workspaceId": ws, "limit": limit, "cursor": cursor},
        )
        return _page_from_response(payload)

    def iterate_workflows(
        self,
        workspace_id: Optional[str] = None,
        page_size: int = PAGE_SIZE_DEFAULT,
    ) -> Iterator[Dict[str, Any]]:
        """Yield every workflow in a workspace, following the cursor."""
        _assert_page_size(page_size)
        cursor: Optional[str] = None
        seen_cursors: set = set()
        while True:
            page = self.list_workflows(workspace_id=workspace_id, limit=page_size, cursor=cursor)
            for item in page.items:
                yield item
            if not page.next_cursor:
                return
            if page.next_cursor in seen_cursors:
                return
            seen_cursors.add(page.next_cursor)
            cursor = page.next_cursor

    def get_workflow(self, workflow_id: str, workspace_id: Optional[str] = None) -> Dict[str, Any]:
        """Fetch a single workflow by id.

        Endpoint: ``GET /api/v1/workflows/{id}``.
        """
        ws = self._resolve_workspace(workspace_id)
        _assert_id(workflow_id, "workflow_id")
        _, payload, _ = self.request(
            "GET",
            f"/api/v1/workflows/{workflow_id}",
            query={"workspaceId": ws},
        )
        if not isinstance(payload, dict):
            raise ZipyApiError(
                "Workflow response is not a JSON object.",
                status=200,
                body="",
                payload=payload,
                request_url=f"{self._base_url}/api/v1/workflows/{workflow_id}",
            )
        return payload

    # -- OpenAPI ------------------------------------------------------------ #

    def get_openapi(self) -> Dict[str, Any]:
        """Fetch the OpenAPI document.

        Endpoint: ``GET /api/v1/openapi``.
        """
        _, payload, _ = self.request("GET", "/api/v1/openapi")
        if not isinstance(payload, dict):
            raise ZipyApiError(
                "OpenAPI response is not a JSON object.",
                status=200,
                body="",
                payload=payload,
                request_url=f"{self._base_url}/api/v1/openapi",
            )
        return payload

    # -- Helpers ------------------------------------------------------------ #

    def _resolve_workspace(self, workspace_id: Optional[str]) -> str:
        ws = workspace_id if workspace_id is not None else self._default_workspace_id
        if not ws or not ws.strip():
            raise ZipyConfigError(
                "A workspace_id is required. Pass it to the method or set a default on the client."
            )
        return ws.strip()


# --------------------------------------------------------------------------- #
# Module-level helpers                                                        #
# --------------------------------------------------------------------------- #

def _assert_id(value: str, name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ZipyConfigError(f"{name} must be a non-empty string.")


def _assert_page_size(limit: int) -> None:
    if not isinstance(limit, int) or limit <= 0 or limit > PAGE_SIZE_MAX:
        raise ZipyConfigError(
            f"limit must be an integer between 1 and {PAGE_SIZE_MAX} (received {limit!r})."
        )


def _page_from_response(payload: Any) -> Page:
    if payload is None:
        return Page(items=[], next_cursor=None, raw={})
    if isinstance(payload, list):
        # Some list endpoints return a bare array. Accept it so the SDK does
        # not fail when the shape is the "no pagination" variant.
        items = [i for i in payload if isinstance(i, dict)]
        return Page(items=items, next_cursor=None, raw={"items": items})
    if not isinstance(payload, dict):
        return Page(items=[], next_cursor=None, raw={})
    raw_items = payload.get("items")
    items: List[Dict[str, Any]] = []
    if isinstance(raw_items, list):
        for item in raw_items:
            if isinstance(item, dict):
                items.append(item)
    next_cursor = payload.get("nextCursor")
    if not isinstance(next_cursor, str) or not next_cursor:
        next_cursor = None
    return Page(items=items, next_cursor=next_cursor, raw=payload)


def _now_ms() -> int:
    """Exposed for callers that want the SDK's clock reading in tests."""
    return int(time.time() * 1000)
