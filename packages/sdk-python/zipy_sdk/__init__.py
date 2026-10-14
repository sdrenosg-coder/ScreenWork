"""
Zipy AI — Python SDK (phase 21, batch 2).

A small, dependency-free client for the versioned Zipy AI REST API. It
targets Python 3.9+ and uses only the standard library (`urllib.request`,
`json`, `hmac`, `hashlib`, `uuid`, `time`) so it can be dropped into any
runtime an operator already has.

Design boundaries
-----------------
- The SDK does **not** ship a default base URL. `ZipyClient(base_url=...)`
  requires an explicit URL so a caller cannot accidentally POST production
  data at a development endpoint that happens to be listening on localhost.
- The SDK does **not** invent credentials. When a bearer token is absent
  the client sends no `Authorization` header and the server is responsible
  for returning 401. No placeholder token is ever generated.
- Webhook signature verification reproduces `packages/webhooks/src/signature.ts`
  byte for byte (HMAC-SHA256 over `f"{timestamp}.{raw_body}"`, header format
  `t=<unix>,v1=<hex>`), so a Python receiver and the TypeScript dispatcher
  agree on every delivery.
- The HTTP transport is `urllib.request` by default and injectable via the
  `transport` keyword so a customer can route through their own proxy or
  reuse a session pool. The transport contract is: given a `Request`, return
  `(status_code: int, body_text: str)`.

Public surface
--------------
- `ZipyClient` — resources: `guides`, `workflows`, `events`.
- `ZipyError` — raised for non-2xx responses, with `.status`, `.code`,
  `.body`.
- `verify_webhook_signature` — receiver-side verification helper.
- `WebhookEvent`, `Guide`, `Workflow` — light dict subclasses that preserve
  unknown keys.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import (
    Any,
    Callable,
    Dict,
    Iterable,
    Mapping,
    Optional,
    Tuple,
    Union,
)

__all__ = [
    "ZipyClient",
    "ZipyError",
    "Guide",
    "Workflow",
    "WebhookEvent",
    "verify_webhook_signature",
    "DEFAULT_MAX_SKEW_SECONDS",
    "SIGNATURE_VERSION",
    "Transport",
    "Request",
    "Response",
]

__version__ = "0.1.0"
SIGNATURE_VERSION = "v1"
DEFAULT_MAX_SKEW_SECONDS = 300


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ZipyError(Exception):
    """Raised when the Zipy AI API returns a non-2xx response.

    Attributes:
        status: HTTP status code from the response.
        code: A machine-readable error code from the response body, when the
            server supplied one; otherwise a string derived from `status`.
        body: The raw response body text, unmodified.
        request_id: The `X-Zipy-Request-Id` header value when the server
            supplied one, so a support ticket can be traced to a log entry.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: str,
        body: str,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body
        self.request_id = request_id

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return (
            f"ZipyError(status={self.status!r}, code={self.code!r}, "
            f"request_id={self.request_id!r})"
        )


# ---------------------------------------------------------------------------
# Transport port
# ---------------------------------------------------------------------------


class Request:
    """A transport-agnostic HTTP request.

    The default transport (`_urllib_transport`) turns this into a
    `urllib.request.Request`. A custom transport receives the same object.
    """

    __slots__ = ("method", "url", "headers", "body", "timeout")

    def __init__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: Optional[bytes],
        timeout: float,
    ) -> None:
        self.method = method
        self.url = url
        self.headers = dict(headers)
        self.body = body
        self.timeout = timeout


class Response:
    """A transport-agnostic HTTP response."""

    __slots__ = ("status", "body", "headers")

    def __init__(
        self,
        status: int,
        body: str,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.status = status
        self.body = body
        self.headers = dict(headers or {})


Transport = Callable[[Request], Response]


def _urllib_transport(request: Request) -> Response:
    """The default transport: `urllib.request` from the standard library.

    HTTP error statuses (4xx/5xx) are returned as a normal `Response`; a
    network failure (DNS, TCP, TLS, timeout) propagates the `URLError`
    unchanged so the caller sees the real cause. The SDK's `_call` turns
    the response into a `ZipyError` when the status is not 2xx.
    """
    data = request.body if request.body is not None else None
    req = urllib.request.Request(
        request.url,
        data=data,
        headers=request.headers,
        method=request.method,
    )
    try:
        with urllib.request.urlopen(req, timeout=request.timeout) as resp:
            body_text = resp.read().decode("utf-8", errors="replace")
            headers = {k: v for k, v in resp.headers.items()}
            return Response(status=resp.status, body=body_text, headers=headers)
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        headers = {k: v for k, v in (exc.headers or {}).items()}
        return Response(status=exc.code, body=body_text, headers=headers)


# ---------------------------------------------------------------------------
# Resource wrappers
# ---------------------------------------------------------------------------


class _Resource(dict):
    """A dict subclass that keeps unknown keys.

    The server may add fields between SDK releases; a caller that only knows
    a subset of keys should not have to upgrade the SDK to read them. The
    subclass preserves everything and offers a `.get` that behaves like a
    plain dict.
    """

    def __init__(self, payload: Mapping[str, Any]) -> None:
        super().__init__(payload)


class Guide(_Resource):
    """A published or draft guide as returned by `GET /api/v1/guides/{id}`."""


class Workflow(_Resource):
    """A workflow as returned by `GET /api/v1/workflows/{id}`."""


class WebhookEvent(_Resource):
    """A webhook envelope as posted to a receiver."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


_DEFAULT_TIMEOUT_SECONDS = 30.0
_DEFAULT_USER_AGENT = f"zipy-sdk-python/{__version__}"


class ZipyClient:
    """A minimal, synchronous client for the Zipy AI REST API.

    Usage:
        client = ZipyClient(
            base_url="https://zipy.example.com",
            token="<workspace or user API token>",
        )
        for guide in client.guides.list():
            print(guide["id"], guide.get("title"))

    Every method raises `ZipyError` on a non-2xx response and lets network
    failures (`urllib.error.URLError`) propagate.
    """

    def __init__(
        self,
        base_url: str,
        *,
        token: Optional[str] = None,
        workspace_id: Optional[str] = None,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
        user_agent: str = _DEFAULT_USER_AGENT,
        transport: Optional[Transport] = None,
        default_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("`base_url` is required (e.g. https://zipy.example.com).")
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"`base_url` must be an http(s) URL; received scheme {parsed.scheme!r}."
            )
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            # Refuse plaintext to a non-loopback host: a bearer token over
            # the wire is a credential leak. A caller that truly needs http
            # to an internal host uses a custom transport that itself adds
            # TLS termination.
            raise ValueError(
                "`base_url` must use https:// for a non-loopback host; "
                "supply a custom transport for a tunneled internal deployment."
            )
        self._base_url = base_url.rstrip("/")
        self._token = token.strip() if isinstance(token, str) and token.strip() else None
        self._workspace_id = (
            workspace_id.strip()
            if isinstance(workspace_id, str) and workspace_id.strip()
            else None
        )
        self._timeout = float(timeout)
        self._user_agent = user_agent
        self._transport: Transport = transport or _urllib_transport
        self._extra_headers: Dict[str, str] = dict(default_headers or {})

        # Sub-resources. They share the client's transport so a caller can
        # inject a fake once and have every call routed through it.
        self.guides = _GuidesResource(self)
        self.workflows = _WorkflowsResource(self)
        self.events = _EventsResource(self)

    # -- HTTP plumbing ---------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
        json_body: Optional[Any] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> Response:
        """Perform a single authenticated request.

        The path is joined onto the base URL; the query dict is URL-encoded
        preserving repeated keys. A JSON body is serialized with the SDK's
        canonical encoder (sorted keys, no ASCII escaping except control
        characters) so a caller's payload is byte-stable across retries.
        """
        if not isinstance(method, str) or method.upper() not in (
            "GET",
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
        ):
            raise ValueError(f"Unsupported HTTP method: {method!r}")
        if not isinstance(path, str) or not path.startswith("/"):
            raise ValueError("`path` must start with '/'.")
        url = self._base_url + path
        if query:
            url = url + "?" + urllib.parse.urlencode(_flatten_query(query), doseq=True)

        headers: Dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": self._user_agent,
            "X-Zipy-Client-Version": __version__,
        }
        if self._token is not None:
            headers["Authorization"] = f"Bearer {self._token}"
        if self._workspace_id is not None:
            headers["X-Zipy-Workspace"] = self._workspace_id
        headers.update(self._extra_headers)
        if extra_headers:
            headers.update(extra_headers)

        body_bytes: Optional[bytes] = None
        if json_body is not None:
            body_bytes = json.dumps(
                json_body,
                separators=(",", ":"),
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
            headers.setdefault("Content-Type", "application/json; charset=utf-8")
            headers["Content-Length"] = str(len(body_bytes))

        req = Request(
            method=method.upper(),
            url=url,
            headers=headers,
            body=body_bytes,
            timeout=self._timeout,
        )
        response = self._transport(req)
        if response.status < 200 or response.status >= 300:
            raise _error_from_response(response)
        return response

    # -- Convenience wrappers --------------------------------------------

    def get_json(
        self,
        path: str,
        *,
        query: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        return _decode_json(self.request("GET", path, query=query).body)

    def post_json(
        self,
        path: str,
        *,
        json_body: Optional[Any] = None,
        query: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        return _decode_json(self.request("POST", path, query=query, json_body=json_body).body)

    def new_event_id(self) -> str:
        """A stable id a caller can use as the `event_id` when emitting an
        internal event and later correlating it with the webhook delivery."""
        return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Sub-resources
# ---------------------------------------------------------------------------


class _GuidesResource:
    """`/api/v1/guides`."""

    def __init__(self, client: ZipyClient) -> None:
        self._c = client

    def list(
        self,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
    ) -> Tuple[Guide, ...]:
        query: Dict[str, Any] = {}
        if status is not None:
            query["status"] = status
        if limit is not None:
            query["limit"] = int(limit)
        if cursor is not None:
            query["cursor"] = cursor
        if tags is not None:
            query["tag"] = list(tags)
        payload = self._c.get_json("/api/v1/guides", query=query)
        items = _extract_items(payload)
        return tuple(Guide(i) for i in items if isinstance(i, Mapping))

    def get(self, guide_id: str) -> Guide:
        payload = self._c.get_json(f"/api/v1/guides/{_url_seg(guide_id)}")
        if not isinstance(payload, Mapping):
            raise ZipyError(
                "Expected a JSON object for a single guide.",
                status=200,
                code="invalid-response",
                body=json.dumps(payload),
            )
        return Guide(payload)

    def export(
        self,
        guide_id: str,
        fmt: str,
        *,
        options: Optional[Mapping[str, Any]] = None,
    ) -> bytes:
        """Export a guide and return the raw bytes of the rendered file.

        `fmt` is one of `"pdf"`, `"html"`, `"markdown"`, `"docx"`, `"zip"`.
        The bytes are not inspected; the caller writes them to disk or
        streams them to the client with the content type the server
        supplied in `Content-Type`.
        """
        body: Dict[str, Any] = {"format": fmt}
        if options:
            body["options"] = dict(options)
        # The export endpoint is documented to return a binary body; a 4xx
        # is still JSON, so a caller that receives a ZipyError sees a
        # readable message.
        response = self._c.request(
            "POST",
            f"/api/v1/guides/{_url_seg(guide_id)}/export",
            json_body=body,
            extra_headers={"Accept": "*/*"},
        )
        return response.body.encode("utf-8", errors="surrogateescape")


class _WorkflowsResource:
    """`/api/v1/workflows`."""

    def __init__(self, client: ZipyClient) -> None:
        self._c = client

    def list(
        self,
        *,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Tuple[Workflow, ...]:
        query: Dict[str, Any] = {}
        if status is not None:
            query["status"] = status
        if limit is not None:
            query["limit"] = int(limit)
        if cursor is not None:
            query["cursor"] = cursor
        payload = self._c.get_json("/api/v1/workflows", query=query)
        items = _extract_items(payload)
        return tuple(Workflow(i) for i in items if isinstance(i, Mapping))

    def get(self, workflow_id: str) -> Workflow:
        payload = self._c.get_json(f"/api/v1/workflows/{_url_seg(workflow_id)}")
        if not isinstance(payload, Mapping):
            raise ZipyError(
                "Expected a JSON object for a single workflow.",
                status=200,
                code="invalid-response",
                body=json.dumps(payload),
            )
        return Workflow(payload)

    def synthesize(
        self,
        workflow_id: str,
        *,
        goal: str,
        source_ids: Optional[Iterable[str]] = None,
    ) -> Mapping[str, Any]:
        body: Dict[str, Any] = {"goal": goal}
        if source_ids is not None:
            body["sourceIds"] = list(source_ids)
        payload = self._c.post_json(
            f"/api/v1/workflows/{_url_seg(workflow_id)}/synthesize",
            json_body=body,
        )
        return payload if isinstance(payload, Mapping) else {"data": payload}


class _EventsResource:
    """`/api/v1/events` — read view over the workspace's audit/event stream."""

    def __init__(self, client: ZipyClient) -> None:
        self._c = client

    def list(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        kind: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Tuple[WebhookEvent, ...]:
        query: Dict[str, Any] = {}
        if since is not None:
            query["since"] = since
        if until is not None:
            query["until"] = until
        if kind is not None:
            query["kind"] = kind
        if limit is not None:
            query["limit"] = int(limit)
        payload = self._c.get_json("/api/v1/events", query=query)
        items = _extract_items(payload)
        return tuple(WebhookEvent(i) for i in items if isinstance(i, Mapping))


# ---------------------------------------------------------------------------
# Webhook verification
# ---------------------------------------------------------------------------


def verify_webhook_signature(
    *,
    body: Union[str, bytes],
    header: str,
    secret: str,
    now_seconds: Optional[int] = None,
    max_skew_seconds: int = DEFAULT_MAX_SKEW_SECONDS,
) -> Tuple[bool, Optional[str]]:
    """Verify a `Zipy-Signature` header against the raw request body.

    Returns `(ok, reason)` where `reason` is `None` when `ok` is True. The
    reasons mirror the TypeScript verifier: `"malformed-header"`,
    `"timestamp-out-of-range"`, `"signature-mismatch"`.

    `body` **must** be the exact bytes the receiver read from the socket;
    re-serializing JSON would change the hash. `now_seconds` defaults to
    the current time; a caller behind a skewed clock supplies an
    NTP-corrected value.
    """
    if not isinstance(secret, str) or secret == "":
        return False, "signature-mismatch"
    parsed = _parse_signature_header(header)
    if parsed is None:
        return False, "malformed-header"
    timestamp, received_hex = parsed
    if now_seconds is None:
        now_seconds = int(time.time())
    skew = abs(int(now_seconds) - timestamp)
    if skew > max_skew_seconds:
        return False, "timestamp-out-of-range"

    body_bytes = body.encode("utf-8") if isinstance(body, str) else bytes(body)
    message = str(timestamp).encode("ascii") + b"." + body_bytes
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if len(expected) != len(received_hex):
        return False, "signature-mismatch"
    if not hmac.compare_digest(expected, received_hex):
        return False, "signature-mismatch"
    return True, None


def _parse_signature_header(header: str) -> Optional[Tuple[int, str]]:
    if not isinstance(header, str) or header == "":
        return None
    timestamp: Optional[int] = None
    signature_hex: Optional[str] = None
    for piece in header.split(","):
        trimmed = piece.strip()
        if not trimmed:
            continue
        eq = trimmed.find("=")
        if eq <= 0:
            return None
        key = trimmed[:eq]
        value = trimmed[eq + 1:]
        if key == "t":
            if not value.isdigit():
                return None
            timestamp = int(value)
        elif key == SIGNATURE_VERSION:
            if not _is_hex(value):
                return None
            signature_hex = value.lower()
    if timestamp is None or signature_hex is None:
        return None
    return timestamp, signature_hex


def _is_hex(value: str) -> bool:
    if not value:
        return False
    for ch in value:
        if ch not in "0123456789abcdefABCDEF":
            return False
    return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _flatten_query(query: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalise a query dict for `urlencode(doseq=True)`.

    Tuples and lists become repeated keys; `None` values are dropped; a
    boolean becomes `"true"`/`"false"` so the server sees the same shape a
    TypeScript client would emit.
    """
    out: Dict[str, Any] = {}
    for key, value in query.items():
        if value is None:
            continue
        if isinstance(value, bool):
            out[key] = "true" if value else "false"
        elif isinstance(value, (list, tuple, set, frozenset)):
            out[key] = list(value)
        else:
            out[key] = value
    return out


def _extract_items(payload: Any) -> Iterable[Any]:
    """Accept either a bare array or a `{items: [...]}` / `{data: [...]}` wrapper.

    The v1 API documents a `{items, nextCursor}` envelope; older deployments
    that still return a bare array are also handled.
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, Mapping):
        items = payload.get("items")
        if isinstance(items, list):
            return items
        data = payload.get("data")
        if isinstance(data, list):
            return data
    return ()


def _decode_json(body_text: str) -> Any:
    if body_text is None or body_text == "":
        return None
    try:
        return json.loads(body_text)
    except json.JSONDecodeError as exc:
        raise ZipyError(
            f"Response body was not valid JSON: {exc.msg}.",
            status=200,
            code="invalid-response",
            body=body_text,
        ) from exc


def _url_seg(segment: str) -> str:
    if not isinstance(segment, str) or not segment:
        raise ValueError("Path segment must be a non-empty string.")
    return urllib.parse.quote(segment, safe="")


def _error_from_response(response: Response) -> ZipyError:
    code: str = f"http-{response.status}"
    message = f"Zipy AI API returned HTTP {response.status}."
    parsed: Any = None
    if response.body:
        try:
            parsed = json.loads(response.body)
        except json.JSONDecodeError:
            parsed = None
    if isinstance(parsed, Mapping):
        # The v1 API documented error shape is `{error: {code, message}}`.
        err = parsed.get("error")
        if isinstance(err, Mapping):
            c = err.get("code")
            m = err.get("message")
            if isinstance(c, str) and c:
                code = c
            if isinstance(m, str) and m:
                message = m
        else:
            # Fallback shape: top-level `{code, message}`.
            c = parsed.get("code")
            m = parsed.get("message")
            if isinstance(c, str) and c:
                code = c
            if isinstance(m, str) and m:
                message = m
    request_id = response.headers.get("X-Zipy-Request-Id") if response.headers else None
    return ZipyError(
        message,
        status=response.status,
        code=code,
        body=response.body,
        request_id=request_id,
    )
